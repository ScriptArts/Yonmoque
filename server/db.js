/**
 * @fileoverview データベース操作モジュール
 * PostgreSQL（Supabase）を使用してユーザー情報のみを永続化します。
 * ルーム、座席、ゲーム、チャットはメモリ上で管理（サーバー再起動でリセット）。
 * @module db
 */

const { Pool } = require("pg");

/** PostgreSQL接続プール */
let pool = null;

/**
 * データベース接続プールを初期化します。
 * @returns {Pool} PostgreSQL接続プール
 */
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    
    // URLをパースしてホスト名を取得
    const url = new URL(connectionString);
    
    pool = new Pool({
      user: url.username,
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1),
      ssl: { rejectUnauthorized: false },
      // IPv4を強制（RenderのIPv6問題を回避）
      family: 4,
    });
  }
  return pool;
}

// =============================================================================
// インメモリデータストア
// =============================================================================

/** @type {Map<number, Object>} ルーム情報 */
const rooms = new Map();

/** @type {Map<number, Object>} 座席情報（キー: roomId） */
const seats = new Map();

/** @type {Map<number, Object>} ゲーム状態（キー: roomId） */
const games = new Map();

/** @type {Map<number, Array>} チャットメッセージ（キー: roomId） */
const chatMessages = new Map();

/** @type {Map<number, Object>} チャット状態（キー: roomId） */
const chatState = new Map();

/** チャットメッセージIDカウンタ */
let chatMessageIdCounter = 1;

// =============================================================================
// 初期化
// =============================================================================

/**
 * データベースとインメモリストアを初期化します。
 * @param {number} roomCount - 作成するルームの数
 */
async function initDb(roomCount) {
  // インメモリルームを初期化
  for (let i = 1; i <= roomCount; i++) {
    rooms.set(i, {
      id: i,
      name: `ルーム ${i}`,
      status: "waiting",
    });
    seats.set(i, { black: null, white: null });
  }
}

// =============================================================================
// ユーザー操作（PostgreSQL）
// =============================================================================

/**
 * 新しいユーザーを作成します。
 * @param {string} loginId - ログインID（半角英数字）
 * @param {string} passwordHash - bcryptでハッシュ化されたパスワード
 * @param {string|null} [nickname=null] - ニックネーム（任意）
 * @returns {Promise<number>} 作成されたユーザーのID
 */
