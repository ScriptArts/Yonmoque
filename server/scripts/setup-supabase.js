/**
 * @fileoverview Supabaseデータベースのセットアップスクリプト
 * 
 * 使用方法:
 * DATABASE_URL環境変数を設定するか、.envファイルに記載して実行
 * $ node scripts/setup-supabase.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Error: DATABASE_URL environment variable is required');
  console.error('Format: postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres');
  process.exit(1);
}

const setupSQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login_id TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function setup() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  
  try {
    console.log('Connecting to Supabase...');
    await client.connect();
    console.log('Connected!');
    
    console.log('Creating tables...');
    await client.query(setupSQL);
    console.log('Done!');
    
    await client.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

setup();
