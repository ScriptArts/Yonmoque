/**
 * @fileoverview D1（SQLite）へのユーザー操作モジュール
 *
 * 永続化するのはユーザー情報のみ。
 * ルーム・座席・対局・チャットは Durable Object 側が保持する。
 *
 * Node版（server/db.js）の関数名・返り値の形をそのまま踏襲しているので、
 * 呼び出し側のロジックは変わらない。プレースホルダだけ $1 → ? に変わる。
 *
 * @module db
 */

/**
 * 新しいユーザーを作成します。
 * @param {D1Database} db - D1バインディング
 * @param {string} loginId - ログインID（半角英数字）
 * @param {string} passwordHash - ハッシュ化されたパスワード
 * @param {string|null} [nickname=null] - ニックネーム（任意）
 * @returns {Promise<number>} 作成されたユーザーのID
 */
async function createUser(db, loginId, passwordHash, nickname = null) {
  const row = await db
    .prepare(
      `INSERT INTO users (login_id, password_hash, nickname)
       VALUES (?, ?, ?)
       RETURNING id`
    )
    .bind(loginId, passwordHash, nickname)
    .first();
  return row.id;
}

/**
 * ログインIDからユーザーを検索します。
 * @param {D1Database} db - D1バインディング
 * @param {string} loginId - 検索するログインID
 * @returns {Promise<Object|null>} ユーザーオブジェクト（password_hash含む）
 */
function getUserByLoginId(db, loginId) {
  return db
    .prepare(
      `SELECT id, login_id AS loginId, password_hash, nickname, created_at
       FROM users WHERE login_id = ?`
    )
    .bind(loginId)
    .first();
}

/**
 * ユーザーIDからユーザーを検索します。
 * @param {D1Database} db - D1バインディング
 * @param {number} id - 検索するユーザーID
 * @returns {Promise<Object|null>} ユーザーオブジェクト（password_hashは含まない）
 */
function getUserById(db, id) {
  return db
    .prepare(
      `SELECT id, login_id AS loginId, nickname, created_at
       FROM users WHERE id = ?`
    )
    .bind(id)
    .first();
}

/**
 * ユーザーIDからパスワードハッシュを含むユーザー情報を取得します。
 * @param {D1Database} db - D1バインディング
 * @param {number} id - 検索するユーザーID
 * @returns {Promise<Object|null>} ユーザーオブジェクト（password_hash含む）
 */
function getUserWithPasswordById(db, id) {
  return db
    .prepare(
      `SELECT id, login_id AS loginId, password_hash, nickname, created_at
       FROM users WHERE id = ?`
    )
    .bind(id)
    .first();
}

/**
 * ユーザーのニックネームを更新します。
 * @param {D1Database} db - D1バインディング
 * @param {number} userId - 更新するユーザーのID
 * @param {string|null} nickname - 新しいニックネーム
 * @returns {Promise<Object|null>} 更新後のユーザーオブジェクト
 */
async function updateUserNickname(db, userId, nickname) {
  await db
    .prepare(`UPDATE users SET nickname = ? WHERE id = ?`)
    .bind(nickname, userId)
    .run();
  return getUserById(db, userId);
}

/**
 * ユーザーのパスワードを更新します。
 * @param {D1Database} db - D1バインディング
 * @param {number} userId - 更新するユーザーのID
 * @param {string} passwordHash - 新しいパスワードのハッシュ
 * @returns {Promise<boolean>} 更新できたらtrue
 */
async function updateUserPassword(db, userId, passwordHash) {
  const result = await db
    .prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .bind(passwordHash, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export {
  createUser,
  getUserByLoginId,
  getUserById,
  getUserWithPasswordById,
  updateUserNickname,
  updateUserPassword,
};
