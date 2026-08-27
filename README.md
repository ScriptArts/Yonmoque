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

| 技術 | 用途 |
|------|------|
| Cloudflare Workers | 実行環境（サーバーレス） |
| Durable Objects | ルーム状態・対局・チャット・WebSocket接続の保持 |
| Cloudflare D1 | ユーザー情報の永続化（SQLite） |
| WebSocket (生) | リアルタイム通信 |
| Web Crypto | パスワードハッシュ(PBKDF2)・セッション署名(HMAC) |

> Worker 側は **外部ライブラリを一切使っていません**（`wrangler` のみ開発依存）。

### アーキテクチャ

```
Cloudflare Worker
├── 静的アセット  → client/dist を同一オリジンで配信（SPAフォールバック）
├── /api/*        → D1（ユーザー）/ Durable Object（ルーム情報）
└── /ws           → WebSocket を Durable Object へ橋渡し

Durable Objects
├── RoomDurableObject   … 1ルーム1インスタンス。座席・対局・チャット・CPU思考・接続を保持
└── LobbyDurableObject  … 全ルームのサマリを集約し、ロビーへ配信
```

対局状態は Durable Object に永続化されるため、デプロイやアイドルを挟んでも失われません。
フロントとバックが同一オリジンなので、CORS 設定やクロスサイトCookieは不要です。

## 🚀 セットアップ

### 必要条件

- Node.js 20.x 以上
- Cloudflare アカウント（無料プランで動作します）

### インストール

```bash
git clone https://github.com/your-username/yonmoque.git
cd yonmoque

npm install
npm --prefix client install
npm --prefix worker install
```

### D1 データベースの作成

```bash
cd worker

# 1. データベースを作成し、表示された database_id を wrangler.jsonc に貼り付ける
npx wrangler d1 create yonmoque

# 2. テーブルを作成（ローカル用と本番用）
npx wrangler d1 execute yonmoque --local  --file schema.sql
npx wrangler d1 execute yonmoque --remote --file schema.sql
```

### ローカル開発

```bash
# クライアントをビルドしてから wrangler dev を起動
npm run dev
```

→ http://localhost:8787

`wrangler dev` は D1 も Durable Objects もローカルでエミュレートするため、
Cloudflare へ接続せずに全機能を試せます。

フロントを Vite の HMR で開発したい場合:

```bash
npm run dev:vite      # worker(8787) と vite(5173) を同時起動
```

Vite が `/api` と `/ws` を 8787 へプロキシします。

> デモユーザーを作るスクリプトはありません。画面から新規登録してください。

## ⚙️ 設定

設定は `worker/wrangler.jsonc` の `vars` に記述します。

| 変数名 | 既定値 | 説明 |
|--------|--------|------|
| `ROOM_COUNT` | `12` | 作成するルーム数 |
| `CPU_MAX_DEPTH` | `2` | CPU探索の最大深度（上限として作用） |
| `CPU_TIME_LIMIT_MS` | `8` | CPU探索の制限時間（上限として作用） |
| `PBKDF2_ITERATIONS` | `100000` | パスワードハッシュの反復回数 |

`SESSION_SECRET` だけは Secret として登録します。

```bash
cd worker
npx wrangler secret put SESSION_SECRET      # openssl rand -base64 32 などで生成
```

> ローカル開発では未設定でも動きます（開発用の既定値が使われます）。

### CPUの強さと料金プラン

Workers の **無料プランは 1リクエストあたり CPU 10ms** の制限があります。
既定値（深さ2 / 8ms）はこの枠に収まるよう絞ってあります。

**Workers 有料プラン（$5/月）** に切り替えると CPU 時間が 30秒 まで伸びるので、
`wrangler.jsonc` を次のように変えるだけで本来の強さに戻ります。

```jsonc
"CPU_MAX_DEPTH": "5",
"CPU_TIME_LIMIT_MS": "700"
```

## 🌐 デプロイ

