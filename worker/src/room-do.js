/**
 * @fileoverview ルーム用 Durable Object
 *
 * 1ルーム＝1インスタンス。座席・対局状態・チャット・観戦者・CPU思考と、
 * そのルームに繋がっている全WebSocketを保持する。
 *
 * Node版（server/index.js）ではこれらをプロセスのメモリ上のMapで持っていたが、
 * Workers はステートレスなため Durable Object に置き換えている。
 * イベント名とペイロードは Socket.io 版と同一なので、画面側の変更は最小で済む。
 *
 * @module room-do
 */

import { DurableObject } from "cloudflare:workers";

import {
  createNewGameState,
  createWaitingState,
  normalizeState,
  applyAction,
} from "./game.js";
import { createCpuSearch, stepCpuSearch, resolveCpuLevel, positionKey } from "./ai.js";
import { encodeEvent, encodeResponse, decodeMessage, PING, PONG } from "./protocol.js";

/** CPUプレイヤーを表す擬似ユーザーID（D1には作らない） */
const CPU_USER_ID = -1;

/** CPUプレイヤーのログインID（画面側がCPU席の判定に使う） */
const CPU_LOGIN_ID = "cpu";

/** CPUプレイヤーの表示名 */
const CPU_NICKNAME = "CPU";

/** CPUが着手するまでの遅延（人間らしく見せるため） */
const CPU_DELAY_MS = 350;

/**
 * 思考を分割して続ける際の、次のアラームまでの間隔。
 *
 * 無料プランは 1リクエストあたり CPU 10ms しか使えないため、深く読むには
 * 探索を複数のアラームに分けるしかない。1回あたりのCPU時間は
 * nodeBudget で頭打ちになり、maxTicks 回まで続きを読む。
 */
const CPU_TICK_MS = 50;

/** チャット履歴の保持時間（最終発言から30分） */
const CHAT_TTL_MS = 30 * 60 * 1000;

/** チャット1件あたりの最大文字数 */
const CHAT_MAX_LENGTH = 300;

