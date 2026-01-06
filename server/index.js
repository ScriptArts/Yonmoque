/**
 * @fileoverview ヨンモクゲーム サーバーメインモジュール
 *
 * Express + Socket.io を使用したリアルタイム対戦ゲームサーバー。
 * - REST API: 認証、ルーム情報取得
 * - WebSocket: リアルタイム対局、チャット
 *
 * @module index
 */

// 環境変数を.envファイルから読み込み（最初に実行）
require("dotenv").config();

const http = require("http");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const { searchBestMove } = require("./ai");

const {
  initDb,
  listRooms,
  getRoom,
  createUser,
  getUserByLoginId,
  getUserById,
  updateUserNickname,
  assignSeat,
  releaseSeat,
  releaseSeatsByUser,
  addChatMessage,
  getChatMessages,
  cleanupExpiredChats,
  getGame,
  saveGame,
} = require("./db");

const {
  createNewGameState,
  createWaitingState,
  normalizeState,
  applyAction,
} = require("./game");

// =============================================================================
// 環境設定
// =============================================================================

/** サーバーのポート番号（デフォルト: 3001） */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

/** ルーム数（環境変数または12） */
const roomCountEnv = process.env.ROOM_COUNT ? Number(process.env.ROOM_COUNT) : 12;
const ROOM_COUNT = Number.isFinite(roomCountEnv) ? roomCountEnv : 12;

/** セッション暗号化キー（本番環境では必ず変更すること） */
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";

/** クライアントのオリジン（CORS設定用） */
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

/** CPUプレイヤーのログインID */
const CPU_LOGIN_ID = "cpu";

/** CPUプレイヤーの表示名 */
const CPU_NICKNAME = "CPU";

// =============================================================================
// CPU対戦の設定
// =============================================================================

/** CPUユーザーのID（起動時に設定） */
let cpuUserId = null;

/** CPUユーザー情報（座席割り当て用） */
let cpuUserInfo = null;

/**
 * CPUユーザーが存在することを保証し、ユーザー情報を返します。
 * 存在しない場合は新規作成します。
 * @returns {Promise<Object>} CPUユーザーオブジェクト
 */
async function ensureCpuUser() {
  const existing = await getUserByLoginId(CPU_LOGIN_ID);
  if (existing) {
    return existing;
  }
  // ランダムなパスワードハッシュを生成（ログインには使用しない）
  const hash = bcrypt.hashSync(`cpu_${Date.now()}`, 10);
  const odUserId = await createUser(CPU_LOGIN_ID, hash, CPU_NICKNAME);
  return await getUserById(odUserId);
}

/**
 * CPUの難易度設定
 * - easy: 浅い探索、高速
 * - normal: 中程度
 * - hard: 深い探索
 * - strong: 最も強い設定
 * @type {Object<string, {maxDepth: number, timeLimitMs: number}>}
 */
const CPU_LEVELS = {
  easy: { maxDepth: 2, timeLimitMs: 120 },
  normal: { maxDepth: 3, timeLimitMs: 240 },
  hard: { maxDepth: 4, timeLimitMs: 420 },
  strong: { maxDepth: 5, timeLimitMs: 700 },
};

/**
 * ルームごとのCPU設定を保持するマップ
 * @type {Map<number, Object>}
 */
const cpuRooms = new Map();

/**
 * CPUが思考中のルームIDを保持するセット（重複実行防止用）
 * @type {Set<number>}
 */
const cpuThinking = new Set();

// =============================================================================
// Express アプリケーション設定
// =============================================================================

const app = express();

// プロキシ信頼設定（Render等のリバースプロキシ対応）
app.set("trust proxy", 1);

// CORS設定（クライアントからのリクエストを許可）
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));

// JSONボディパーサー
app.use(express.json());

/**
 * 本番環境かどうかを判定
 * NODE_ENVが'production'またはHTTPS環境の場合はtrue
 */
const isProduction = process.env.NODE_ENV === "production" || CLIENT_ORIGIN.startsWith("https://");

