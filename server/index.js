const http = require("http");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const {
  initDb,
  listRooms,
  getRoom,
  createUser,
  getUserByEmail,
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

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const roomCountEnv = process.env.ROOM_COUNT ? Number(process.env.ROOM_COUNT) : 10;
const ROOM_COUNT = Number.isFinite(roomCountEnv) ? roomCountEnv : 10;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

initDb(ROOM_COUNT);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const user = getUserById(req.session.userId);
  res.json({ user });
});

app.post("/api/me/nickname", requireAuth, (req, res) => {
  const nicknameRaw = req.body ? req.body.nickname : "";
  const nickname =
    typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";
  if (nickname.length > 20) {
    res.status(400).json({ error: "nickname_too_long" });
    return;
  }
  const nextNickname = nickname.length === 0 ? null : nickname;
  const user = updateUserNickname(req.session.userId, nextNickname);
  res.json({ user });
});

app.post("/api/auth/register", async (req, res) => {
  const { email: emailRaw, password: passwordRaw, nickname: nicknameRaw } =
    req.body || {};
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  const nickname =
    typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";

  if (!email || !password) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    res.status(400).json({ error: "invalid_email" });
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
  if (getUserByEmail(email)) {
    res.status(409).json({ error: "email_exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const storedNickname = nickname.length === 0 ? null : nickname;
  const userId = createUser(email, passwordHash, storedNickname);
  req.session.userId = userId;
  res.status(201).json({
    user: { id: userId, email, nickname: storedNickname },
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email: emailRaw, password: passwordRaw } = req.body || {};
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  const user = getUserByEmail(email);
  if (!user) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  req.session.userId = user.id;
  res.json({ user: { id: user.id, email: user.email, nickname: user.nickname } });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/rooms", requireAuth, (req, res) => {
  const rooms = listRooms();
  const withPresence = rooms.map((room) => ({
    ...room,
    presence: getRoomPresence(room.id),
  }));
  res.json({ rooms: withPresence });
});

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

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    credentials: true,
  },
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    if (!socket.request.session.userId) {
      next(new Error("unauthorized"));
      return;
    }
    next();
  });
});

const roomPresence = new Map();

function getRoomPresence(roomId) {
  const set = roomPresence.get(roomId);
  return set ? set.size : 0;
}

function addPresence(roomId, socketId) {
  if (!roomPresence.has(roomId)) {
    roomPresence.set(roomId, new Set());
  }
  roomPresence.get(roomId).add(socketId);
}

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

function broadcastRooms() {
  const rooms = listRooms().map((room) => ({
    ...room,
    presence: getRoomPresence(room.id),
  }));
  io.emit("rooms:update", rooms);
}

function getRoomGame(roomId) {
  const stored = getGame(roomId);
  if (stored) {
    return normalizeState(stored);
  }
  return createWaitingState();
}

function broadcastGame(roomId, game) {
  saveGame(roomId, game);
  io.to(`room:${roomId}`).emit("game:state", { roomId, game });
}

function startGameIfReady(roomId) {
  const room = getRoom(roomId);
  if (!room || room.status !== "playing") {
    return null;
  }
  const current = getGame(roomId);
  const normalized = current ? normalizeState(current) : createWaitingState();
  if (normalized.status === "playing") {
    return normalized;
  }
  const ready = normalized.ready || { black: false, white: false };
  if (ready.black && ready.white) {
    const game = createNewGameState();
    broadcastGame(roomId, game);
    return game;
  }
  return normalized;
}

function getPlayerColor(room, userId) {
  if (room.seats.black && room.seats.black.userId === userId) {
    return "black";
  }
  if (room.seats.white && room.seats.white.userId === userId) {
    return "white";
  }
  return null;
}

function setReady(roomId, color, value) {
  const game = getRoomGame(roomId);
  if (game.status === "playing") {
    return { ok: false, error: "game_in_progress" };
  }
  game.ready = {
    black: Boolean(game.ready?.black),
    white: Boolean(game.ready?.white),
    [color]: Boolean(value),
  };
  const room = getRoom(roomId);
  if (room && room.status === "playing" && game.ready.black && game.ready.white) {
    const next = createNewGameState();
    broadcastGame(roomId, next);
    return { ok: true, game: next, started: true };
  }
  broadcastGame(roomId, game);
  return { ok: true, game };
}

