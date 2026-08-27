/**
 * @fileoverview Cloudflare Worker エントリポイント
 *
 * - 静的アセット（client/dist）は wrangler.jsonc の assets 設定が同一オリジンで配信する
 * - /api/*  … 認証とルーム情報のREST API（D1 と Durable Object を利用）
 * - /ws     … WebSocket を RoomDO / LobbyDO へ橋渡しする
 *
 * ルーティングは外部ライブラリを使わず手書きしている。
 * 経路が10本程度しかないうえ、依存ゼロならバンドル時のモジュール解決問題と無縁になる。
 *
 * @module index
 */

import {
  createUser,
  getUserByLoginId,
  getUserById,
  getUserWithPasswordById,
  updateUserNickname,
  updateUserPassword,
} from "./db.js";
import {
  hashPassword,
  verifyPassword,
  getSessionUserId,
  createSessionCookie,
  clearSessionCookie,
  DEFAULT_ITERATIONS,
} from "./auth.js";

export { RoomDurableObject } from "./room-do.js";
export { LobbyDurableObject } from "./lobby-do.js";

// =============================================================================
// ヘルパー
// =============================================================================

/**
 * JSONレスポンスを作ります。
 * @param {*} data - レスポンスボディ
 * @param {number} [status=200] - HTTPステータス
 * @param {Object} [headers={}] - 追加ヘッダ
 * @returns {Response} レスポンス
 */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * リクエストボディをJSONとして読みます。壊れていれば空オブジェクトを返します。
 * @param {Request} request - リクエスト
 * @returns {Promise<Object>} パース結果
 */
async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/**
 * 環境変数からセッション署名鍵を取り出します。
 * @param {Object} env - 環境変数
 * @returns {string} 署名鍵
 */
function sessionSecret(env) {
  return env.SESSION_SECRET || "dev_secret_change_me";
}

/**
 * PBKDF2の反復回数を環境変数から決定します。
 * @param {Object} env - 環境変数
 * @returns {number} 反復回数
 */
function pbkdf2Iterations(env) {
  const value = Number(env.PBKDF2_ITERATIONS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ITERATIONS;
}

/**
 * HTTPS 経由かどうかを判定します（CookieのSecure属性用）。
 * @param {URL} url - リクエストURL
 * @returns {boolean} HTTPSならtrue
 */
function isSecure(url) {
  return url.protocol === "https:";
}

/**
 * 設定されたルーム数を返します。
 * @param {Object} env - 環境変数
 * @returns {number} ルーム数
 */
function roomCount(env) {
  const count = Number(env.ROOM_COUNT);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 12;
}

/**
 * 指定ルームの Durable Object スタブを取得します。
 * @param {Object} env - 環境変数
 * @param {number} roomId - ルームID
 * @returns {DurableObjectStub} スタブ
 */
function roomStub(env, roomId) {
  return env.ROOM.get(env.ROOM.idFromName(`room:${roomId}`));
}

/**
 * ロビーの Durable Object スタブを取得します。
 * @param {Object} env - 環境変数
 * @returns {DurableObjectStub} スタブ
 */
function lobbyStub(env) {
  return env.LOBBY.get(env.LOBBY.idFromName("lobby"));
}

/**
 * ログイン中のユーザーを取得します。
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @returns {Promise<Object|null>} ユーザーオブジェクト
 */
async function currentUser(request, env) {
  const userId = await getSessionUserId(request, sessionSecret(env));
  if (userId === null) {
    return null;
  }
  return getUserById(env.DB, userId);
}

// =============================================================================
// 認証API
// =============================================================================

/**
 * POST /api/auth/register - 新規ユーザー登録
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {URL} url - リクエストURL
 * @returns {Promise<Response>} レスポンス
 */
async function register(request, env, url) {
  const body = await readJson(request);

  const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";

  if (!loginId || !password) {
    return json({ error: "missing_fields" }, 400);
  }
  if (!/^[a-zA-Z0-9]+$/.test(loginId)) {
    return json({ error: "invalid_id" }, 400);
  }
  if (loginId.length < 3 || loginId.length > 20) {
    return json({ error: "invalid_id" }, 400);
  }
  if (password.length < 6) {
    return json({ error: "password_too_short" }, 400);
  }
  if (nickname.length > 20) {
    return json({ error: "nickname_too_long" }, 400);
  }

  if (await getUserByLoginId(env.DB, loginId)) {
    return json({ error: "id_exists" }, 409);
  }

  const passwordHash = await hashPassword(password, pbkdf2Iterations(env));
  const storedNickname = nickname.length === 0 ? null : nickname;
  const userId = await createUser(env.DB, loginId, passwordHash, storedNickname);

  const cookie = await createSessionCookie(userId, sessionSecret(env), isSecure(url));
  return json({ user: { id: userId, loginId, nickname: storedNickname } }, 201, {
    "Set-Cookie": cookie,
  });
}

/**
 * POST /api/auth/login - ログイン
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {URL} url - リクエストURL
 * @returns {Promise<Response>} レスポンス
 */
async function login(request, env, url) {
  const body = await readJson(request);

  const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!loginId || !password) {
    return json({ error: "missing_fields" }, 400);
  }

  const user = await getUserByLoginId(env.DB, loginId);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "invalid_credentials" }, 401);
  }

  const cookie = await createSessionCookie(user.id, sessionSecret(env), isSecure(url));
  return json(
    { user: { id: user.id, loginId: user.loginId, nickname: user.nickname } },
    200,
    { "Set-Cookie": cookie }
  );
}

