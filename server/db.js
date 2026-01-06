/**
 * @fileoverview データベース操作モジュール
 * SQLiteを使用してユーザー、ルーム、対局、チャットなどのデータを管理します。
 * @module db
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/** データベースファイルのパス */
const dbPath = path.join(__dirname, "data", "app.db");

// データディレクトリが存在しない場合は作成
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/** SQLiteデータベースインスタンス */
const db = new Database(dbPath);

// WAL（Write-Ahead Logging）モードを有効化
// 読み取りと書き込みを同時に行えるようになり、パフォーマンスが向上
db.pragma("journal_mode = WAL");

/**
 * データベースを初期化します。
 * 必要なテーブルを作成し、指定された数のルームを確保します。
 * @param {number} roomCount - 作成するルームの数
 */
function initDb(roomCount) {
  db.exec(`
    -- ユーザーテーブル
    -- ログインID、パスワードハッシュ、ニックネームなどを保存
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      created_at TEXT NOT NULL
    );

    -- ルームテーブル
    -- 各対局ルームの基本情報を保存
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
    );

    -- 座席テーブル
    -- 各ルームの黒席・白席の着席状況を管理
    CREATE TABLE IF NOT EXISTS seats (
      room_id INTEGER NOT NULL,
      color TEXT NOT NULL,
      user_id INTEGER,
      PRIMARY KEY (room_id, color)
    );

    -- チャットメッセージテーブル
    -- ルーム内のチャット履歴を保存
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- チャット状態テーブル
    -- チャットの有効期限を管理（30分で自動削除）
    CREATE TABLE IF NOT EXISTS chat_state (
      room_id INTEGER PRIMARY KEY,
      last_message_at TEXT,
      expires_at TEXT
    );

    -- ゲーム状態テーブル
    -- 各ルームの対局状態をJSON形式で保存
    CREATE TABLE IF NOT EXISTS games (
      room_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL
    );
  `);

  ensureRooms(roomCount);
}

/**
 * 指定された数のルームが存在することを保証します。
 * 存在しないルームは新規作成し、各ルームに黒席・白席を用意します。
 * @param {number} roomCount - 確保するルームの数
 */
function ensureRooms(roomCount) {
  // ルームを挿入（既存の場合は無視）
  const insertRoom = db.prepare(
    "INSERT OR IGNORE INTO rooms (id, name, status) VALUES (?, ?, 'waiting')"
  );
  // 旧名称（Room N）のルーム名を日本語に更新
  const updateRoomName = db.prepare(
    "UPDATE rooms SET name = ? WHERE id = ? AND name LIKE 'Room %'"
  );
  // 座席を挿入（既存の場合は無視）
  const insertSeat = db.prepare(
    "INSERT OR IGNORE INTO seats (room_id, color, user_id) VALUES (?, ?, NULL)"
  );

  // トランザクションで一括処理（パフォーマンス向上）
  const tx = db.transaction((count) => {
    for (let i = 1; i <= count; i += 1) {
      insertRoom.run(i, `ルーム ${i}`);
      updateRoomName.run(`ルーム ${i}`, i);
      insertSeat.run(i, "black");
      insertSeat.run(i, "white");
    }
  });

  tx(roomCount);
}

/**
 * 新しいユーザーを作成します。
 * @param {string} loginId - ログインID（半角英数字）
 * @param {string} passwordHash - bcryptでハッシュ化されたパスワード
 * @param {string|null} [nickname=null] - ニックネーム（任意）
 * @returns {number} 作成されたユーザーのID
 */
function createUser(loginId, passwordHash, nickname = null) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO users (login_id, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(loginId, passwordHash, nickname, now);
  return result.lastInsertRowid;
}

/**
 * ログインIDからユーザーを検索します。
 * 認証時に使用（パスワードハッシュを含む）。
 * @param {string} loginId - 検索するログインID
 * @returns {Object|undefined} ユーザーオブジェクト（見つからない場合はundefined）
 * @returns {number} return.id - ユーザーID
 * @returns {string} return.loginId - ログインID
 * @returns {string} return.password_hash - パスワードハッシュ
 * @returns {string|null} return.nickname - ニックネーム
 * @returns {string} return.created_at - 作成日時（ISO形式）
 */
function getUserByLoginId(loginId) {
  return db
    .prepare(
      "SELECT id, login_id AS loginId, password_hash, nickname, created_at FROM users WHERE login_id = ?"
    )
    .get(loginId);
}

