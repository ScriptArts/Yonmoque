/**
 * @fileoverview 認証モジュール（Cloudflare Workers 版）
 *
 * Node版では bcrypt と express-session を使っていたが、どちらも Workers では動かない。
 * - パスワード: Web Crypto の PBKDF2-HMAC-SHA256
 * - セッション: HMAC-SHA256 で署名したステートレスCookie（サーバー側に保存しない）
 *
 * @module auth
 */

/** セッションCookieの名前 */
const SESSION_COOKIE = "yonmoque_session";

/** セッションの有効期間（秒）: 7日 */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** PBKDF2の既定反復回数 */
const DEFAULT_ITERATIONS = 100000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// =============================================================================
// Base64URL ヘルパー
// =============================================================================

/**
 * バイト列をBase64URL文字列に変換します。
 * @param {ArrayBuffer|Uint8Array} buffer - 変換対象
 * @returns {string} Base64URL文字列
 */
function toBase64Url(buffer) {
  // ArrayBuffer で渡された場合はバイト列に変換してから扱う
  let bytes;
  if (buffer instanceof Uint8Array) {
    bytes = buffer;
  } else {
    bytes = new Uint8Array(buffer);
  }
  let binary = "";
  // btoa に渡せるよう、1バイトずつ文字へ変換して連結する
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64URL文字列をバイト列に戻します。
 * @param {string} value - Base64URL文字列
 * @returns {Uint8Array} バイト列
 */
function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  // 復号した文字列を1文字ずつバイトへ書き戻す
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 2つのバイト列を時間非依存で比較します（タイミング攻撃対策）。
 * @param {Uint8Array} a - 比較対象A
 * @param {Uint8Array} b - 比較対象B
 * @returns {boolean} 一致すればtrue
 */
function timingSafeEqual(a, b) {
  // 長さが違う時点で不一致だが、この判定は内容を漏らさない
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  // 途中で打ち切らずに全バイトを走査し、比較時間を入力に依存させない
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// =============================================================================
// パスワードハッシュ（PBKDF2）
// =============================================================================

/**
 * PBKDF2でパスワードから鍵を導出します。
 * @param {string} password - 平文パスワード
 * @param {Uint8Array} salt - ソルト
 * @param {number} iterations - 反復回数
 * @returns {Promise<Uint8Array>} 32バイトの導出鍵
 */
async function deriveKey(password, salt, iterations) {
  // 平文パスワードをPBKDF2の鍵素材として取り込む
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

/**
 * パスワードをハッシュ化します。
 * 保存形式: `pbkdf2$<反復回数>$<salt>$<hash>`（saltとhashはBase64URL）
 *
 * @param {string} password - 平文パスワード
 * @param {number} [iterations=DEFAULT_ITERATIONS] - 反復回数
 * @returns {Promise<string>} 保存用のハッシュ文字列
 */
async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKey(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * パスワードが保存済みハッシュと一致するか検証します。
 * @param {string} password - 平文パスワード
 * @param {string} stored - hashPassword() が返した文字列
 * @returns {Promise<boolean>} 一致すればtrue
 */
async function verifyPassword(password, stored) {
  // 保存値が文字列でなければ検証できない
  if (typeof stored !== "string") {
    return false;
  }

  const parts = stored.split("$");
  // 想定の保存形式（pbkdf2$反復回数$salt$hash）でなければ不一致とする
  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    return false;
  }

  const iterations = Number(parts[1]);
  // 反復回数が壊れている保存値は検証できない
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  // 保存時と同じ条件で鍵を導出し直して突き合わせる
  const actual = await deriveKey(password, salt, iterations);

  return timingSafeEqual(actual, expected);
}

// =============================================================================
// セッション（署名Cookie）
// =============================================================================

/**
 * HMAC-SHA256用の鍵をインポートします。
 * @param {string} secret - 署名鍵
 * @returns {Promise<CryptoKey>} HMAC鍵
 */
function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * セッションペイロードに署名してCookie値を作ります。
 * @param {Object} payload - セッション内容（{ uid, exp }）
 * @param {string} secret - 署名鍵
 * @returns {Promise<string>} `<payload>.<signature>` 形式の文字列
 */
async function signSession(payload, secret) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${toBase64Url(signature)}`;
}

/**
 * Cookie値を検証してセッションペイロードを取り出します。
 * @param {string} value - Cookie値
 * @param {string} secret - 署名鍵
 * @returns {Promise<Object|null>} 有効ならペイロード、無効ならnull
 */
async function verifySession(value, secret) {
  // `<payload>.<signature>` の形でなければ検証できない
  if (typeof value !== "string" || !value.includes(".")) {
    return null;
  }

  const [body, signature] = value.split(".");
  // 本体か署名が欠けている場合は無効とする
  if (!body || !signature) {
    return null;
  }

  const key = await importHmacKey(secret);
  // 同じ鍵で署名し直し、改ざんされていないか確認する
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  if (!timingSafeEqual(fromBase64Url(signature), new Uint8Array(expected))) {
    return null;
  }

  let payload;
  try {
    // 署名が正しければ本体をJSONとして復元する
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    return null;
  }

  // 有効期限切れ、または期限が入っていないペイロードは無効とする
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return null;
  }

  return payload;
}

/**
 * リクエストのCookieヘッダから指定した名前の値を取り出します。
 * @param {Request} request - リクエスト
 * @param {string} name - Cookie名
 * @returns {string|null} Cookie値
 */
function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  // Cookieヘッダが無ければ探す対象が無い
  if (!header) {
    return null;
  }

  // `名前=値` を「;」区切りで順に調べ、目的の名前を探す
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    // 「=」を含まない断片はCookieとして解釈できないので読み飛ばす
    if (index === -1) {
      continue;
    }
    // 名前が一致したらURLデコードした値を返す
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return null;
}

/**
 * リクエストからログイン中のユーザーIDを取得します。
 * @param {Request} request - リクエスト
 * @param {string} secret - 署名鍵
 * @returns {Promise<number|null>} ユーザーID（未ログインならnull）
 */
async function getSessionUserId(request, secret) {
  const cookie = readCookie(request, SESSION_COOKIE);
  // セッションCookieが無ければ未ログイン
  if (!cookie) {
    return null;
  }

  // 署名と有効期限を検証したうえでユーザーIDを取り出す
  const payload = await verifySession(cookie, secret);
  if (payload && typeof payload.uid === "number") {
    return payload.uid;
  }
  return null;
}

/**
 * ログイン用の Set-Cookie ヘッダ値を作ります。
 *
 * SPAをWorkerと同一オリジンで配信するため SameSite=Lax で足りる
 * （Node版はフロントが別オリジンだったため SameSite=None が必要だった）。
 *
 * @param {number} userId - ユーザーID
 * @param {string} secret - 署名鍵
 * @param {boolean} [secure=true] - Secure属性を付けるか
 * @returns {Promise<string>} Set-Cookie の値
 */
async function createSessionCookie(userId, secret, secure = true) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const value = await signSession({ uid: userId, exp }, secret);
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  // HTTPS配信時のみ Secure を付ける（ローカルのHTTP開発では付けない）
  if (secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

/**
 * ログアウト用の Set-Cookie ヘッダ値（即時失効）を作ります。
 * @param {boolean} [secure=true] - Secure属性を付けるか
 * @returns {string} Set-Cookie の値
 */
function clearSessionCookie(secure = true) {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  // 発行時と属性を揃えないとCookieを削除できないため、同じ条件でSecureを付ける
  if (secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

export {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  DEFAULT_ITERATIONS,
  hashPassword,
  verifyPassword,
  getSessionUserId,
  createSessionCookie,
  clearSessionCookie,
};