/**
 * セッションミドルウェア設定
 * Socket.ioでも共有するため変数に保存
 */
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,  // プロキシ（Render等）の背後にある場合に必要
  cookie: {
    httpOnly: true,      // JavaScriptからアクセス不可
    // 本番環境ではクロスサイトCookieを有効化
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,  // HTTPSの場合のみtrue
    maxAge: 1000 * 60 * 60 * 24 * 7,  // 7日間
  },
});

app.use(sessionMiddleware);

// =============================================================================
// 認証ミドルウェア
// =============================================================================

/**
 * 認証が必要なルートで使用するミドルウェア
 * 未ログインの場合は401エラーを返す
 * @param {Object} req - Expressリクエスト
 * @param {Object} res - Expressレスポンス
 * @param {Function} next - 次のミドルウェア
 */
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// =============================================================================
// REST API エンドポイント
// =============================================================================

/**
 * GET /api/me
 * 現在ログイン中のユーザー情報を取得
 */
app.get("/api/me", async (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const user = await getUserById(req.session.userId);
  res.json({ user });
});

/**
 * POST /api/me/nickname
 * ニックネームを更新
 * @body {string} nickname - 新しいニックネーム（20文字以内）
 */
app.post("/api/me/nickname", requireAuth, async (req, res) => {
  const nicknameRaw = req.body ? req.body.nickname : "";
  const nickname =
    typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";

  if (nickname.length > 20) {
    res.status(400).json({ error: "nickname_too_long" });
    return;
  }

  const nextNickname = nickname.length === 0 ? null : nickname;
  const user = await updateUserNickname(req.session.userId, nextNickname);
  res.json({ user });
});

/**
 * POST /api/auth/register
 * 新規ユーザー登録
 * @body {string} loginId - ログインID（半角英数字、3-20文字）
 * @body {string} password - パスワード（6文字以上）
 * @body {string} [nickname] - ニックネーム（任意、20文字以内）
 */
app.post("/api/auth/register", async (req, res) => {
  const { loginId: loginIdRaw, password: passwordRaw, nickname: nicknameRaw } =
    req.body || {};
  const loginId = typeof loginIdRaw === "string" ? loginIdRaw.trim() : "";
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  const nickname =
    typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";

  // バリデーション
  if (!loginId || !password) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  if (!/^[a-zA-Z0-9]+$/.test(loginId)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  if (loginId.length < 3 || loginId.length > 20) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "password_too_short" });
    return;
  }
  if (nickname.length > 20) {
    res.status(400).json({ error: "nickname_too_long" });
    return;
  }

  // 重複チェック
  if (await getUserByLoginId(loginId)) {
    res.status(409).json({ error: "id_exists" });
    return;
  }

  // ユーザー作成
  const passwordHash = await bcrypt.hash(password, 10);
  const storedNickname = nickname.length === 0 ? null : nickname;
  const userId = await createUser(loginId, passwordHash, storedNickname);

  // セッションにユーザーIDを保存
  req.session.userId = userId;

  res.status(201).json({
    user: { id: userId, loginId, nickname: storedNickname },
  });
});

/**
 * POST /api/auth/login
 * ログイン
 * @body {string} loginId - ログインID
 * @body {string} password - パスワード
 */
app.post("/api/auth/login", async (req, res) => {
  const { loginId: loginIdRaw, password: passwordRaw } = req.body || {};
  const loginId = typeof loginIdRaw === "string" ? loginIdRaw.trim() : "";
  const password = typeof passwordRaw === "string" ? passwordRaw : "";

  if (!loginId || !password) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }

  // ユーザー検索
  const user = await getUserByLoginId(loginId);
  if (!user) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  // パスワード検証
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  // セッションにユーザーIDを保存
  req.session.userId = user.id;

  res.json({ user: { id: user.id, loginId: user.loginId, nickname: user.nickname } });
});

/**
 * POST /api/auth/logout
 * ログアウト
 */
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

/**
 * GET /api/rooms
 * ルーム一覧を取得
 */
app.get("/api/rooms", requireAuth, (req, res) => {
  const rooms = listRooms();
  // 各ルームにオンライン人数を追加
  const withPresence = rooms.map((room) => ({
    ...room,
    presence: getRoomPresence(room.id),
  }));
  res.json({ rooms: withPresence });
});