/**
 * ユーザーIDからユーザーを検索します。
 * セッション確認やプロフィール取得に使用。
 * @param {number} id - 検索するユーザーID
 * @returns {Object|null} ユーザーオブジェクト（見つからない場合はnull）
 * @returns {number} return.id - ユーザーID
 * @returns {string} return.loginId - ログインID
 * @returns {string|null} return.nickname - ニックネーム
 * @returns {string} return.created_at - 作成日時（ISO形式）
 */
function getUserById(id) {
  const row = db
    .prepare("SELECT id, login_id AS loginId, nickname, created_at FROM users WHERE id = ?")
    .get(id);
  return row || null;
}

/**
 * ユーザーのニックネームを更新します。
 * @param {number} userId - 更新するユーザーのID
 * @param {string|null} nickname - 新しいニックネーム（nullで削除）
 * @returns {Object|null} 更新後のユーザーオブジェクト
 */
function updateUserNickname(userId, nickname) {
  db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(
    nickname,
    userId
  );
  return getUserById(userId);
}

/**
 * すべてのルームを座席情報付きで取得します。
 * ロビー画面での一覧表示に使用。
 * @returns {Array<Object>} ルームオブジェクトの配列
 * @returns {number} return[].id - ルームID
 * @returns {string} return[].name - ルーム名
 * @returns {string} return[].status - ステータス（'waiting' | 'playing'）
 * @returns {Object} return[].seats - 座席情報
 * @returns {Object|null} return[].seats.black - 黒席のユーザー情報
 * @returns {Object|null} return[].seats.white - 白席のユーザー情報
 */
function listRooms() {
  // 全ルームを取得
  const rooms = db
    .prepare("SELECT id, name, status FROM rooms ORDER BY id ASC")
    .all();

  // 全座席情報をユーザー情報と結合して取得
  const seatRows = db
    .prepare(
      `
      SELECT s.room_id, s.color, u.id AS user_id, u.login_id, u.nickname
      FROM seats s
      LEFT JOIN users u ON s.user_id = u.id
    `
    )
    .all();

  // ルームIDごとに座席情報をマッピング
  const seatMap = new Map();
  for (const row of seatRows) {
    if (!seatMap.has(row.room_id)) {
      seatMap.set(row.room_id, { black: null, white: null });
    }
    if (row.user_id) {
      seatMap.get(row.room_id)[row.color] = {
        userId: row.user_id,
        loginId: row.login_id,
        nickname: row.nickname,
      };
    }
  }

  // ルーム情報に座席情報を付加して返す
  return rooms.map((room) => ({
    ...room,
    seats: seatMap.get(room.id) || { black: null, white: null },
  }));
}

/**
 * 指定されたルームの詳細情報を取得します。
 * @param {number} roomId - 取得するルームのID
 * @returns {Object|null} ルームオブジェクト（存在しない場合はnull）
 * @returns {number} return.id - ルームID
 * @returns {string} return.name - ルーム名
 * @returns {string} return.status - ステータス（'waiting' | 'playing'）
 * @returns {Object} return.seats - 座席情報
 */
function getRoom(roomId) {
  const room = db
    .prepare("SELECT id, name, status FROM rooms WHERE id = ?")
    .get(roomId);
  if (!room) {
    return null;
  }

  // 指定ルームの座席情報を取得
  const seatRows = db
    .prepare(
      `
      SELECT s.color, u.id AS user_id, u.login_id, u.nickname
      FROM seats s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.room_id = ?
    `
    )
    .all(roomId);

  const seats = { black: null, white: null };
  for (const row of seatRows) {
    if (row.user_id) {
      seats[row.color] = {
        userId: row.user_id,
        loginId: row.login_id,
        nickname: row.nickname,
      };
    }
  }

  return { ...room, seats };
}

/**
 * ルームのステータスを取得します。
 * @param {number} roomId - ルームID
 * @returns {string|null} ステータス（'waiting' | 'playing'）または null
 */
function getRoomStatus(roomId) {
  const row = db
    .prepare("SELECT status FROM rooms WHERE id = ?")
    .get(roomId);
  return row ? row.status : null;
}

/**
 * ルームのステータスを直接設定します。
 * @param {number} roomId - ルームID
 * @param {string} status - 新しいステータス（'waiting' | 'playing'）
 */
function setRoomStatus(roomId, status) {
  db.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(status, roomId);
}

/**
 * 座席状況に基づいてルームのステータスを自動更新します。
 * 両座席が埋まっている場合は 'playing'、それ以外は 'waiting' に設定。
 * @param {number} roomId - ルームID
 * @returns {string} 更新後のステータス
 */