export class RoomDurableObject extends DurableObject {
  /**
   * @param {DurableObjectState} ctx - Durable Object の状態
   * @param {Object} env - 環境変数とバインディング
   */
  constructor(ctx, env) {
    super(ctx, env);

    /** @type {Object} ルームの永続状態 */
    this.state = null;

    // CPU探索の置換表。1手ぶんのアラームをまたいで使い回すだけのキャッシュなので
    // 永続化はしない（消えても探索し直せるだけで、正しさには影響しない）。
    /** @type {Map|null} */
    this.cpuTable = null;

    // 起動時（ハイバネーションからの復帰を含む）に状態を復元する。
    // blockConcurrencyWhile の間はイベントが配送されないため、
    // ハンドラが未初期化の状態を触ることはない。
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get("state");
      this.state = stored || this.createInitialState();
    });

    // ping/pong は Durable Object を起こさずに自動応答させる
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * 初期状態を作ります。
   * @returns {Object} ルームの初期状態
   */
  createInitialState() {
    return {
      roomId: null,
      name: "",
      status: "waiting",
      seats: { black: null, white: null },
      game: createWaitingState(),
      chat: [],
      chatIdCounter: 1,
      chatExpiresAt: null,
      cpu: null,
      cpuMoveAt: null,
      cpuSearch: null,
    };
  }

  /**
   * 現在の状態を永続化します。
   * @returns {Promise<void>}
   */
  save() {
    return this.ctx.storage.put("state", this.state);
  }

  // ===========================================================================
  // ルーム / 座席（Node版 server/db.js 相当）
  // ===========================================================================

  /**
   * 画面に返すルームオブジェクトを組み立てます。
   * @returns {Object} ルーム情報
   */
  getRoom() {
    return {
      id: this.state.roomId,
      name: this.state.name,
      status: this.state.status,
      seats: this.state.seats,
    };
  }

  /**
   * 座席の埋まり具合からルームのステータスを更新します。
   * @returns {string} 更新後のステータス
   */
  updateRoomStatus() {
    const { black, white } = this.state.seats;
    // 両席が埋まっていれば対局できる状態、片方でも空いていれば待機中
    if (black && white) {
      this.state.status = "playing";
    } else {
      this.state.status = "waiting";
    }
    return this.state.status;
  }

  /**
   * ユーザーを座席に着席させます。
   * @param {'black'|'white'} color - 座席の色
   * @param {number} userId - ユーザーID
   * @param {Object} userInfo - ユーザー情報（loginId, nickname）
   * @returns {Object} 結果オブジェクト
   */
  assignSeat(color, userId, userInfo) {
    const seats = this.state.seats;

    // 席の色として想定していない値は受け付けない
    if (color !== "black" && color !== "white") {
      return { ok: false, reason: "invalid_seat" };
    }

    // 他のユーザーが座っている場合は拒否
    if (seats[color] && seats[color].userId !== userId) {
      return { ok: false, reason: "taken" };
    }

    // 同じユーザーが反対側の席に座っている場合は拒否（1人で両席は取れない）
    let otherColor = "black";
    if (color === "black") {
      otherColor = "white";
    }
    if (seats[otherColor] && seats[otherColor].userId === userId) {
      return { ok: false, reason: "already_seated" };
    }

    seats[color] = {
      userId,
      loginId: userInfo.loginId,
      nickname: userInfo.nickname,
    };

    return { ok: true, status: this.updateRoomStatus() };
  }

  /**
   * ユーザーを座席から離席させます。
   * @param {'black'|'white'} color - 座席の色
   * @param {number} userId - ユーザーID
   * @returns {Object} 結果オブジェクト
   */
  releaseSeat(color, userId) {
    const seats = this.state.seats;

    // 席の色として想定していない値は受け付けない
    if (color !== "black" && color !== "white") {
      return { ok: false, reason: "invalid_seat" };
    }
    // 自分が座っている席以外は解放できない
    if (!seats[color] || seats[color].userId !== userId) {
      return { ok: false, reason: "not_owner" };
    }

    const statusBefore = this.state.status;
    seats[color] = null;
    const statusAfter = this.updateRoomStatus();

    return { ok: true, statusBefore, statusAfter };
  }

  /**
   * 指定ユーザーが座っている座席をすべて解放します。
   * @param {number} userId - ユーザーID
   * @returns {Array<Object>} 解放した座席情報
   */
  releaseSeatsByUser(userId) {
    const released = [];

    // 黒・白の両席を確認し、そのユーザーが座っている席をすべて空ける
    for (const color of ["black", "white"]) {
      const seat = this.state.seats[color];
      if (seat && seat.userId === userId) {
        const statusBefore = this.state.status;
        this.state.seats[color] = null;
        const statusAfter = this.updateRoomStatus();
        released.push({ color, statusBefore, statusAfter });
      }
    }

    return released;
  }

  // ===========================================================================
  // 対局状態（Node版 server/index.js 相当）
  // ===========================================================================

  /**
   * CPUが着席していれば、その席を常に準備完了として扱います。
   * @param {Object} game - ゲーム状態
   * @returns {Object} 更新後のゲーム状態
   */
  applyCpuReady(game) {
    const cpu = this.state.cpu;
    // CPUが着席していなければ何も変えない
    if (!cpu) {
      return game;
    }
    // 対局中の準備状態は結果表示に使うため書き換えない
    if (game.status === "playing") {
      return game;
    }

    // CPUの席は常に準備完了として扱う
    const flags = this.readyFlags(game);
    flags[cpu.color] = true;
    game.ready = flags;
    return game;
  }

  /**
   * ゲーム状態から準備完了フラグを取り出します。
   * @param {Object} game - ゲーム状態
   * @returns {{black: boolean, white: boolean}} 準備完了フラグ
   */
  readyFlags(game) {
    // ready を持たない状態でも扱えるよう、両者未準備を既定値にする
    if (!game || !game.ready) {
      return { black: false, white: false };
    }
    return {
      black: Boolean(game.ready.black),
      white: Boolean(game.ready.white),
    };
  }

  /**
   * 現在のゲーム状態を取得します（CPUの準備完了を反映済み）。
   * @returns {Object} ゲーム状態
   */
  getRoomGame() {
    // 保存された対局が無ければ待機状態から始める
    let game;
    if (this.state.game) {
      game = normalizeState(this.state.game);
    } else {
      game = createWaitingState();
    }
    return this.applyCpuReady(game);
  }

  /**
   * ゲーム状態を保存し、ルーム内の全員に配信します。
   * @param {Object} game - ゲーム状態
   * @returns {Object} 保存されたゲーム状態
   */
  broadcastGame(game) {
    const next = this.applyCpuReady(game);
    this.state.game = next;
    this.broadcast("game:state", { roomId: this.state.roomId, game: next });
    return next;
  }

  /**
   * 両者が準備完了していれば対局を開始します。
   * @returns {Object|null} 開始したゲーム状態、変化なしならnull
   */
  startGameIfReady() {
    // 両席が埋まっていない間は開始できない
    if (this.state.status !== "playing") {
      return null;
    }

    const game = this.getRoomGame();

    // 既に対局中
    if (game.status === "playing") {
      return game;
    }

    // 両者が準備完了していれば新しい対局を開始する
    const ready = this.readyFlags(game);
    if (ready.black && ready.white) {
      return this.broadcastGame(createNewGameState());
    }

    return game;
  }

  /**
   * ユーザーが座っている席の色を返します。
   * @param {number} userId - ユーザーID
   * @returns {'black'|'white'|null} 席の色
   */
  getPlayerColor(userId) {
    const seats = this.state.seats;
    // 黒・白のどちらの席にそのユーザーが座っているかを調べる
    if (seats.black && seats.black.userId === userId) {
      return "black";
    }
    if (seats.white && seats.white.userId === userId) {
      return "white";
    }
    return null;
  }

  /**
   * CPUが座っている席の色を返します。
   * @returns {'black'|'white'|null} 席の色
   */
  getCpuSeatColor() {
    const seats = this.state.seats;
    // CPUの擬似ユーザーIDが入っている席を探す
    if (seats.black && seats.black.userId === CPU_USER_ID) {
      return "black";
    }
    if (seats.white && seats.white.userId === CPU_USER_ID) {
      return "white";
    }
    return null;
  }

  /**
   * プレイヤーの準備完了状態を設定します。
   * @param {'black'|'white'} color - プレイヤーの色
   * @param {boolean} value - 準備完了かどうか
   * @returns {Object} 結果オブジェクト
   */
  setReady(color, value) {
    const game = this.getRoomGame();

    // 対局中は準備状態を変更できない
    if (game.status === "playing") {
      return { ok: false, error: "game_in_progress" };
    }

    // 指定された席の準備状態だけを書き換える
    const flags = this.readyFlags(game);
    flags[color] = Boolean(value);
    game.ready = flags;

    // 両席が埋まっていて両者とも準備完了なら、この操作で対局を開始する
    if (this.state.status === "playing" && game.ready.black && game.ready.white) {
      const next = this.broadcastGame(createNewGameState());
      return { ok: true, game: next, started: true };
    }

    return { ok: true, game: this.broadcastGame(game) };
  }

  /**
   * 対局中の離脱（不戦敗）を処理します。
   *
   * Node版で見つかった不具合の修正をそのまま持ち込んでいる:
   * CPU戦から人間が退出すると両席が空になり勝者が決まらないため、
   * 対局を待機状態へ戻さないとルームが二度と使えなくなる。
   * Durable Object では状態が永続化されるので、この修正が無いと復旧不能になる。
   *
   * @param {number} leaverUserId - 離脱したユーザーのID
   */
  handleForfeit(leaverUserId) {
    // 残っている「人間の」プレイヤーを勝者とする
    // （離席した本人と、道連れで離席済みのCPUは勝者になれない）
    let winnerColor = null;
    // 両席を確認し、離席者でもCPUでもないプレイヤーが残っていれば勝者にする
    for (const color of ["black", "white"]) {
      const seat = this.state.seats[color];
      if (seat && seat.userId !== leaverUserId && seat.userId !== CPU_USER_ID) {
        winnerColor = color;
      }
    }

    const game = this.getRoomGame();
    // 対局中に離脱された場合のみ、対局の後始末をする
    if (game.status === "playing") {
      // 勝者が決まっていれば不戦勝、決まっていなければ対局を破棄する
      if (winnerColor) {
        game.status = "finished";
        game.winner = winnerColor;
        game.result = "forfeit";
        game.ready = { black: false, white: false };
        this.broadcastGame(game);
      } else {
        // 対戦相手が残っていないので対局を破棄して待機状態へ戻す
        this.broadcastGame(createWaitingState());
      }
    }

    this.broadcast("room:forfeit", {
      roomId: this.state.roomId,
      winnerColor,
      leaverUserId,
    });
  }

  /**
   * ユーザーの座席を解放し、必要なら不戦敗処理を行います。
   * @param {number} userId - ユーザーID
   * @returns {boolean} 何か解放したらtrue
   */
  releaseUserSeats(userId) {
    const released = this.releaseSeatsByUser(userId);
    // 座っていなかった（観戦者だった）場合は何もしない
    if (released.length === 0) {
      return false;
    }

    // 人が離席したらCPUも一緒に離席させる
    const cpuColor = this.getCpuSeatColor();
    if (cpuColor) {
      this.releaseSeat(cpuColor, CPU_USER_ID);
      this.state.cpu = null;
      this.state.cpuMoveAt = null;
    }

    const wasPlaying = released.some((seat) => seat.statusBefore === "playing");

    let game = this.getRoomGame();
    // 対局が始まっていなかった場合は準備状態だけ初期化する
    if (!wasPlaying && game.status !== "playing") {
      game.ready = { black: false, white: false };
      this.state.game = game;
    }

    // 対局中の離脱は不戦敗として処理する
    if (wasPlaying) {
      this.handleForfeit(userId);
    }

    game = this.getRoomGame();
    this.broadcast("room:state", { room: this.getRoom(), game });
    return true;
  }

  // ===========================================================================
  // CPU思考
  // ===========================================================================

  /**
   * CPUの手番なら、少し遅らせて着手するようアラームを仕掛けます。
   */
  scheduleCpuTurn() {
    const cpu = this.state.cpu;
    // CPUが着席していなければ思考の予定を消す
    if (!cpu) {
      this.state.cpuMoveAt = null;
      this.state.cpuSearch = null;
      return;
    }

    const game = this.getRoomGame();
    // CPUの手番でなければ思考の予定を消す
    if (game.status !== "playing" || game.turn !== cpu.color) {
      this.state.cpuMoveAt = null;
      this.state.cpuSearch = null;
      return;
    }

    // 局面が変わったので、前の手番の途中結果は使わない
    this.state.cpuSearch = null;
    this.state.cpuMoveAt = Date.now() + CPU_DELAY_MS;
  }

  /**
   * CPUの手を1手だけ指します。
   *
   * 1回のアラームで1手だけ処理し、まだCPUの手番なら次のアラームを仕掛ける。
   * こうすることで1リクエストあたりのCPU時間を短く保てる
   * （無料プランは10ms/リクエスト）。
   */
  runCpuTurn() {
    const cpu = this.state.cpu;
    // CPUが着席していなければ指す手は無い
    if (!cpu) {
      return;
    }

    const game = this.getRoomGame();
    // CPUの手番でなくなっていたら思考をやめる
    if (game.status !== "playing" || game.turn !== cpu.color) {
      this.state.cpuMoveAt = null;
      this.state.cpuSearch = null;
      return;
    }

    // 局面の指紋。途中結果が別の局面のものなら捨てる。
    const signature = positionKey(game);
    let search = this.state.cpuSearch;
    if (!search || search.signature !== signature) {
      search = createCpuSearch(signature);
      this.cpuTable = new Map();
    }
    if (!this.cpuTable) {
      // ハイバネーションから復帰した直後など。置換表だけ作り直せばよい
      this.cpuTable = new Map();
    }

    const step = stepCpuSearch(game, cpu.color, search, {
      maxDepth: cpu.depth,
      nodeBudget: cpu.nodeBudget,
      table: this.cpuTable,
    });

    // まだ読み残しがあり、回数の上限にも達していないなら続きを次のアラームで読む。
    // 1回あたりのCPU時間は nodeBudget で頭打ちになっている。
    const finished = step.done || search.ticks >= cpu.maxTicks;
    if (!finished && step.action) {
      this.state.cpuSearch = search;
      this.state.cpuMoveAt = Date.now() + CPU_TICK_MS;
      return;
    }

    this.state.cpuSearch = null;
    this.cpuTable = null;

    const action = step.action;
    // 指す手が見つからなかった場合は何もしない
    if (!action) {
      this.state.cpuMoveAt = null;
      return;
    }

    // 探索で選ばれた手を実際の対局へ反映する
    const result = applyAction(game, action);
    // ルール上成立しない手だった場合は着手しない
    if (!result.ok) {
      this.state.cpuMoveAt = null;
      return;
    }

    // 終局したら次の対局に備えて準備状態を戻す
    if (result.state.status === "finished") {
      result.state.ready = { black: false, white: false };
    }

    const next = this.broadcastGame(result.state);
    this.broadcast("room:state", { room: this.getRoom(), game: next });

    // 相手がパスして再びCPUの手番になっている場合に備えて仕掛け直す
    this.scheduleCpuTurn();
  }

  // ===========================================================================
  // チャット
  // ===========================================================================

  /**
   * チャットメッセージを追加します。
   * @param {number} userId - 発言者のユーザーID
   * @param {string} message - 本文
   * @param {Object} userInfo - ユーザー情報
   * @returns {Object} 追加されたメッセージ
   */
  addChatMessage(userId, message, userInfo) {
    const now = new Date();
    const entry = {
      id: this.state.chatIdCounter++,
      room_id: this.state.roomId,
      user_id: userId,
      message,
      created_at: now.toISOString(),
      loginId: userInfo.loginId,
      nickname: userInfo.nickname,
    };

    this.state.chat.push(entry);
    this.state.chatExpiresAt = now.getTime() + CHAT_TTL_MS;
    return entry;
  }

  /**
   * 期限切れのチャットを削除します。
   * @returns {boolean} 削除したらtrue
   */
  cleanupExpiredChat() {
    const expiresAt = this.state.chatExpiresAt;
    // 期限が未設定、またはまだ来ていなければ削除しない
    if (!expiresAt || expiresAt > Date.now()) {
      return false;
    }

    this.state.chat = [];
    this.state.chatExpiresAt = null;
    this.broadcast("chat:cleared", { roomId: this.state.roomId });
    return true;
  }

  // ===========================================================================
  // 配信 / アラーム
  // ===========================================================================

  /**
   * 接続中の全クライアントへイベントを配信します。
   * @param {string} event - イベント名
   * @param {*} payload - ペイロード
   */
  broadcast(event, payload) {
    const message = encodeEvent(event, payload);
    // このルームに繋がっている全ソケットへ同じメッセージを送る
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // 送信できないソケットは close 側で処理される
      }
    }
  }

  /**
   * 観戦者を含む現在の接続数を返します。
   *
   * 切断処理(webSocketClose)の最中は、閉じたソケットもまだ
   * getWebSockets() に含まれている。そのため切断時は自分自身を
   * exclude に渡して数えないようにする。
   *
   * @param {WebSocket} [exclude=null] - 数えないソケット
   * @returns {number} 接続数
   */
  presence(exclude = null) {
    const sockets = this.ctx.getWebSockets();
    // 除外指定が無ければ接続数をそのまま返せる
    if (!exclude) {
      return sockets.length;
    }
    let count = 0;
    // 除外対象のソケットだけを数えずに集計する
    for (const ws of sockets) {
      if (ws !== exclude) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 同じユーザーの別接続が残っているか調べます（複数タブ対策）。
   * @param {number} userId - ユーザーID
   * @param {WebSocket} exclude - 判定から除外するソケット
   * @returns {boolean} 他に接続があればtrue
   */
  hasOtherSocket(userId, exclude) {
    // 判定対象以外の接続を走査し、同じユーザーのものがあるか調べる
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) {
        continue;
      }
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.userId === userId) {
        return true;
      }
    }
    return false;
  }

  /**
   * CPU着手とチャット期限のうち、早い方にアラームを合わせます。
   * @returns {Promise<void>}
   */
  async scheduleAlarm() {
    const candidates = [this.state.cpuMoveAt, this.state.chatExpiresAt].filter(
      (value) => typeof value === "number" && value > 0
    );

    // 予定が1つも無ければアラームは不要
    if (candidates.length === 0) {
      return;
    }

    const next = Math.min(...candidates);
    const current = await this.ctx.storage.getAlarm();
    // 既存の予定より早い場合だけ仕掛け直す
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * アラームハンドラ。CPU着手とチャット期限切れの両方を処理します。
   * @returns {Promise<void>}
   */
  async alarm() {
    const now = Date.now();

    // CPUの着手予定時刻を過ぎていれば1手ぶん思考を進める
    if (this.state.cpuMoveAt && this.state.cpuMoveAt <= now) {
      this.state.cpuMoveAt = null;
      this.runCpuTurn();
    }

    this.cleanupExpiredChat();

    await this.save();
    await this.scheduleAlarm();
    await this.notifyLobby();
  }

  /**
   * ロビーへルームの最新サマリを通知します。
   * @returns {Promise<void>}
   */
  async notifyLobby(exclude = null) {
    // ルームIDが未確定の間は通知する内容が無い
    if (this.state.roomId === null) {
      return;
    }

    const id = this.env.LOBBY.idFromName("lobby");
    const stub = this.env.LOBBY.get(id);

    try {
      await stub.fetch("https://lobby/room-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.state.roomId,
          name: this.state.name,
          status: this.state.status,
          seats: this.state.seats,
          presence: this.presence(exclude),
        }),
      });
    } catch {
      // ロビー通知の失敗は対局を止める理由にはならない
    }
  }

  // ===========================================================================
  // HTTP / WebSocket 入口
  // ===========================================================================

  /**
   * Worker からの内部リクエストを処理します。
   * @param {Request} request - リクエスト
   * @returns {Promise<Response>} レスポンス
   */
  async fetch(request) {
    const url = new URL(request.url);

    // ルームIDと名前は初回アクセス時に確定させる
    const roomId = Number(url.searchParams.get("roomId"));
    // 未設定、または別のIDで来た初回だけルーム情報を確定させる
    if (Number.isFinite(roomId) && roomId > 0 && this.state.roomId !== roomId) {
      this.state.roomId = roomId;
      this.state.name = `ルーム ${roomId}`;
      await this.save();
    }

    // --- 現在の状態のスナップショット（GET /api/rooms/:id 用） ---
    if (url.pathname === "/snapshot") {
      this.cleanupExpiredChat();
      return Response.json({
        room: this.getRoom(),
        chat: this.state.chat,
        game: this.getRoomGame(),
      });
    }

    // --- WebSocket 接続 ---
    // Upgrade ヘッダが無いリクエストはWebSocketとして扱えない
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const user = {
      userId: Number(url.searchParams.get("userId")),
      loginId: url.searchParams.get("loginId") || "",
      nickname: url.searchParams.get("nickname") || null,
    };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(user);

    this.broadcast("room:presence", {
      roomId: this.state.roomId,
      count: this.presence(),
    });
    await this.notifyLobby();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * クライアントからのメッセージを処理します。
   * @param {WebSocket} ws - 送信元のソケット
   * @param {string} raw - 受信データ
   * @returns {Promise<void>}
   */
  async webSocketMessage(ws, raw) {
    const message = decodeMessage(raw);
    // ack要求以外のメッセージはこのルームでは扱わない
    if (!message || message.t !== "req") {
      return;
    }

    const user = ws.deserializeAttachment();
    // 接続時に紐づけたユーザー情報が無い接続は処理できない
    if (!user) {
      return;
    }

    const respond = (payload) => {
      // ack不要（IDなし）の要求には応答を返さない
      if (message.id !== undefined && message.id !== null) {
        try {
          ws.send(encodeResponse(message.id, payload));
        } catch {
          // 送信失敗は close 側で処理される
        }
      }
    };

    try {
      // イベントごとの処理を実行する
      await this.handleEvent(ws, user, message.event, message.payload || {}, respond);
    } catch (error) {
      console.error("room event error:", message.event, error);
      respond({ ok: false, error: "internal_error" });
    }

    await this.save();
    await this.scheduleAlarm();
    await this.notifyLobby();
  }

  /**
   * イベント名ごとの処理を振り分けます。
   * イベント名・ペイロード・エラーコードは Socket.io 版と同一。
   *
   * @param {WebSocket} ws - 送信元のソケット
   * @param {Object} user - 接続ユーザー（userId, loginId, nickname）
   * @param {string} event - イベント名
   * @param {Object} payload - ペイロード
   * @param {Function} respond - ack応答用の関数
   * @returns {Promise<void>}
   */
  async handleEvent(ws, user, event, payload, respond) {
    const userId = user.userId;
    const userInfo = { loginId: user.loginId, nickname: user.nickname };

    // イベント名ごとに処理を振り分ける
    switch (event) {
      // ---------------------------------------------------------------------
      case "room:join": {
        this.cleanupExpiredChat();
        const game = this.startGameIfReady() || this.getRoomGame();
        respond({
          ok: true,
          state: { room: this.getRoom(), chat: this.state.chat, game },
        });
        this.broadcast("room:presence", {
          roomId: this.state.roomId,
          count: this.presence(),
        });
        return;
      }

      // ---------------------------------------------------------------------
      case "room:leave": {
        this.releaseUserSeats(userId);
        respond({ ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      case "seat:take": {
        const color = payload.color;
        // 席の色として想定していない値は受け付けない
        if (color !== "black" && color !== "white") {
          respond({ ok: false, error: "invalid_request" });
          return;
        }

        const result = this.assignSeat(color, userId, userInfo);
        // 着席できなかった場合は理由をそのまま返す
        if (!result.ok) {
          respond({ ok: false, error: result.reason });
          return;
        }

        // 着席時はその席の準備状態をリセット（対局中は書き換えない）
        const game = this.getRoomGame();
        if (game.status !== "playing") {
          const flags = this.readyFlags(game);
          flags[color] = false;
          game.ready = flags;
          this.state.game = game;
        }

        const next = this.startGameIfReady() || this.getRoomGame();
        this.broadcast("room:state", { room: this.getRoom(), game: next });
        respond({ ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      case "seat:leave": {
        const color = payload.color;
        // 席の色として想定していない値は受け付けない
        if (color !== "black" && color !== "white") {
          respond({ ok: false, error: "invalid_request" });
          return;
        }

        const result = this.releaseSeat(color, userId);
        // 離席できなかった場合は理由をそのまま返す
        if (!result.ok) {
          respond({ ok: false, error: result.reason });
          return;
        }

        // 人が離席したらCPUも一緒に離席させる
        const cpuColor = this.getCpuSeatColor();
        if (cpuColor) {
          this.releaseSeat(cpuColor, CPU_USER_ID);
          this.state.cpu = null;
          this.state.cpuMoveAt = null;
        }

        let game = this.getRoomGame();
        // 対局が始まっていなかった場合は準備状態だけ初期化する
        if (result.statusBefore !== "playing" && game.status !== "playing") {
          game.ready = { black: false, white: false };
          this.state.game = game;
        }

        // 対局中の離席は不戦敗として処理する
        if (result.statusBefore === "playing") {
          this.handleForfeit(userId);
        }

        game = this.startGameIfReady() || this.getRoomGame();
        this.broadcast("room:state", { room: this.getRoom(), game });
        respond({ ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      case "cpu:configure": {
        const game = this.getRoomGame();
        // 対局中はCPUの設定を変更できない
        if (game.status === "playing") {
          respond({ ok: false, error: "game_in_progress" });
          return;
        }

        // --- CPU解除 ---
        if (!payload.enabled) {
          const cpuColor = this.getCpuSeatColor();
          // CPUが座っていればその席を空ける
          if (cpuColor) {
            this.releaseSeat(cpuColor, CPU_USER_ID);
          }
          this.state.cpu = null;
          this.state.cpuMoveAt = null;

          const next = this.getRoomGame();
          // CPUが座っていた席の準備完了も解除する
          if (cpuColor) {
            const flags = this.readyFlags(next);
            flags[cpuColor] = false;
            next.ready = flags;
          }

          const broadcasted = this.broadcastGame(next);
          this.broadcast("room:state", { room: this.getRoom(), game: broadcasted });
          respond({ ok: true });
          return;
        }

        // --- CPU有効化 ---
        const color = payload.color;
        // 席の色として想定していない値は受け付けない
        if (color !== "black" && color !== "white") {
          respond({ ok: false, error: "invalid_color" });
          return;
        }

        const targetSeat = this.state.seats[color];
        // 人が座っている席にはCPUを座らせられない
        if (targetSeat && targetSeat.userId !== CPU_USER_ID) {
          respond({ ok: false, error: "seat_taken" });
          return;
        }

        // 既に別の席にCPUがいれば解放
        const existing = this.getCpuSeatColor();
        if (existing && existing !== color) {
          this.releaseSeat(existing, CPU_USER_ID);
        }

        // CPUを擬似ユーザーとして着席させる
        const assigned = this.assignSeat(color, CPU_USER_ID, {
          loginId: CPU_LOGIN_ID,
          nickname: CPU_NICKNAME,
        });
        // 着席できなかった場合は席が埋まっているものとして返す
        if (!assigned.ok) {
          respond({ ok: false, error: "seat_taken" });
          return;
        }

        // 難易度と環境変数から探索設定を決めて保持する
        const resolved = resolveCpuLevel(payload.level, this.env);
        this.state.cpu = { color, ...resolved };

        const next = this.getRoomGame();
        // 対局前ならCPUの席を準備完了にしておく
        if (next.status !== "playing") {
          const flags = this.readyFlags(next);
          flags[color] = true;
          next.ready = flags;
        }

        const broadcasted = this.broadcastGame(next);
        const started = this.startGameIfReady();
        this.broadcast("room:state", {
          room: this.getRoom(),
          game: started || broadcasted,
        });
        respond({ ok: true });

        this.scheduleCpuTurn();
        return;
      }

      // ---------------------------------------------------------------------
      case "game:ready": {
        const color = this.getPlayerColor(userId);
        // 着席していない観戦者は準備状態を変更できない
        if (!color) {
          respond({ ok: false, error: "not_seated" });
          return;
        }

        const result = this.setReady(color, Boolean(payload.ready));
        // 変更できなかった場合は理由をそのまま返す
        if (!result.ok) {
          respond({ ok: false, error: result.error });
          return;
        }

        // この操作で対局が始まった場合は、CPUの手番なら思考を仕掛ける
        if (result.started) {
          this.scheduleCpuTurn();
        }

        respond({ ok: true, started: Boolean(result.started) });
        return;
      }

      // ---------------------------------------------------------------------
      case "game:place":
      case "game:move": {
        const color = this.getPlayerColor(userId);
        // 着席していない観戦者は着手できない
        if (!color) {
          respond({ ok: false, error: "not_seated" });
          return;
        }

        // イベント名から「打つ」か「動かす」かを決める
        let type = "move";
        if (event === "game:place") {
          type = "place";
        }
        const action = { type, color };

        // 種類ごとに必要な座標を検証してアクションを組み立てる
        if (type === "place") {
          const row = Number(payload.row);
          const col = Number(payload.col);
          // 座標が整数で送られてきていなければ受け付けない
          if (!Number.isInteger(row) || !Number.isInteger(col)) {
            respond({ ok: false, error: "invalid_target" });
            return;
          }
          action.to = { row, col };
        } else {
          const from = payload.from;
          const to = payload.to;
          // 移動元・移動先の座標がそろっていなければ受け付けない
          if (
            !from ||
            !to ||
            !Number.isInteger(from.row) ||
            !Number.isInteger(from.col) ||
            !Number.isInteger(to.row) ||
            !Number.isInteger(to.col)
          ) {
            respond({ ok: false, error: "invalid_target" });
            return;
          }
          action.from = { row: from.row, col: from.col };
          action.to = { row: to.row, col: to.col };
        }

        // 組み立てたアクションを現在の対局へ適用する
        const result = applyAction(this.getRoomGame(), action);
        // ルール違反の着手は理由を添えて拒否する
        if (!result.ok) {
          respond({ ok: false, error: result.error });
          return;
        }

        // 終局したら次の対局に備えて準備状態を戻す
        if (result.state.status === "finished") {
          result.state.ready = { black: false, white: false };
        }

        this.broadcastGame(result.state);
        this.scheduleCpuTurn();
        respond({ ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      case "chat:send": {
        const raw = payload.message;
        // 文字列以外の本文は受け付けない
        if (typeof raw !== "string") {
          respond({ ok: false, error: "invalid_request" });
          return;
        }

        const trimmed = raw.trim();
        // 空白だけの発言は送信させない
        if (!trimmed) {
          respond({ ok: false, error: "empty" });
          return;
        }
        // 長すぎる発言は拒否する
        if (trimmed.length > CHAT_MAX_LENGTH) {
          respond({ ok: false, error: "too_long" });
          return;
        }

        // 履歴に追加し、ルーム内の全員へ配信する
        const entry = this.addChatMessage(userId, trimmed, userInfo);
        this.broadcast("chat:new", entry);
        respond({ ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      default:
        respond({ ok: false, error: "unknown_event" });
    }
  }

  /**
   * 切断時の処理。座席を解放し、対局中なら不戦敗にします。
   * @param {WebSocket} ws - 切断されたソケット
   * @returns {Promise<void>}
   */
  async webSocketClose(ws) {
    const user = ws.deserializeAttachment();

    // 同じユーザーの別タブが残っている場合は席を空けない
    if (user && !this.hasOtherSocket(user.userId, ws)) {
      this.releaseUserSeats(user.userId);
    }

    // 閉じたソケットは自分自身を除いて数える
    this.broadcast("room:presence", {
      roomId: this.state.roomId,
      count: this.presence(ws),
    });

    await this.save();
    await this.notifyLobby(ws);
  }

  /**
   * WebSocketエラー時の処理。
   * @param {WebSocket} ws - 対象のソケット
   * @returns {Promise<void>}
   */
  webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}

export { CPU_USER_ID, CPU_LOGIN_ID, CPU_NICKNAME };
