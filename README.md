# ヨンモク - オンライン対戦ボードゲーム

<p align="center">
  <img src="client/public/icon.png" alt="ヨンモク ロゴ" width="120">
</p>

**ヨンモク**は、1996年に [logygames](https://www.logygames.com/yonmoque/) 様が考案した5x5盤面の2人対戦ボードゲームをオンラインで遊べるWebアプリケーションです。

## 🎮 ゲームルール

- 各プレイヤーは**6個の持ち駒**を使用
- 1手につき「**駒を打つ**」または「**駒を動かす**」を選択
- 移動で相手の駒を挟むと**オセロのように反転**
- **4目並べると勝ち**、5目並べると負け

👉 [公式ルール説明](https://www.logygames.com/yonmoque/j-rule.html)

## ✨ 機能

- 🔐 **ユーザー認証** - ID/パスワードでログイン・新規登録
- 🏠 **ロビー** - 複数ルームから選んで入室
- ⚔️ **リアルタイム対戦** - WebSocketによる低遅延通信
- 🤖 **CPU対戦** - 4段階の難易度（Easy/Normal/Hard/Strong）
- 👀 **観戦機能** - 他プレイヤーの対局を観戦
- 💬 **チャット** - ルーム内でリアルタイムチャット

## 🛠️ 技術スタック

### フロントエンド

| 技術 | バージョン | 用途 |
|------|-----------|------|
| React | 19.2 | UIライブラリ |
| Vite | 7.2 | ビルドツール |
| React Router | 7.9 | ルーティング |
| Tailwind CSS | 4.1 | スタイリング |
| Socket.io Client | 4.7 | リアルタイム通信 |
| Radix UI | - | UIコンポーネント |
| Lucide React | - | アイコン |

### バックエンド

| 技術 | バージョン | 用途 |
|------|-----------|------|
| Node.js | 20+ | ランタイム |
| Express | 4.19 | Webフレームワーク |
| Socket.io | 4.7 | WebSocket通信 |
| better-sqlite3 | 12.5 | データベース |
| bcrypt | 5.1 | パスワードハッシュ |
| express-session | 1.18 | セッション管理 |

## 🚀 セットアップ

### 必要条件

- Node.js 20.x 以上
- npm 10.x 以上

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/your-username/yonmoque.git
cd yonmoque

# 依存関係をインストール
npm install
cd client && npm install && cd ..
cd server && npm install && cd ..
```

### 開発サーバーの起動

```bash
# フロントエンド・バックエンド同時起動
npm run dev
```

- フロントエンド: http://localhost:5173
- バックエンド: http://localhost:3001

### 本番ビルド

```bash
# フロントエンドをビルド
npm run build

# サーバー起動
npm run start
```

## ⚙️ 環境変数

サーバーとクライアントは `.env` ファイルで設定可能です。

### 設定方法

```bash
# サーバー設定
cd server
cp env.example .env

# クライアント設定（開発時のみ）
cd client
cp env.example .env
```

### サーバー設定（server/.env）

| 変数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `PORT` | `3001` | サーバーポート |
| `ROOM_COUNT` | `10` | 作成するルーム数 |
| `SESSION_SECRET` | `dev_secret_change_me` | セッション暗号化キー（**本番では必ず変更**） |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORSで許可するオリジン |

> ⚠️ **注意**: `SESSION_SECRET` は本番環境では必ず安全なランダム文字列に変更してください。
> ```bash
> # 安全なランダム文字列を生成
> openssl rand -base64 32
> ```

### クライアント設定（client/.env）

| 変数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `VITE_API_URL` | `http://localhost:3001` | バックエンドAPIのURL（開発時のプロキシ先） |

> 📝 **補足**: クライアントの環境変数は開発時のプロキシ設定に使用します。本番ビルドでは不要です。

## 🌐 デプロイ

### 要件

- **Node.js 20.x** 以上が動作するサーバー
- **永続ストレージ**（SQLiteデータベース用）
- **WebSocket対応**（Socket.io使用のため）

### ビルド手順

```bash
# 1. フロントエンドをビルド
cd client
npm install
npm run build

# 2. サーバーの依存関係をインストール
cd ../server
npm install
```

ビルド後、`client/dist/` に静的ファイルが生成されます。

### 起動

```bash
cd server
npm start
```

### 本番環境の環境変数

```bash
NODE_ENV=production
PORT=3001
SESSION_SECRET=<安全なランダム文字列>
CLIENT_ORIGIN=https://your-domain.com
ROOM_COUNT=10
```

### 注意事項

1. **永続ストレージ**
   - SQLiteデータベースは `server/data/app.db` に保存されます
   - コンテナ環境では永続ボリュームをマウントしてください

2. **WebSocket**
   - リバースプロキシ使用時はWebSocketの転送設定が必要です
   - Nginxの場合:
     ```nginx
     location /socket.io/ {
         proxy_pass http://localhost:3001;
         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
     }
     ```

3. **静的ファイル配信**
   - 本番環境ではサーバーから `client/dist/` を配信するか
   - CDNから静的ファイルを配信してください

## 📝 API エンドポイント

### REST API

| メソッド | パス | 説明 |
|---------|------|------|
| `POST` | `/api/auth/register` | 新規登録 |
| `POST` | `/api/auth/login` | ログイン |
| `POST` | `/api/auth/logout` | ログアウト |
| `GET` | `/api/me` | ログインユーザー取得 |
| `POST` | `/api/me/nickname` | ニックネーム更新 |
| `GET` | `/api/rooms` | ルーム一覧取得 |
| `GET` | `/api/rooms/:roomId` | ルーム詳細取得 |

### WebSocket Events

| イベント | 方向 | 説明 |
|---------|------|------|
| `room:join` | → Server | ルーム入室 |
| `room:leave` | → Server | ルーム退室 |
| `seat:take` | → Server | 着席 |
| `seat:leave` | → Server | 離席 |
| `game:ready` | → Server | 準備完了 |
| `game:place` | → Server | 駒を打つ |
| `game:move` | → Server | 駒を動かす |
| `chat:send` | → Server | チャット送信 |
| `cpu:configure` | → Server | CPU設定 |
| `rooms:update` | ← Server | ルーム一覧更新 |
| `room:state` | ← Server | ルーム状態更新 |
| `game:state` | ← Server | ゲーム状態更新 |
| `chat:new` | ← Server | 新着チャット |

## 🤖 CPU AI について

CPUは**ミニマックス法**（アルファベータ枝刈り）を使用して最善手を探索します。

| 難易度 | 探索深度 | 制限時間 |
|--------|---------|---------|
| Easy | 2 | 120ms |
| Normal | 3 | 240ms |
| Hard | 4 | 420ms |
| Strong | 5 | 700ms |

評価関数は以下の要素を考慮:
- **ラインスコア**: 連続した駒の数（4目リーチは高得点）
- **駒数スコア**: 盤面上の駒の差
- **機動力スコア**: 選択可能なアクション数

## 📜 ライセンス
ヨンモクゲームの原作は [logygames](https://www.logygames.com/yonmoque/) 様に帰属します。

## 🙏 クレジット

- ゲームデザイン: [logygames](https://www.logygames.com/yonmoque/)
- 開発: [ScriptArts](https://www.scriptarts.jp/)