function updateRoomStatus(roomId) {
  const seatRows = db
    .prepare("SELECT color, user_id FROM seats WHERE room_id = ?")
    .all(roomId);

  let hasBlack = false;
  let hasWhite = false;
  for (const row of seatRows) {
    if (row.color === "black" && row.user_id) {
      hasBlack = true;
    }
    if (row.color === "white" && row.user_id) {
      hasWhite = true;
    }
  }

  // 両席が埋まっていれば playing、それ以外は waiting
  const nextStatus = hasBlack && hasWhite ? "playing" : "waiting";
  setRoomStatus(roomId, nextStatus);
  return nextStatus;
}

/**
 * ユーザーを座席に着席させます。
 * @param {number} roomId - ルームID
 * @param {string} color - 座席の色（'black' | 'white'）
 * @param {number} userId - 着席するユーザーのID
 * @returns {Object} 結果オブジェクト
 * @returns {boolean} return.ok - 成功したかどうか
 * @returns {string} [return.reason] - 失敗理由（'invalid_seat' | 'taken' | 'already_seated'）
 * @returns {string} [return.status] - 成功時の新しいルームステータス
 */
function assignSeat(roomId, color, userId) {
  // 指定座席の現在の状態を確認
  const seat = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color = ?")
    .get(roomId, color);

  if (!seat) {
    return { ok: false, reason: "invalid_seat" };
  }

  // 他のユーザーが座っている場合は拒否
  if (seat.user_id && seat.user_id !== userId) {
    return { ok: false, reason: "taken" };
  }

  // 同じユーザーが反対側の席に座っている場合は拒否
  const other = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color != ?")
    .get(roomId, color);
  if (other && other.user_id === userId) {
    return { ok: false, reason: "already_seated" };
  }

  // 座席にユーザーを割り当て
  db.prepare("UPDATE seats SET user_id = ? WHERE room_id = ? AND color = ?").run(
    userId,
    roomId,
    color
  );

  const status = updateRoomStatus(roomId);
  return { ok: true, status };
}

/**
 * ユーザーを座席から離席させます。
 * @param {number} roomId - ルームID
 * @param {string} color - 座席の色（'black' | 'white'）
 * @param {number} userId - 離席するユーザーのID
 * @returns {Object} 結果オブジェクト
 * @returns {boolean} return.ok - 成功したかどうか
 * @returns {string} [return.reason] - 失敗理由（'not_owner'）
 * @returns {string} [return.statusBefore] - 離席前のルームステータス
 * @returns {string} [return.statusAfter] - 離席後のルームステータス
 */
function releaseSeat(roomId, color, userId) {
  const seat = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color = ?")
    .get(roomId, color);

  // 座席が存在しないか、他のユーザーが座っている場合は拒否
  if (!seat || seat.user_id !== userId) {
    return { ok: false, reason: "not_owner" };
  }

  const statusBefore = getRoomStatus(roomId);

  // 座席を空にする
  db.prepare("UPDATE seats SET user_id = NULL WHERE room_id = ? AND color = ?")
    .run(roomId, color);

  const statusAfter = updateRoomStatus(roomId);
  return { ok: true, statusBefore, statusAfter };
}

/**
 * 指定ユーザーが座っているすべての座席から離席させます。
 * 切断時や退室時に使用。
 * @param {number} userId - ユーザーID
 * @returns {Array<Object>} 離席した座席情報の配列
 * @returns {number} return[].roomId - ルームID
 * @returns {string} return[].color - 座席の色
 * @returns {string} return[].statusBefore - 離席前のルームステータス
 * @returns {string} return[].statusAfter - 離席後のルームステータス
 */
function releaseSeatsByUser(userId) {
  // ユーザーが座っている全座席を取得
  const seats = db
    .prepare("SELECT room_id, color FROM seats WHERE user_id = ?")
    .all(userId);

  const results = [];
  for (const seat of seats) {
    const statusBefore = getRoomStatus(seat.room_id);

    // 座席を空にする
    db.prepare("UPDATE seats SET user_id = NULL WHERE room_id = ? AND color = ?")
      .run(seat.room_id, seat.color);

    const statusAfter = updateRoomStatus(seat.room_id);
    results.push({
      roomId: seat.room_id,
      color: seat.color,
      statusBefore,
      statusAfter,
    });
  }

  return results;
}

/**
 * チャットメッセージを追加します。
 * メッセージ追加時にチャットの有効期限も更新（最後のメッセージから30分）。
 * @param {number} roomId - ルームID
 * @param {number} userId - 発言者のユーザーID
 * @param {string} message - メッセージ内容
 * @returns {Object} 追加されたメッセージオブジェクト
 */