```bash
# クライアントをビルドして Worker ごとデプロイ
npm run deploy
```

初回のみ、事前に以下を済ませておいてください。

1. `npx wrangler d1 create yonmoque` で作った `database_id` を `worker/wrangler.jsonc` に反映
2. `npx wrangler d1 execute yonmoque --remote --file schema.sql` でテーブル作成
3. `npx wrangler secret put SESSION_SECRET` で署名鍵を登録

### 自動デプロイ（Workers Builds）

`main` への push で自動デプロイするには、Cloudflare ダッシュボードで
Git 連携を設定します（**Workers & Pages > yonmoque > Settings > Builds > Connect**）。

| 設定項目 | 値 |
|---------|-----|
| Root directory | `worker` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

`worker/package.json` の `build` スクリプトがクライアントの lint とビルドを行い、
`wrangler.jsonc` の `assets.directory`（`../client/dist`）がその成果物を配信します。
lint かビルドが失敗した場合はデプロイされません。

GitHub App のインストールには、対象 organization の owner または
GitHub Apps Manager 権限が必要です。

**注意点**

- ダッシュボードの Worker 名と `wrangler.jsonc` の `name` が一致していないとビルドが失敗します（どちらも `yonmoque`）
- Durable Object を使う Worker のため、本番以外のブランチではプレビューURLが生成されません
- **D1 のスキーマ変更は自動適用されません。** テーブル定義を変えたときは `npm run db:remote` を手動で実行してください

### 注意事項

1. **永続化の範囲**
   - ユーザー情報は D1（`users` テーブル）
   - ルーム・座席・対局・チャットは Durable Object のストレージ
   - チャットは最終発言から30分で自動削除されます

2. **無料プランの上限**
   - Durable Objects: 10万リクエスト/日（WebSocketのメッセージも消費します）
   - Durable Objects は **SQLiteバックエンドのみ**利用可能（設定済み）

3. **Durable Object の配置**
   - 最初にアクセスされた地域の近くに作られ、以後そこに固定されます

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

`/ws?roomId=N`（対局ルーム）と `/ws?lobby=1`（ロビー）の2種類の接続があります。
メッセージ形式は Socket.io 互換ではなく、以下の最小プロトコルです。

```
送信 { t: 'req', id, event, payload }   // id を付けると ack が返る
受信 { t: 'res', id, payload }          // ack
受信 { t: 'ev',  event, payload }       // サーバーからのプッシュ
```

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
| `chat:cleared` | ← Server | チャット履歴の期限切れ |
| `room:presence` | ← Server | 在室人数の更新 |
| `room:forfeit` | ← Server | 対局中の離脱（不戦敗） |

## 🤖 CPU AI について

CPUは**ミニマックス法**（アルファベータ枝刈り）を使用して最善手を探索します。

| 難易度 | 探索深度 | 制限時間 |
|--------|---------|---------|
| Easy | 2 | 120ms |
| Normal | 3 | 240ms |
| Hard | 4 | 420ms |
| Strong | 5 | 700ms |

上の値は「難易度ごとの上限」で、実際には `CPU_MAX_DEPTH` / `CPU_TIME_LIMIT_MS` で
さらに切り詰められます（無料プランの既定は深さ2 / 8ms）。

評価関数は以下の要素を考慮:
- **ラインスコア**: 連続した駒の数（4目リーチは高得点）
- **駒数スコア**: 盤面上の駒の差
- **機動力スコア**: 動かせる先の空きマス数と打てる手数の概算

手番のプレイヤーに合法手が無い場合は自動的にパスし、双方とも手が無ければ引き分けになります。

## 📜 ライセンス
ヨンモクゲームの原作は [logygames](https://www.logygames.com/yonmoque/) 様に帰属します。

## 🙏 クレジット

- ゲームデザイン: [logygames](https://www.logygames.com/yonmoque/)
- 開発: [ScriptArts](https://www.scriptarts.jp/)