/**
 * GET /api/rooms/:roomId
 * 特定ルームの詳細情報を取得
 */
app.get("/api/rooms/:roomId", requireAuth, (req, res) => {
  const roomId = Number(req.params.roomId);
  const room = getRoom(roomId);
  if (!room) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const chat = getChatMessages(roomId);
  const game = getRoomGame(roomId);
  res.json({ room, chat, game });
});

// =============================================================================
// HTTP サーバー & Socket.io 設定
// =============================================================================

/** HTTPサーバー */
const server = http.createServer(app);

/** Socket.ioサーバー */
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    credentials: true,
  },
});

/**
 * Socket.io認証ミドルウェア
 * Expressセッションを共有し、未ログインユーザーの接続を拒否
 */
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    if (!socket.request.session.userId) {
      next(new Error("unauthorized"));
      return;
    }
    next();
  });
});

// =============================================================================
// ルームプレゼンス（オンライン人数）管理
// =============================================================================

/**
 * ルームごとの接続ソケットIDを管理するマップ
 * @type {Map<number, Set<string>>}
 */
const roomPresence = new Map();

/**
 * ルームのオンライン人数を取得
 * @param {number} roomId - ルームID
 * @returns {number} オンライン人数
 */
function getRoomPresence(roomId) {
  const set = roomPresence.get(roomId);
  return set ? set.size : 0;
}

/**
 * ルームにプレゼンスを追加
 * @param {number} roomId - ルームID
 * @param {string} socketId - ソケットID
 */
function addPresence(roomId, socketId) {
  if (!roomPresence.has(roomId)) {
    roomPresence.set(roomId, new Set());
  }
  roomPresence.get(roomId).add(socketId);
}

/**
 * ルームからプレゼンスを削除
 * @param {number} roomId - ルームID
 * @param {string} socketId - ソケットID
 */
function removePresence(roomId, socketId) {
  const set = roomPresence.get(roomId);
  if (!set) {
    return;
  }
  set.delete(socketId);
  if (set.size === 0) {
    roomPresence.delete(roomId);
  }
}

/**
 * 全クライアントにルーム一覧の更新を通知
 */
function broadcastRooms() {
  const rooms = listRooms();
  const withPresence = rooms.map((room) => ({
    ...room,
    presence: getRoomPresence(room.id),
  }));
  io.emit("rooms:update", withPresence);
}

// =============================================================================
// CPU対戦ヘルパー関数
// =============================================================================

/**
 * ルームのCPU設定を取得
 * @param {number} roomId - ルームID
 * @returns {Object|null} CPU設定またはnull
 */
function getCpuConfig(roomId) {
  return cpuRooms.get(roomId) || null;
}

/**
 * ゲーム状態にCPUの準備完了状態を適用
 * @param {number} roomId - ルームID
 * @param {Object} game - ゲーム状態
 * @returns {Object} 更新されたゲーム状態
 */
function applyCpuReady(roomId, game) {
  const config = getCpuConfig(roomId);
  if (!config || !config.enabled) {
    return game;
  }
  // プレイ中は変更しない
  if (game.status === "playing") {
    return game;
  }
  // CPUの準備完了を設定
  game.ready = {
    black: Boolean(game.ready?.black),
    white: Boolean(game.ready?.white),
    [config.color]: true,
  };
  return game;
}

/**
 * ルームのゲーム状態を取得（CPU準備完了適用済み）
 * @param {number} roomId - ルームID
 * @returns {Object} ゲーム状態
 */
function getRoomGame(roomId) {
  const stored = getGame(roomId);
  const game = stored ? normalizeState(stored) : createWaitingState();
  return applyCpuReady(roomId, game);
}

/**
 * ゲーム状態を保存し、ルーム内の全クライアントに通知
 * @param {number} roomId - ルームID
 * @param {Object} game - ゲーム状態
 * @returns {Object} 保存されたゲーム状態
 */
function broadcastGame(roomId, game) {
  const next = applyCpuReady(roomId, game);
  saveGame(roomId, next);
  io.to(`room:${roomId}`).emit("game:state", { roomId, game: next });
  return next;
}