async function createUser(loginId, passwordHash, nickname = null) {
  const result = await getPool().query(
    `INSERT INTO users (login_id, password_hash, nickname, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [loginId, passwordHash, nickname]
  );
  return result.rows[0].id;
}

/**
 * ログインIDからユーザーを検索します。
 * @param {string} loginId - 検索するログインID
 * @returns {Promise<Object|undefined>} ユーザーオブジェクト
 */
async function getUserByLoginId(loginId) {
  const result = await getPool().query(
    `SELECT id, login_id AS "loginId", password_hash, nickname, created_at
     FROM users WHERE login_id = $1`,
    [loginId]
  );
  return result.rows[0];
}

/**
 * ユーザーIDからユーザーを検索します。
 * @param {number} id - 検索するユーザーID
 * @returns {Promise<Object|null>} ユーザーオブジェクト
 */
async function getUserById(id) {
  const result = await getPool().query(
    `SELECT id, login_id AS "loginId", nickname, created_at
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * ユーザーのニックネームを更新します。
 * @param {number} userId - 更新するユーザーのID
 * @param {string|null} nickname - 新しいニックネーム
 * @returns {Promise<Object|null>} 更新後のユーザーオブジェクト
 */
async function updateUserNickname(userId, nickname) {
  await getPool().query(
    `UPDATE users SET nickname = $1 WHERE id = $2`,
    [nickname, userId]
  );
  return getUserById(userId);
}

// =============================================================================
// ルーム操作（インメモリ）
// =============================================================================

/**
 * すべてのルームを座席情報付きで取得します。
 * @returns {Array<Object>} ルームオブジェクトの配列
 */
function listRooms() {
  const result = [];
  for (const [roomId, room] of rooms) {
    const roomSeats = seats.get(roomId) || { black: null, white: null };
    result.push({
      ...room,
      seats: roomSeats,
    });
  }
  return result;
}

/**
 * 指定されたルームの詳細情報を取得します。
 * @param {number} roomId - 取得するルームのID
 * @returns {Object|null} ルームオブジェクト
 */
function getRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const roomSeats = seats.get(roomId) || { black: null, white: null };
  return { ...room, seats: roomSeats };
}

/**
 * ルームのステータスを取得します。
 * @param {number} roomId - ルームID
 * @returns {string|null} ステータス
 */
function getRoomStatus(roomId) {
  const room = rooms.get(roomId);
  return room ? room.status : null;
}

/**
 * ルームのステータスを設定します。
 * @param {number} roomId - ルームID
 * @param {string} status - 新しいステータス
 */
function setRoomStatus(roomId, status) {
  const room = rooms.get(roomId);
  if (room) {
    room.status = status;
  }
}

/**
 * 座席状況に基づいてルームのステータスを自動更新します。
 * @param {number} roomId - ルームID
 * @returns {string} 更新後のステータス
 */
function updateRoomStatus(roomId) {
  const roomSeats = seats.get(roomId);
  if (!roomSeats) return "waiting";

  const hasBlack = roomSeats.black !== null;
  const hasWhite = roomSeats.white !== null;
  const nextStatus = hasBlack && hasWhite ? "playing" : "waiting";

  setRoomStatus(roomId, nextStatus);
  return nextStatus;
}

// =============================================================================
// 座席操作（インメモリ）
// =============================================================================

/**
 * ユーザーを座席に着席させます。
 * @param {number} roomId - ルームID
 * @param {string} color - 座席の色
 * @param {number} userId - ユーザーID
 * @param {Object} userInfo - ユーザー情報（loginId, nickname）
 * @returns {Object} 結果オブジェクト
 */
function assignSeat(roomId, color, userId, userInfo) {
  const roomSeats = seats.get(roomId);
  if (!roomSeats) {
    return { ok: false, reason: "invalid_seat" };
  }

  // 他のユーザーが座っている場合は拒否
  if (roomSeats[color] && roomSeats[color].userId !== userId) {
    return { ok: false, reason: "taken" };
  }

  // 同じユーザーが反対側の席に座っている場合は拒否
  const otherColor = color === "black" ? "white" : "black";
  if (roomSeats[otherColor] && roomSeats[otherColor].userId === userId) {
    return { ok: false, reason: "already_seated" };
  }

  // 座席にユーザーを割り当て
  roomSeats[color] = {
    userId,
    loginId: userInfo.loginId,
    nickname: userInfo.nickname,
  };

  const status = updateRoomStatus(roomId);
  return { ok: true, status };
}

/**
 * ユーザーを座席から離席させます。
 * @param {number} roomId - ルームID
 * @param {string} color - 座席の色
 * @param {number} userId - ユーザーID
 * @returns {Object} 結果オブジェクト
 */
function releaseSeat(roomId, color, userId) {
  const roomSeats = seats.get(roomId);
  if (!roomSeats) {
    return { ok: false, reason: "invalid_seat" };
  }

  if (!roomSeats[color] || roomSeats[color].userId !== userId) {
    return { ok: false, reason: "not_owner" };
  }

  const statusBefore = getRoomStatus(roomId);
  roomSeats[color] = null;
  const statusAfter = updateRoomStatus(roomId);

  return { ok: true, statusBefore, statusAfter };
}

/**
 * 指定ユーザーが座っているすべての座席から離席させます。
 * @param {number} userId - ユーザーID
 * @returns {Array<Object>} 離席した座席情報の配列
 */
function releaseSeatsByUser(userId) {
  const results = [];

  for (const [roomId, roomSeats] of seats) {
    for (const color of ["black", "white"]) {
      if (roomSeats[color] && roomSeats[color].userId === userId) {
        const statusBefore = getRoomStatus(roomId);
        roomSeats[color] = null;
        const statusAfter = updateRoomStatus(roomId);
        results.push({ roomId, color, statusBefore, statusAfter });
      }
    }
  }

  return results;
}

// =============================================================================
// チャット操作（インメモリ）
// =============================================================================

/**
 * チャットメッセージを追加します。
 * @param {number} roomId - ルームID
 * @param {number} userId - ユーザーID
 * @param {string} message - メッセージ内容
 * @param {Object} userInfo - ユーザー情報
 * @returns {Object} 追加されたメッセージオブジェクト
 */
function addChatMessage(roomId, userId, message, userInfo) {
  if (!chatMessages.has(roomId)) {
    chatMessages.set(roomId, []);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

  const msg = {
    id: chatMessageIdCounter++,
    room_id: roomId,
    user_id: userId,
    message,
    created_at: now.toISOString(),
    loginId: userInfo.loginId,
    nickname: userInfo.nickname,
  };

  chatMessages.get(roomId).push(msg);
  chatState.set(roomId, { lastMessageAt: now, expiresAt });

  return msg;
}

/**
 * 指定ルームのチャットメッセージ一覧を取得します。
 * @param {number} roomId - ルームID
 * @returns {Array<Object>} メッセージオブジェクトの配列
 */
function getChatMessages(roomId) {
  return chatMessages.get(roomId) || [];
}

/**
 * 有効期限が切れたチャットを削除します。
 * @returns {Array<number>} 削除されたルームIDの配列
 */
function cleanupExpiredChats() {
  const now = new Date();
  const expired = [];

  for (const [roomId, state] of chatState) {
    if (state.expiresAt && state.expiresAt <= now) {
      chatMessages.delete(roomId);
      chatState.delete(roomId);
      expired.push(roomId);
    }
  }

  return expired;
}

// =============================================================================
// ゲーム状態操作（インメモリ）
// =============================================================================

/**
 * 指定ルームのゲーム状態を取得します。
 * @param {number} roomId - ルームID
 * @returns {Object|null} ゲーム状態
 */
function getGame(roomId) {
  return games.get(roomId) || null;
}

/**
 * ゲーム状態を保存します。
 * @param {number} roomId - ルームID
 * @param {Object} state - ゲーム状態
 */
function saveGame(roomId, state) {
  games.set(roomId, state);
}

// =============================================================================
// エクスポート
// =============================================================================

module.exports = {
  initDb,
  createUser,
  getUserByLoginId,
  getUserById,
  updateUserNickname,
  listRooms,
  getRoom,
  getRoomStatus,
  setRoomStatus,
  updateRoomStatus,
  assignSeat,
  releaseSeat,
  releaseSeatsByUser,
  addChatMessage,
  getChatMessages,
  cleanupExpiredChats,
  getGame,
  saveGame,
};