// =============================================================================
// ユーザーAPI
// =============================================================================

/**
 * POST /api/me/nickname - ニックネーム更新
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {Object} user - ログイン中のユーザー
 * @returns {Promise<Response>} レスポンス
 */
async function updateNickname(request, env, user) {
  const body = await readJson(request);
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";

  if (nickname.length > 20) {
    return json({ error: "nickname_too_long" }, 400);
  }

  const updated = await updateUserNickname(
    env.DB,
    user.id,
    nickname.length === 0 ? null : nickname
  );
  return json({ user: updated });
}

/**
 * POST /api/me/password - パスワード変更
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {Object} user - ログイン中のユーザー
 * @returns {Promise<Response>} レスポンス
 */
async function changePassword(request, env, user) {
  const body = await readJson(request);
  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return json({ error: "missing_fields" }, 400);
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return json({ error: "password_too_short" }, 400);
  }

  const stored = await getUserWithPasswordById(env.DB, user.id);
  if (!stored) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!(await verifyPassword(currentPassword, stored.password_hash))) {
    return json({ error: "invalid_current_password" }, 400);
  }

  const newHash = await hashPassword(newPassword, pbkdf2Iterations(env));
  await updateUserPassword(env.DB, user.id, newHash);

  return json({ success: true });
}

// =============================================================================
// WebSocket
// =============================================================================

/**
 * GET /ws - WebSocket接続を Durable Object へ橋渡しします。
 *
 * ?lobby=1  … ロビー（ルーム一覧の購読）
 * ?roomId=N … 対局ルーム
 *
 * 認証はここで済ませ、確定したユーザー情報を Durable Object へ渡す。
 * Durable Object を呼べるのは Worker だけなので、クエリで渡して問題ない。
 *
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {URL} url - リクエストURL
 * @returns {Promise<Response>} レスポンス
 */
async function handleWebSocket(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  const user = await currentUser(request, env);
  if (!user) {
    return new Response("unauthorized", { status: 401 });
  }

  // --- ロビー ---
  if (url.searchParams.get("lobby") === "1") {
    return lobbyStub(env).fetch("https://lobby/ws", request);
  }

  // --- 対局ルーム ---
  const roomId = Number(url.searchParams.get("roomId"));
  if (!Number.isInteger(roomId) || roomId < 1 || roomId > roomCount(env)) {
    return new Response("not_found", { status: 404 });
  }

  const params = new URLSearchParams({
    roomId: String(roomId),
    userId: String(user.id),
    loginId: user.loginId,
  });
  if (user.nickname) {
    params.set("nickname", user.nickname);
  }

  return roomStub(env, roomId).fetch(`https://room/ws?${params}`, request);
}

// =============================================================================
// ルーティング
// =============================================================================

/** /api/rooms/:roomId にマッチする正規表現 */
const ROOM_DETAIL = /^\/api\/rooms\/(\d+)$/;

/**
 * /api/* のリクエストを振り分けます。
 * @param {Request} request - リクエスト
 * @param {Object} env - 環境変数
 * @param {URL} url - リクエストURL
 * @returns {Promise<Response>} レスポンス
 */
async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // --- 認証不要 ---
  if (method === "POST" && path === "/api/auth/register") {
    return register(request, env, url);
  }
  if (method === "POST" && path === "/api/auth/login") {
    return login(request, env, url);
  }
  if (method === "POST" && path === "/api/auth/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(isSecure(url)) });
  }

  // --- ここから先はログイン必須 ---
  const user = await currentUser(request, env);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  if (method === "GET" && path === "/api/me") {
    return json({ user });
  }
  if (method === "POST" && path === "/api/me/nickname") {
    return updateNickname(request, env, user);
  }
  if (method === "POST" && path === "/api/me/password") {
    return changePassword(request, env, user);
  }

  if (method === "GET" && path === "/api/rooms") {
    const response = await lobbyStub(env).fetch("https://lobby/rooms");
    return json(await response.json());
  }

  const detail = ROOM_DETAIL.exec(path);
  if (method === "GET" && detail) {
    const roomId = Number(detail[1]);
    if (roomId < 1 || roomId > roomCount(env)) {
      return json({ error: "not_found" }, 404);
    }
    const response = await roomStub(env, roomId).fetch(
      `https://room/snapshot?roomId=${roomId}`
    );
    return json(await response.json());
  }

  return json({ error: "not_found" }, 404);
}

export default {
  /**
   * Worker のリクエストハンドラ。
   * @param {Request} request - リクエスト
   * @param {Object} env - 環境変数とバインディング
   * @returns {Promise<Response>} レスポンス
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/ws") {
        return await handleWebSocket(request, env, url);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
    } catch (error) {
      console.error("worker error:", error);
      return json({ error: "internal_error" }, 500);
    }

    // run_worker_first の対象外は本来ここに来ないが、保険として静的アセットへ回す
    return env.ASSETS.fetch(request);
  },
};
