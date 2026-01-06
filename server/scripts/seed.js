/**
 * @fileoverview データベースシード用スクリプト
 * デモユーザーを作成します。
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { createUser, getUserByLoginId, initDb } = require("../db");

const loginId = process.env.SEED_LOGIN_ID || "demo";
const password = process.env.SEED_PASSWORD || "password";
const nickname = process.env.SEED_NICKNAME || null;

async function run() {
  // データベース初期化
  await initDb(12);

  const existing = await getUserByLoginId(loginId);
  if (existing) {
    console.log(`User already exists: ${loginId}`);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const id = await createUser(loginId, hash, nickname);
  console.log(`Created user ${loginId} (id ${id})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