/**
 * 両プレイヤーが準備完了したらゲームを開始
 * @param {number} roomId - ルームID
 * @returns {Object|null} 開始されたゲーム状態、または変更なしの場合はnull
 */
function startGameIfReady(roomId) {
  const room = getRoom(roomId);
  if (!room || room.status !== "playing") {
    return null;
  }

  const current = getGame(roomId);
  const normalized = current ? normalizeState(current) : createWaitingState();
  const withCpu = applyCpuReady(roomId, normalized);

  // 既にプレイ中
  if (withCpu.status === "playing") {
    return withCpu;
  }

  // 両者準備完了ならゲーム開始
  const ready = withCpu.ready || { black: false, white: false };
  if (ready.black && ready.white) {
    const game = createNewGameState();
    return broadcastGame(roomId, game);
  }

  return withCpu;
}

/**
 * ユーザーの座席の色を取得
 * @param {Object} room - ルームオブジェクト
 * @param {number} userId - ユーザーID
 * @returns {'black'|'white'|null} 座席の色またはnull
 */
function getPlayerColor(room, userId) {
  if (room.seats.black && room.seats.black.userId === userId) {
    return "black";
  }
  if (room.seats.white && room.seats.white.userId === userId) {
    return "white";
  }
  return null;
}

/**
 * プレイヤーの準備完了状態を設定
 * @param {number} roomId - ルームID
 * @param {'black'|'white'} color - プレイヤーの色
 * @param {boolean} value - 準備完了かどうか
 * @returns {Object} 結果オブジェクト
 */
function setReady(roomId, color, value) {
  const game = getRoomGame(roomId);

  // プレイ中は変更不可
  if (game.status === "playing") {
    return { ok: false, error: "game_in_progress" };
  }

  game.ready = {
    black: Boolean(game.ready?.black),
    white: Boolean(game.ready?.white),
    [color]: Boolean(value),
  };

  const room = getRoom(roomId);

  // 両者準備完了ならゲーム開始
  if (room && room.status === "playing" && game.ready.black && game.ready.white) {
    const next = createNewGameState();
    broadcastGame(roomId, next);
    return { ok: true, game: next, started: true };
  }

  const next = broadcastGame(roomId, game);
  return { ok: true, game: next };
}

/**
 * CPUが座っている座席の色を取得
 * @param {Object} room - ルームオブジェクト
 * @returns {'black'|'white'|null} CPUの座席の色またはnull
 */
function getCpuSeatColor(room) {
  if (room?.seats?.black?.userId === cpuUserId) {
    return "black";
  }
  if (room?.seats?.white?.userId === cpuUserId) {
    return "white";
  }
  return null;
}

/**
 * CPUの手番なら思考を開始
 * 非同期で実行され、最善手を探索して適用する
 * @param {number} roomId - ルームID
 */
function maybeRunCpuTurn(roomId) {
  const config = getCpuConfig(roomId);
  if (!config || !config.enabled) {
    return;
  }

  // 既に思考中なら何もしない
  if (cpuThinking.has(roomId)) {
    return;
  }

  const game = getRoomGame(roomId);

  // CPUの手番でなければ何もしない
  if (game.status !== "playing" || game.turn !== config.color) {
    return;
  }

  // 思考開始をマーク
  cpuThinking.add(roomId);

  // 少し遅延を入れて人間らしく見せる
  const delay = Number.isFinite(config.delayMs) ? config.delayMs : 350;

  setTimeout(() => {
    try {
      const room = getRoom(roomId);
      const current = getRoomGame(roomId);

      if (!room) {
        cpuThinking.delete(roomId);
        return;
      }

      // 状態が変わっていたら中断
      if (current.status !== "playing" || current.turn !== config.color) {
        cpuThinking.delete(roomId);
        return;
      }

      // 最善手を探索
      const action = searchBestMove(current, config.color, config);
      if (!action) {
        cpuThinking.delete(roomId);
        return;
      }

      // 手を適用
      const result = applyAction(current, action);
      if (!result.ok) {
        cpuThinking.delete(roomId);
        return;
      }

      // ゲーム終了時は準備状態をリセット
      if (result.state.status === "finished") {
        result.state.ready = { black: false, white: false };
      }

      // 結果を通知
      const next = broadcastGame(roomId, result.state);
      io.to(`room:${roomId}`).emit("room:state", { room, game: next });

      cpuThinking.delete(roomId);

      // 連続手番（相手がパスの場合など）に対応
      if (next.status === "playing") {
        maybeRunCpuTurn(roomId);
      }
    } catch (error) {
      console.error("CPU turn error:", error);
      cpuThinking.delete(roomId);
    }
  }, delay);
}

