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
    // 配列やプリミティブが送られてきた場合は空オブジェクトとして扱う
    if (body && typeof body === "object") {
      return body;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * リクエストボディから文字列項目を取り出します（前後の空白は除去）。
 * @param {*} value - ボディ中の値
 * @returns {string} 文字列（文字列でなければ空文字）
 */
function readTrimmed(value) {
  // 文字列以外が送られてきた場合は未入力として扱う
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

/**
 * リクエストボディからパスワードを取り出します（空白も意味を持つため除去しない）。
 * @param {*} value - ボディ中の値
 * @returns {string} 文字列（文字列でなければ空文字）
 */
function readPassword(value) {
  // 文字列以外が送られてきた場合は未入力として扱う
  if (typeof value !== "string") {
    return "";
  }
  return value;
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
  // 環境変数が未設定・不正な場合は既定の反復回数を使う
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_ITERATIONS;
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
  // 環境変数が未設定・不正な場合は既定の12ルームにする
  if (Number.isFinite(count) && count > 0) {
    return Math.floor(count);
  }
  return 12;
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
  // セッションCookieからユーザーIDを取り出す
  const userId = await getSessionUserId(request, sessionSecret(env));
  // 未ログイン、または署名が無効ならユーザーは特定できない
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

  const loginId = readTrimmed(body.loginId);
  const password = readPassword(body.password);
  const nickname = readTrimmed(body.nickname);

  // ID・パスワードは必須
  if (!loginId || !password) {
    return json({ error: "missing_fields" }, 400);
  }
  // IDは半角英数字のみ
  if (!/^[a-zA-Z0-9]+$/.test(loginId)) {
    return json({ error: "invalid_id" }, 400);
  }
  // IDは3〜20文字
  if (loginId.length < 3 || loginId.length > 20) {
    return json({ error: "invalid_id" }, 400);
  }
  // パスワードは6文字以上
  if (password.length < 6) {
    return json({ error: "password_too_short" }, 400);
  }
  // ニックネームは20文字以内
  if (nickname.length > 20) {
    return json({ error: "nickname_too_long" }, 400);
  }

  // 同じIDが既に登録されていないか確認する
  if (await getUserByLoginId(env.DB, loginId)) {
    return json({ error: "id_exists" }, 409);
  }

  // パスワードをハッシュ化して保存する（平文は残さない）
  const passwordHash = await hashPassword(password, pbkdf2Iterations(env));

  // 未入力のニックネームはNULLとして保存する
  let storedNickname = null;
  if (nickname.length > 0) {
    storedNickname = nickname;
  }
  const userId = await createUser(env.DB, loginId, passwordHash, storedNickname);

  // 登録と同時にログイン状態にするためセッションCookieを発行する
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

  const loginId = readTrimmed(body.loginId);
  const password = readPassword(body.password);

  // ID・パスワードは必須
  if (!loginId || !password) {
    return json({ error: "missing_fields" }, 400);
  }

  // ユーザーの存在とパスワードの一致を確認する（どちらが違うかは区別せず返す）
  const user = await getUserByLoginId(env.DB, loginId);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "invalid_credentials" }, 401);
  }

  // 認証できたのでセッションCookieを発行する
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
  const nickname = readTrimmed(body.nickname);

  // ニックネームは20文字以内
  if (nickname.length > 20) {
    return json({ error: "nickname_too_long" }, 400);
  }

  // 未入力のニックネームはNULLとして保存する
  let storedNickname = null;
  if (nickname.length > 0) {
    storedNickname = nickname;
  }

  // ニックネームを更新し、更新後のユーザー情報を返す
  const updated = await updateUserNickname(env.DB, user.id, storedNickname);
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

  // 現在・新規のパスワードはどちらも必須
  if (!currentPassword || !newPassword) {
    return json({ error: "missing_fields" }, 400);
  }
  // 新しいパスワードは6文字以上
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return json({ error: "password_too_short" }, 400);
  }

  // 現在のハッシュを取得する（セッションが有効でも削除済みの可能性がある）
  const stored = await getUserWithPasswordById(env.DB, user.id);
  if (!stored) {
    return json({ error: "unauthorized" }, 401);
  }
  // なりすまし防止のため、現在のパスワードの一致を確認する
  if (!(await verifyPassword(currentPassword, stored.password_hash))) {
    return json({ error: "invalid_current_password" }, 400);
  }

  // 新しいパスワードをハッシュ化して保存する
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
  // Upgrade ヘッダが無いリクエストはWebSocketとして扱えない
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  // Durable Object へ渡すユーザー情報をここで確定させる
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
  // 存在しないルーム番号への接続は受け付けない
  if (!Number.isInteger(roomId) || roomId < 1 || roomId > roomCount(env)) {
    return new Response("not_found", { status: 404 });
  }

  const params = new URLSearchParams({
    roomId: String(roomId),
    userId: String(user.id),
    loginId: user.loginId,
  });
  // ニックネーム未設定のユーザーはクエリに含めない
  if (user.nickname) {
    params.set("nickname", user.nickname);
  }

  // 認証済みの情報を添えて RoomDO へ接続を引き渡す
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
  // 経路ごとにメソッドとパスの組み合わせで振り分ける
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

  // ログイン中のユーザー情報を返す
  if (method === "GET" && path === "/api/me") {
    return json({ user });
  }
  if (method === "POST" && path === "/api/me/nickname") {
    return updateNickname(request, env, user);
  }
  if (method === "POST" && path === "/api/me/password") {
    return changePassword(request, env, user);
  }

  // ルーム一覧は LobbyDO が集約しているので取り次ぐ
  if (method === "GET" && path === "/api/rooms") {
    const response = await lobbyStub(env).fetch("https://lobby/rooms");
    return json(await response.json());
  }

  // ルーム個別の状態は該当する RoomDO のスナップショットを取り次ぐ
  const detail = ROOM_DETAIL.exec(path);
  if (method === "GET" && detail) {
    const roomId = Number(detail[1]);
    // 存在しないルーム番号は404にする
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
      // WebSocketとAPIだけを Worker で処理し、それ以外は静的アセットへ渡す
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
