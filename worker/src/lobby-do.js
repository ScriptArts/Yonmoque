/**
 * @fileoverview ロビー用 Durable Object
 *
 * 全ルームのサマリ（状態・座席・在室数）を集約し、ロビー画面へ配信する。
 * Node版の broadcastRooms() に相当する役割。
 *
 * Worker はステートレスなので「全クライアントへの一斉配信」ができない。
 * 単一の Durable Object にロビー接続を集約することでこれを実現している。
 *
 * @module lobby-do
 */

import { DurableObject } from "cloudflare:workers";

import { encodeEvent, decodeMessage, PING, PONG } from "./protocol.js";

export class LobbyDurableObject extends DurableObject {
  /**
   * @param {DurableObjectState} ctx - Durable Object の状態
   * @param {Object} env - 環境変数とバインディング
   */
  constructor(ctx, env) {
    super(ctx, env);

    /** @type {Object<number, Object>} ルームIDごとのサマリ */
    this.rooms = {};

    ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get("rooms")) || {};
    });

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * 設定されたルーム数を返します。
   * @returns {number} ルーム数
   */
  roomCount() {
    const count = Number(this.env.ROOM_COUNT);
    // 環境変数が未設定・不正な場合は既定の12ルームにする
    if (Number.isFinite(count) && count > 0) {
      return Math.floor(count);
    }
    return 12;
  }

  /**
   * ルーム一覧を組み立てます。
   * まだ一度も使われていないルームは既定値（待機中・空席）で埋めます。
   * @returns {Array<Object>} ルームサマリの配列
   */
  listRooms() {
    const total = this.roomCount();
    const result = [];

    // 1番から順に、既知のサマリが無いルームは既定値で埋める
    for (let id = 1; id <= total; id += 1) {
      const known = this.rooms[id];
      // 一度も使われていないルームは待機中・空席として扱う
      if (known) {
        result.push(known);
      } else {
        result.push({
          id,
          name: `ルーム ${id}`,
          status: "waiting",
          seats: { black: null, white: null },
          presence: 0,
        });
      }
    }

    return result;
  }

  /**
   * 接続中のロビークライアント全員へルーム一覧を配信します。
   */
  broadcastRooms() {
    const message = encodeEvent("rooms:update", this.listRooms());
    // 接続中のロビークライアント全員へ同じ一覧を送る
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // 送信できないソケットは close 側で処理される
      }
    }
  }

  /**
   * Worker / RoomDO からの内部リクエストを処理します。
   * @param {Request} request - リクエスト
   * @returns {Promise<Response>} レスポンス
   */
  async fetch(request) {
    const url = new URL(request.url);

    // --- RoomDO からのサマリ更新通知 ---
    if (url.pathname === "/room-update") {
      const summary = await request.json();
      // ルームIDが取れないサマリは保存せず、配信もしない
      if (summary && Number.isFinite(summary.id)) {
        this.rooms[summary.id] = summary;
        await this.ctx.storage.put("rooms", this.rooms);
        this.broadcastRooms();
      }
      return new Response(null, { status: 204 });
    }

    // --- ルーム一覧の取得（GET /api/rooms 用） ---
    if (url.pathname === "/rooms") {
      return Response.json({ rooms: this.listRooms() });
    }

    // --- WebSocket 接続 ---
    // Upgrade ヘッダが無いリクエストはWebSocketとして扱えない
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    // 接続直後に現在の一覧を送っておく
    server.send(encodeEvent("rooms:update", this.listRooms()));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * クライアントからのメッセージを処理します。
   * ロビーは購読専用だが、明示的な再取得だけ受け付ける。
   * @param {WebSocket} ws - 送信元のソケット
   * @param {string} raw - 受信データ
   */
  webSocketMessage(ws, raw) {
    const message = decodeMessage(raw);
    // ack要求以外のメッセージはロビーでは扱わない
    if (!message || message.t !== "req") {
      return;
    }

    // ルーム一覧の再取得要求にはその場で一覧を返す
    if (message.event === "rooms:list") {
      ws.send(JSON.stringify({ t: "res", id: message.id, payload: { ok: true, rooms: this.listRooms() } }));
      return;
    }

    // 未知のイベントは、ack待ちを解放するためにエラーを返す
    if (message.id !== undefined && message.id !== null) {
      ws.send(JSON.stringify({ t: "res", id: message.id, payload: { ok: false, error: "unknown_event" } }));
    }
  }
}