// =============================================================================
// ルーム入退室ヘルパー関数
// =============================================================================

/**
 * ソケットをルームから退室させる
 * @param {Object} socket - Socket.ioソケット
 */
function leaveRoom(socket) {
  const currentRoomId = socket.data.roomId;
  if (!currentRoomId) {
    return;
  }

  removePresence(currentRoomId, socket.id);
  socket.leave(`room:${currentRoomId}`);

  // 退室をルーム内に通知
  io.to(`room:${currentRoomId}`).emit("room:presence", {
    roomId: currentRoomId,
    count: getRoomPresence(currentRoomId),
  });

  socket.data.roomId = null;
}

/**
 * 対局中の離脱（不戦敗）を処理
 * @param {number} roomId - ルームID
 * @param {number} leaverUserId - 離脱したユーザーのID
 */
function handleForfeit(roomId, leaverUserId) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  // 残っているプレイヤーを勝者とする
  let winnerColor = null;
  if (room.seats.black && room.seats.black.userId !== leaverUserId) {
    winnerColor = "black";
  }
  if (room.seats.white && room.seats.white.userId !== leaverUserId) {
    winnerColor = "white";
  }

  if (winnerColor) {
    const game = startGameIfReady(roomId) || getRoomGame(roomId);
    if (game.status === "playing") {
      game.status = "finished";
      game.winner = winnerColor;
      game.result = "forfeit";  // 不戦勝
      game.ready = { black: false, white: false };
      broadcastGame(roomId, game);
    }
  }

  // 不戦敗イベントを通知
  io.to(`room:${roomId}`).emit("room:forfeit", {
    roomId,
    winnerColor,
    leaverUserId,
  });
}

/**
 * ユーザーのすべての座席を解放（切断時などに使用）
 * @param {number} userId - ユーザーID
 * @returns {Array<Object>} 解放された座席情報の配列
 */
function releaseUserSeats(userId) {
  const released = releaseSeatsByUser(userId);

  for (const seat of released) {
    // 人が離席したらCPUも一緒に離席させる
    const roomBeforeCpuRelease = getRoom(seat.roomId);
    const cpuColor = getCpuSeatColor(roomBeforeCpuRelease);
    if (cpuColor) {
      releaseSeat(seat.roomId, cpuColor, cpuUserId);
      cpuRooms.delete(seat.roomId);
    }

    const room = getRoom(seat.roomId);
    if (room) {
      let game = getRoomGame(seat.roomId);

      // プレイ中でなければ準備状態をリセット
      if (seat.statusBefore !== "playing" && game.status !== "playing") {
        game.ready = {
          black: false,
          white: false,
        };
        saveGame(seat.roomId, game);
      }

      game = getRoomGame(seat.roomId);
      io.to(`room:${seat.roomId}`).emit("room:state", { room, game });
    }

    // プレイ中に離脱した場合は不戦敗処理
    if (seat.statusBefore === "playing") {
      handleForfeit(seat.roomId, userId);
    }
  }

  return released;
}

// =============================================================================
// Socket.io イベントハンドラ
// =============================================================================

