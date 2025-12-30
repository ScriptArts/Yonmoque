const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "data", "app.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function initDb(roomCount) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
    );

    CREATE TABLE IF NOT EXISTS seats (
      room_id INTEGER NOT NULL,
      color TEXT NOT NULL,
      user_id INTEGER,
      PRIMARY KEY (room_id, color)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_state (
      room_id INTEGER PRIMARY KEY,
      last_message_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS games (
      room_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL
    );
  `);

  ensureUserNicknameColumn();
  ensureRooms(roomCount);
}

function ensureUserNicknameColumn() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasNickname = columns.some((column) => column.name === "nickname");
  if (!hasNickname) {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
  }
}

function ensureRooms(roomCount) {
  const insertRoom = db.prepare(
    "INSERT OR IGNORE INTO rooms (id, name, status) VALUES (?, ?, 'waiting')"
  );
  const updateRoomName = db.prepare(
    "UPDATE rooms SET name = ? WHERE id = ? AND name LIKE 'Room %'"
  );
  const insertSeat = db.prepare(
    "INSERT OR IGNORE INTO seats (room_id, color, user_id) VALUES (?, ?, NULL)"
  );

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

function createUser(email, passwordHash, nickname = null) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(email, passwordHash, nickname, now);
  return result.lastInsertRowid;
}

function getUserByEmail(email) {
  return db
    .prepare(
      "SELECT id, email, password_hash, nickname, created_at FROM users WHERE email = ?"
    )
    .get(email);
}

function getUserById(id) {
  return db
    .prepare("SELECT id, email, nickname, created_at FROM users WHERE id = ?")
    .get(id);
}

function updateUserNickname(userId, nickname) {
  db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(
    nickname,
    userId
  );
  return getUserById(userId);
}

function listRooms() {
  const rooms = db
    .prepare("SELECT id, name, status FROM rooms ORDER BY id ASC")
    .all();
  const seatRows = db
    .prepare(
      `
      SELECT s.room_id, s.color, u.id AS user_id, u.email, u.nickname
      FROM seats s
      LEFT JOIN users u ON s.user_id = u.id
    `
    )
    .all();

  const seatMap = new Map();
  for (const row of seatRows) {
    if (!seatMap.has(row.room_id)) {
      seatMap.set(row.room_id, { black: null, white: null });
    }
    if (row.user_id) {
      seatMap.get(row.room_id)[row.color] = {
        userId: row.user_id,
        email: row.email,
        nickname: row.nickname,
      };
    }
  }

  return rooms.map((room) => ({
    ...room,
    seats: seatMap.get(room.id) || { black: null, white: null },
  }));
}

function getRoom(roomId) {
  const room = db
    .prepare("SELECT id, name, status FROM rooms WHERE id = ?")
    .get(roomId);
  if (!room) {
    return null;
  }
  const seatRows = db
    .prepare(
      `
      SELECT s.color, u.id AS user_id, u.email, u.nickname
      FROM seats s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.room_id = ?
    `
    )
    .all(roomId);

  const seats = { black: null, white: null };
  for (const row of seatRows) {
    if (row.user_id) {
      seats[row.color] = { userId: row.user_id, email: row.email };
      seats[row.color].nickname = row.nickname;
    }
  }

  return { ...room, seats };
}

function getRoomStatus(roomId) {
  const row = db
    .prepare("SELECT status FROM rooms WHERE id = ?")
    .get(roomId);
  return row ? row.status : null;
}

function setRoomStatus(roomId, status) {
  db.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(status, roomId);
}

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
  const nextStatus = hasBlack && hasWhite ? "playing" : "waiting";
  setRoomStatus(roomId, nextStatus);
  return nextStatus;
}

function assignSeat(roomId, color, userId) {
  const seat = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color = ?")
    .get(roomId, color);
  if (!seat) {
    return { ok: false, reason: "invalid_seat" };
  }
  if (seat.user_id && seat.user_id !== userId) {
    return { ok: false, reason: "taken" };
  }
  const other = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color != ?")
    .get(roomId, color);
  if (other && other.user_id === userId) {
    return { ok: false, reason: "already_seated" };
  }

  db.prepare("UPDATE seats SET user_id = ? WHERE room_id = ? AND color = ?").run(
    userId,
    roomId,
    color
  );
  const status = updateRoomStatus(roomId);
  return { ok: true, status };
}

function releaseSeat(roomId, color, userId) {
  const seat = db
    .prepare("SELECT user_id FROM seats WHERE room_id = ? AND color = ?")
    .get(roomId, color);
  if (!seat || seat.user_id !== userId) {
    return { ok: false, reason: "not_owner" };
  }
  const statusBefore = getRoomStatus(roomId);
  db.prepare("UPDATE seats SET user_id = NULL WHERE room_id = ? AND color = ?")
    .run(roomId, color);
  const statusAfter = updateRoomStatus(roomId);
  return { ok: true, statusBefore, statusAfter };
}

function releaseSeatsByUser(userId) {
  const seats = db
    .prepare("SELECT room_id, color FROM seats WHERE user_id = ?")
    .all(userId);
  const results = [];
  for (const seat of seats) {
    const statusBefore = getRoomStatus(seat.room_id);
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

function addChatMessage(roomId, userId, message) {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  const insert = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO chat_messages (room_id, user_id, message, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(roomId, userId, message, nowIso);

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

function getChatMessageById(messageId) {
  return db
    .prepare(
      `
      SELECT m.id, m.room_id, m.message, m.created_at, u.id AS user_id, u.email, u.nickname
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `
    )
    .get(messageId);
}

function getChatMessages(roomId) {
  return db
    .prepare(
      `
      SELECT m.id, m.room_id, m.message, m.created_at, u.id AS user_id, u.email, u.nickname
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ?
      ORDER BY m.id ASC
    `
    )
    .all(roomId);
}

function cleanupExpiredChats(nowIso) {
  const expired = db
    .prepare(
      "SELECT room_id FROM chat_state WHERE expires_at IS NOT NULL AND expires_at <= ?"
    )
    .all(nowIso);

  const tx = db.transaction((rooms) => {
    for (const room of rooms) {
      db.prepare("DELETE FROM chat_messages WHERE room_id = ?").run(room.room_id);
      db.prepare("DELETE FROM chat_state WHERE room_id = ?").run(room.room_id);
    }
  });

  tx(expired);
  return expired.map((row) => row.room_id);
}

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

function saveGame(roomId, state) {
  db.prepare(
    `\n      INSERT INTO games (room_id, state_json)\n      VALUES (?, ?)\n      ON CONFLICT(room_id) DO UPDATE SET state_json = excluded.state_json\n    `
  ).run(roomId, JSON.stringify(state));
}

module.exports = {
  initDb,
  ensureRooms,
  createUser,
  getUserByEmail,
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
