-- ヨンモク D1 スキーマ
--
-- 永続化するのはユーザー情報のみ。
-- ルーム・座席・対局・チャットは Durable Object 側で保持する。

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_login_id ON users (login_id);
