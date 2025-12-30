const bcrypt = require("bcrypt");
const { createUser, getUserByEmail } = require("../db");

const email = process.env.SEED_EMAIL || "demo@example.com";
const password = process.env.SEED_PASSWORD || "password";
const nickname = process.env.SEED_NICKNAME || null;

async function run() {
  const existing = getUserByEmail(email);
  if (existing) {
    console.log(`User already exists: ${email}`);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const id = createUser(email, hash, nickname);
  console.log(`Created user ${email} (id ${id})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