function leaveRoom(socket) {
  const currentRoomId = socket.data.roomId;
  if (!currentRoomId) {
    return;
  }
  removePresence(currentRoomId, socket.id);
  socket.leave(`room:${currentRoomId}`);
  io.to(`room:${currentRoomId}`).emit("room:presence", {
    roomId: currentRoomId,
    count: getRoomPresence(currentRoomId),
  });
  socket.data.roomId = null;
}

function handleForfeit(roomId, leaverUserId) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }
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
      game.result = "forfeit";
      game.ready = { black: false, white: false };
      broadcastGame(roomId, game);
    }
  }
  io.to(`room:${roomId}`).emit("room:forfeit", {
    roomId,
    winnerColor,
    leaverUserId,
  });
}

function releaseUserSeats(userId) {
  const released = releaseSeatsByUser(userId);
  for (const seat of released) {
    const room = getRoom(seat.roomId);
    if (room) {
      let game = getRoomGame(seat.roomId);
      if (seat.statusBefore !== "playing" && game.status !== "playing") {
        game.ready = {
          black: Boolean(game.ready?.black),
          white: Boolean(game.ready?.white),
          [seat.color]: false,
        };
        saveGame(seat.roomId, game);
      }
      game = getRoomGame(seat.roomId);
      io.to(`room:${seat.roomId}`).emit("room:state", { room, game });
    }
    if (seat.statusBefore === "playing") {
      handleForfeit(seat.roomId, userId);
    }
  }
  return released;
}

io.on("connection", (socket) => {
  const userId = socket.request.session.userId;
  const user = getUserById(userId);
  socket.data.user = user;
  socket.data.roomId = null;

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

    leaveRoom(socket);
    socket.data.roomId = roomId;
    socket.join(`room:${roomId}`);
    addPresence(roomId, socket.id);

    const clearedRooms = cleanupExpiredChats(new Date().toISOString());
    if (clearedRooms.includes(roomId)) {
      io.to(`room:${roomId}`).emit("chat:cleared", { roomId });
    }
    const chat = getChatMessages(roomId);
    const game = startGameIfReady(roomId) || getRoomGame(roomId);
    if (ack) {
      ack({ ok: true, state: { room, chat, game } });
    }

    io.to(`room:${roomId}`).emit("room:presence", {
      roomId,
      count: getRoomPresence(roomId),
    });
    broadcastRooms();
  });

  socket.on("room:leave", () => {
    leaveRoom(socket);
    releaseUserSeats(userId);
    broadcastRooms();
  });

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
    const result = assignSeat(roomId, color, userId);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }
    const room = getRoom(roomId);
    let game = getRoomGame(roomId);
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
    const room = getRoom(roomId);
    let game = getRoomGame(roomId);
    if (result.statusBefore !== "playing" && game.status !== "playing") {
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
    if (result.statusBefore === "playing") {
      handleForfeit(roomId, userId);
    }
    if (ack) ack({ ok: true });
  });

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
    const result = applyAction(game, action);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }
    if (result.state.status === "finished") {
      result.state.ready = { black: false, white: false };
    }
    broadcastGame(roomId, result.state);
    if (ack) ack({ ok: true });
  };

  socket.on("game:place", (payload, ack) => {
    handleGameAction("place", payload, ack);
  });

  socket.on("game:move", (payload, ack) => {
    handleGameAction("move", payload, ack);
  });

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
    if (ack) ack({ ok: true, started: Boolean(result.started) });
  });

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
    const chatMessage = addChatMessage(roomId, userId, trimmed);
    io.to(`room:${roomId}`).emit("chat:new", chatMessage);
    if (ack) ack({ ok: true });
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
    releaseUserSeats(userId);
    broadcastRooms();
  });
});

setInterval(() => {
  const clearedRooms = cleanupExpiredChats(new Date().toISOString());
  for (const roomId of clearedRooms) {
    io.to(`room:${roomId}`).emit("chat:cleared", { roomId });
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