io.on("connection", async (socket) => {
  // セッションからユーザー情報を取得
  const userId = socket.request.session.userId;
  const user = await getUserById(userId);

  // ソケットにユーザー情報を保存
  socket.data.user = user;
  socket.data.roomId = null;

  // ユーザー情報オブジェクト（座席割り当て用）
  const userInfo = {
    loginId: user.loginId,
    nickname: user.nickname,
  };

  // -------------------------------------------------------------------------
  // room:join - ルームに入室
  // -------------------------------------------------------------------------
  socket.on("room:join", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    if (!roomId) {
      if (ack) ack({ ok: false, error: "invalid_room" });
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      if (ack) ack({ ok: false, error: "not_found" });
      return;
    }

    // 既存のルームから退室
    leaveRoom(socket);

    // 新しいルームに入室
    socket.data.roomId = roomId;
    socket.join(`room:${roomId}`);
    addPresence(roomId, socket.id);

    // 期限切れチャットをクリーンアップ
    const clearedRooms = cleanupExpiredChats();
    if (clearedRooms.includes(roomId)) {
      io.to(`room:${roomId}`).emit("chat:cleared", { roomId });
    }

    // ルーム状態を返す
    const chat = getChatMessages(roomId);
    const game = startGameIfReady(roomId) || getRoomGame(roomId);
    if (ack) {
      ack({ ok: true, state: { room, chat, game } });
    }

    // プレゼンス更新を通知
    io.to(`room:${roomId}`).emit("room:presence", {
      roomId,
      count: getRoomPresence(roomId),
    });
    broadcastRooms();
  });

  // -------------------------------------------------------------------------
  // room:leave - ルームから退室
  // -------------------------------------------------------------------------
  socket.on("room:leave", () => {
    leaveRoom(socket);
    releaseUserSeats(userId);
    broadcastRooms();
  });

  // -------------------------------------------------------------------------
  // seat:take - 座席に着席
  // -------------------------------------------------------------------------
  socket.on("seat:take", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    const color = payload && payload.color;

    if (!roomId || !color) {
      if (ack) ack({ ok: false, error: "invalid_request" });
      return;
    }
    if (socket.data.roomId !== roomId) {
      if (ack) ack({ ok: false, error: "not_in_room" });
      return;
    }

    const result = assignSeat(roomId, color, userId, userInfo);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }

    const room = getRoom(roomId);
    let game = getRoomGame(roomId);

    // 着席時は準備状態をリセット
    if (game.status !== "playing") {
      game.ready = {
        black: Boolean(game.ready?.black),
        white: Boolean(game.ready?.white),
        [color]: false,
      };
      saveGame(roomId, game);
    }

    game = startGameIfReady(roomId) || getRoomGame(roomId);
    io.to(`room:${roomId}`).emit("room:state", { room, game });
    broadcastRooms();
    if (ack) ack({ ok: true });
  });

  // -------------------------------------------------------------------------
  // seat:leave - 座席から離席
  // -------------------------------------------------------------------------
  socket.on("seat:leave", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    const color = payload && payload.color;

    if (!roomId || !color) {
      if (ack) ack({ ok: false, error: "invalid_request" });
      return;
    }

    const result = releaseSeat(roomId, color, userId);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }

    // 人が離席したらCPUも一緒に離席させる
    const roomBeforeCpuRelease = getRoom(roomId);
    const cpuColor = getCpuSeatColor(roomBeforeCpuRelease);
    if (cpuColor) {
      releaseSeat(roomId, cpuColor, cpuUserId);
      cpuRooms.delete(roomId);
    }

    const room = getRoom(roomId);
    let game = getRoomGame(roomId);

    // 離席時は準備状態をリセット
    if (result.statusBefore !== "playing" && game.status !== "playing") {
      game.ready = {
        black: false,
        white: false,
      };
      saveGame(roomId, game);
    }

    game = startGameIfReady(roomId) || getRoomGame(roomId);
    io.to(`room:${roomId}`).emit("room:state", { room, game });
    broadcastRooms();

    // プレイ中の離席は不戦敗
    if (result.statusBefore === "playing") {
      handleForfeit(roomId, userId);
    }

    if (ack) ack({ ok: true });
  });

  // -------------------------------------------------------------------------
  // cpu:configure - CPU対戦の設定
  // -------------------------------------------------------------------------
  socket.on("cpu:configure", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    const enabled = Boolean(payload && payload.enabled);
    const color = payload && payload.color;
    const levelRaw = payload && payload.level;

    if (!roomId) {
      if (ack) ack({ ok: false, error: "invalid_room" });
      return;
    }
    if (socket.data.roomId !== roomId) {
      if (ack) ack({ ok: false, error: "not_in_room" });
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      if (ack) ack({ ok: false, error: "not_found" });
      return;
    }

    const game = getRoomGame(roomId);
    if (game.status === "playing") {
      if (ack) ack({ ok: false, error: "game_in_progress" });
      return;
    }

    // --- CPU無効化 ---
    if (!enabled) {
      const cpuColor = getCpuSeatColor(room);
      if (cpuColor) {
        releaseSeat(roomId, cpuColor, cpuUserId);
      }
      cpuRooms.delete(roomId);

      let nextGame = getRoomGame(roomId);
      if (cpuColor) {
        nextGame.ready = {
          black: Boolean(nextGame.ready?.black),
          white: Boolean(nextGame.ready?.white),
          [cpuColor]: false,
        };
      }

      const nextRoom = getRoom(roomId);
      const broadcasted = broadcastGame(roomId, nextGame);
      io.to(`room:${roomId}`).emit("room:state", {
        room: nextRoom,
        game: broadcasted,
      });
      broadcastRooms();
      if (ack) ack({ ok: true });
      return;
    }

    // --- CPU有効化 ---
    if (color !== "black" && color !== "white") {
      if (ack) ack({ ok: false, error: "invalid_color" });
      return;
    }

    // 指定席が埋まっている場合はエラー
    const targetSeat = room.seats[color];
    if (targetSeat && targetSeat.userId && targetSeat.userId !== cpuUserId) {
      if (ack) ack({ ok: false, error: "seat_taken" });
      return;
    }

    // 既存のCPU席があれば解放
    const existingCpuColor = getCpuSeatColor(room);
    if (existingCpuColor && existingCpuColor !== color) {
      releaseSeat(roomId, existingCpuColor, cpuUserId);
    }

    // CPUを着席させる
    const assignResult = assignSeat(roomId, color, cpuUserId, cpuUserInfo);
    if (!assignResult.ok) {
      if (ack) ack({ ok: false, error: "seat_taken" });
      return;
    }

    // 難易度設定
    const level = CPU_LEVELS[levelRaw] ? levelRaw : "strong";
    cpuRooms.set(roomId, {
      enabled: true,
      color,
      level,
      delayMs: 350,
      ...CPU_LEVELS[level],
    });

    let nextGame = getRoomGame(roomId);
    if (nextGame.status !== "playing") {
      nextGame.ready = {
        black: Boolean(nextGame.ready?.black),
        white: Boolean(nextGame.ready?.white),
        [color]: true,
      };
    }

    const nextRoom = getRoom(roomId);
    const broadcasted = broadcastGame(roomId, nextGame);
    const started = startGameIfReady(roomId);
    io.to(`room:${roomId}`).emit("room:state", {
      room: nextRoom,
      game: started || broadcasted,
    });
    broadcastRooms();
    if (ack) ack({ ok: true });

    // ゲーム開始後、CPUの手番なら思考開始
    maybeRunCpuTurn(roomId);
  });

  // -------------------------------------------------------------------------
  // game:place / game:move - 駒を打つ / 移動する
  // -------------------------------------------------------------------------

  /**
   * ゲームアクション（place/move）の共通ハンドラ
   * @param {'place'|'move'} type - アクションタイプ
   * @param {Object} payload - ペイロード
   * @param {Function} ack - 確認コールバック
   */
  const handleGameAction = (type, payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    if (!roomId) {
      if (ack) ack({ ok: false, error: "invalid_room" });
      return;
    }
    if (socket.data.roomId !== roomId) {
      if (ack) ack({ ok: false, error: "not_in_room" });
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      if (ack) ack({ ok: false, error: "not_found" });
      return;
    }

    const color = getPlayerColor(room, userId);
    if (!color) {
      if (ack) ack({ ok: false, error: "not_seated" });
      return;
    }

    const game = getRoomGame(roomId);
    const action = { type, color };

    // アクションパラメータを構築
    if (type === "place") {
      const row = Number(payload && payload.row);
      const col = Number(payload && payload.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        if (ack) ack({ ok: false, error: "invalid_target" });
        return;
      }
      action.to = { row, col };
    } else if (type === "move") {
      const from = payload && payload.from;
      const to = payload && payload.to;
      if (
        !from ||
        !to ||
        !Number.isInteger(from.row) ||
        !Number.isInteger(from.col) ||
        !Number.isInteger(to.row) ||
        !Number.isInteger(to.col)
      ) {
        if (ack) ack({ ok: false, error: "invalid_target" });
        return;
      }
      action.from = { row: from.row, col: from.col };
      action.to = { row: to.row, col: to.col };
    }

    // アクションを適用
    const result = applyAction(game, action);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }

    // ゲーム終了時は準備状態をリセット
    if (result.state.status === "finished") {
      result.state.ready = { black: false, white: false };
    }

    broadcastGame(roomId, result.state);

    // CPUの手番なら思考開始
    maybeRunCpuTurn(roomId);

    if (ack) ack({ ok: true });
  };

  socket.on("game:place", (payload, ack) => {
    handleGameAction("place", payload, ack);
  });

  socket.on("game:move", (payload, ack) => {
    handleGameAction("move", payload, ack);
  });

  // -------------------------------------------------------------------------
  // game:ready - 準備完了
  // -------------------------------------------------------------------------
  socket.on("game:ready", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    if (!roomId) {
      if (ack) ack({ ok: false, error: "invalid_room" });
      return;
    }
    if (socket.data.roomId !== roomId) {
      if (ack) ack({ ok: false, error: "not_in_room" });
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      if (ack) ack({ ok: false, error: "not_found" });
      return;
    }

    const color = getPlayerColor(room, userId);
    if (!color) {
      if (ack) ack({ ok: false, error: "not_seated" });
      return;
    }

    const nextReady = Boolean(payload && payload.ready);
    const result = setReady(roomId, color, nextReady);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }

    // ゲームが開始されたらCPU思考を開始
    if (result.started) {
      maybeRunCpuTurn(roomId);
    }

    if (ack) ack({ ok: true, started: Boolean(result.started) });
  });

  // -------------------------------------------------------------------------
  // chat:send - チャットメッセージ送信
  // -------------------------------------------------------------------------
  socket.on("chat:send", (payload, ack) => {
    const roomId = Number(payload && payload.roomId);
    const message = payload && payload.message;

    if (!roomId || typeof message !== "string") {
      if (ack) ack({ ok: false, error: "invalid_request" });
      return;
    }
    if (socket.data.roomId !== roomId) {
      if (ack) ack({ ok: false, error: "not_in_room" });
      return;
    }

    const trimmed = message.trim();
    if (!trimmed) {
      if (ack) ack({ ok: false, error: "empty" });
      return;
    }
    if (trimmed.length > 300) {
      if (ack) ack({ ok: false, error: "too_long" });
      return;
    }

    // メッセージを保存してブロードキャスト
    const chatMessage = addChatMessage(roomId, userId, trimmed, userInfo);
    io.to(`room:${roomId}`).emit("chat:new", chatMessage);
    if (ack) ack({ ok: true });
  });

  // -------------------------------------------------------------------------
  // disconnect - 切断
  // -------------------------------------------------------------------------
  socket.on("disconnect", () => {
    leaveRoom(socket);
    releaseUserSeats(userId);
    broadcastRooms();
  });
});

// =============================================================================
// 定期タスク
// =============================================================================

/**
 * 60秒ごとに期限切れチャットをクリーンアップ
 */
setInterval(() => {
  try {
    const clearedRooms = cleanupExpiredChats();
    for (const roomId of clearedRooms) {
      io.to(`room:${roomId}`).emit("chat:cleared", { roomId });
    }
  } catch (error) {
    console.error("Chat cleanup error:", error);
  }
}, 60 * 1000);

// =============================================================================
// サーバー起動
// =============================================================================

/**
 * サーバーを起動する非同期関数
 */
async function startServer() {
  try {
    // データベース（ユーザーテーブル確認）とルームを初期化
    await initDb(ROOM_COUNT);
    console.log("Rooms initialized");

    // CPUユーザーを確保
    const cpuUser = await ensureCpuUser();
    cpuUserId = cpuUser.id;
    cpuUserInfo = { loginId: cpuUser.loginId, nickname: cpuUser.nickname };
    console.log("CPU user ready:", cpuUserId);

    // サーバーを起動
    server.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