function addChatMessage(roomId, userId, message) {
  const now = new Date();
  const nowIso = now.toISOString();
  // 最後のメッセージから30分後に期限切れ
  const expiresIso = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  // トランザクションでメッセージ追加と期限更新を一括処理
  const insert = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO chat_messages (room_id, user_id, message, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(roomId, userId, message, nowIso);

    // チャット状態を更新（期限を延長）
    db.prepare(
      `
      INSERT INTO chat_state (room_id, last_message_at, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        last_message_at = excluded.last_message_at,
        expires_at = excluded.expires_at
    `
    ).run(roomId, nowIso, expiresIso);

    return result.lastInsertRowid;
  });

  const messageId = insert();
  return getChatMessageById(messageId);
}

/**
 * メッセージIDからチャットメッセージを取得します。
 * @param {number} messageId - メッセージID
 * @returns {Object|null} メッセージオブジェクト
 * @returns {number} return.id - メッセージID
 * @returns {number} return.room_id - ルームID
 * @returns {string} return.message - メッセージ内容
 * @returns {string} return.created_at - 作成日時
 * @returns {number} return.user_id - 発言者のユーザーID
 * @returns {string} return.loginId - 発言者のログインID
 * @returns {string|null} return.nickname - 発言者のニックネーム
 */
function getChatMessageById(messageId) {
  const row = db
    .prepare(
      `
      SELECT m.id, m.room_id, m.message, m.created_at, u.id AS user_id, u.login_id, u.nickname
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `
    )
    .get(messageId);

  if (!row) return null;

  return {
    id: row.id,
    room_id: row.room_id,
    message: row.message,
    created_at: row.created_at,
    user_id: row.user_id,
    loginId: row.login_id,
    nickname: row.nickname,
  };
}

/**
 * 指定ルームのチャットメッセージ一覧を取得します。
 * @param {number} roomId - ルームID
 * @returns {Array<Object>} メッセージオブジェクトの配列（古い順）
 */
function getChatMessages(roomId) {
  const rows = db
    .prepare(
      `
      SELECT m.id, m.room_id, m.message, m.created_at, u.id AS user_id, u.login_id, u.nickname
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ?
      ORDER BY m.id ASC
    `
    )
    .all(roomId);

  return rows.map((row) => ({
    id: row.id,
    room_id: row.room_id,
    message: row.message,
    created_at: row.created_at,
    user_id: row.user_id,
    loginId: row.login_id,
    nickname: row.nickname,
  }));
}

/**
 * 有効期限が切れたチャットを削除します。
 * 定期的に実行され、30分以上メッセージがないルームのチャットを削除。
 * @param {string} nowIso - 現在時刻（ISO形式）
 * @returns {Array<number>} 削除されたルームIDの配列
 */
function cleanupExpiredChats(nowIso) {
  // 期限切れのルームを取得
  const expired = db
    .prepare(
      "SELECT room_id FROM chat_state WHERE expires_at IS NOT NULL AND expires_at <= ?"
    )
    .all(nowIso);

  // トランザクションで一括削除
  const tx = db.transaction((rooms) => {
    for (const room of rooms) {
      db.prepare("DELETE FROM chat_messages WHERE room_id = ?").run(room.room_id);
      db.prepare("DELETE FROM chat_state WHERE room_id = ?").run(room.room_id);
    }
  });

  tx(expired);
  return expired.map((row) => row.room_id);
}

/**
 * 指定ルームのゲーム状態を取得します。
 * @param {number} roomId - ルームID
 * @returns {Object|null} ゲーム状態オブジェクト（存在しない場合はnull）
 */
function getGame(roomId) {
  const row = db
    .prepare("SELECT state_json FROM games WHERE room_id = ?")
    .get(roomId);

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.state_json);
  } catch (error) {
    return null;
  }
}

/**
 * ゲーム状態を保存します。
 * 存在しない場合は新規作成、存在する場合は更新。
 * @param {number} roomId - ルームID
 * @param {Object} state - 保存するゲーム状態
 */
function saveGame(roomId, state) {
  db.prepare(
    `
      INSERT INTO games (room_id, state_json)
      VALUES (?, ?)
      ON CONFLICT(room_id) DO UPDATE SET state_json = excluded.state_json
    `
  ).run(roomId, JSON.stringify(state));
}

module.exports = {
  initDb,
  ensureRooms,
  createUser,
  getUserByLoginId,
  getUserById,
  updateUserNickname,
  listRooms,
  getRoom,
  assignSeat,
  releaseSeat,
  releaseSeatsByUser,
  addChatMessage,
  getChatMessages,
  cleanupExpiredChats,
  getGame,
  saveGame,
};
