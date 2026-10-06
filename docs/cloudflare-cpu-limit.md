# Cloudflare の CPU 時間制限の実測（2026-10-06）

CPU 対戦の探索量を決めるときの前提になる記録です。Workers 無料プランで、Durable Object（以下 DO）に「1リクエスト CPU 10ms」の制限がかかるかを実際に測りました。

## 結論

- **無料プランでも、DO の fetch と alarm に 10ms 制限はかからない。** CPU 約3秒の処理が3回とも最後まで走った。
- 普通の Worker の fetch は、CPU 1.2〜2秒で `exceededCpu`（Error 1102）になった。10ms ちょうどで止まるわけではないが、制限そのものは効いている。
- 本番の CPU は手元の Mac（Apple Silicon、Node 24）より約3倍遅い。探索1ノードあたり、Mac は約2µs、本番の DO は約6µs。

2026-10-06 より前のコード（ai.js、room-do.js、wrangler.jsonc、README）は「DO のアラームも1回 10ms まで」という前提で書かれていた。CPU の思考を複数のアラーム（ティック）に分け、1ティックの探索量を Mac での実測が数 ms に収まるよう絞っていたのはそのため。この前提は誤りだった。

## 公式ドキュメントの記述は食い違っている

計測した理由は、Cloudflare の公式ドキュメントからは答えが決まらなかったため。2026-10-06 時点の原文は次のとおり。

10ms がかかると読める記述:

- [Durable Objects / Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) の冒頭: "Durable Objects are a special kind of Worker, so Workers Limits apply according to your Workers plan."
- [Durable Objects / FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/): "Durable Objects are Worker scripts, and have the same per invocation CPU limits as any Workers do."（リンク先は Free 10 ms / Paid 5 min の表）

30秒と読める記述:

- 同じ Limits ページの表: "CPU per request | 30 seconds (default) / configurable to 5 minutes of active CPU time"。同じ表のクラス数とストレージには Free 用の別の値があるが、CPU の行には無い。
- 同じ FAQ の続き: "By default, the maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds"
- [Workers / Limits](https://developers.cloudflare.com/workers/platform/limits/) の CPU 時間の表には "HTTP request" と "Cron Trigger" の2行しかなく、DO やアラームの行は無い。

ドキュメントのリポジトリ（cloudflare/cloudflare-docs）の履歴では、30秒の行は DO が有料プラン専用だった2025年3月に書かれ、2025年4月の無料プラン開放時にも CPU の行だけは変更されていない。

## 計測方法

計測用 Worker は [tools/cpu-probe/](../tools/cpu-probe/) にある。本番とは別名（`yonmoque-cpu-probe`）でデプロイし、計測後に削除した。

- 本番と同じ `worker/src/ai.js` の `searchBestMove` を、固定の中盤局面で、指定したノード数だけ探索させる。
- 同じ処理を3か所で実行する。
  - `/worker`: 普通の Worker の fetch（無料プランなら 10ms 制限の対象。対照実験）
  - `/do`: DO の fetch
  - `/alarm`: DO の alarm。結果をストレージに残し、`/result` で成否を確かめる
- ノード数は 1,000 / 50,000 / 500,000 を各3回。
- CPU 時間は `wrangler tail --format json` の `cpuTime` と `outcome` で取った。Workers のコード内では `Date.now()` も `performance.now()` も同期処理の途中で進まないため、コード内では測れない。
- アカウントは ScriptArts（Workers 無料プラン）。Worker の fetch が約2秒で `exceededCpu` になったことから、有料プラン（既定の上限30秒）ではないことも確認できる。

## 結果

CPU 時間（ms）。括弧内は結果。

| 実行場所 | 1,000ノード | 50,000ノード | 500,000ノード |
|---|---|---|---|
| Worker の fetch | 52 / 46 / 56（ok） | 1,215 / 872 / 518（ok） | 2,038 / 2,012 / 1,167（**exceededCpu**、HTTP 503 / Error 1102） |
| DO の fetch | 60 / 13 / 20（ok） | 366 / 253 / 250（ok） | 2,927 / 2,797 / 2,984（ok） |
| DO の alarm | 21 / 7 / 9（ok） | 3回とも1回目の試行で完了。CPU 時間はログに出なかった | 3,081 / 3,131 / 3,166（ok） |

同じ局面・同じノード数を手元の Mac（Node 24）で実行した場合は、5,000ノードが約10ms、50,000ノードが約97ms、500,000ノードが約980ms。

## 読み取れること

- DO は fetch でも alarm でも、少なくとも CPU 3秒までは問題なく動く。公式ドキュメントの「既定30秒」が無料プランにも当てはまっていると考えてよい。
- 普通の Worker の 10ms 制限は厳密ではなく、1秒を超える呼び出しが通ることもある。ただし同じ処理を続けると止められた。当てにしてはいけない。
- 本番の CPU は Mac より遅い。温まった状態で約3倍。呼び出しの最初のほうは JIT が効かないぶんさらに遅く、1,000ノードでも 7〜60ms かかった。Mac で測った CPU 時間を本番の見積もりに使うときは3倍以上を見込むこと。
- 2026-10-06 以前の Strong は1ティック1,800ノードで、Mac では 4ms 以内だった。本番ではおそらく毎回 10ms を超えていたが、DO に 10ms 制限が無いので問題にならなかったと考えられる（本番の yonmoque そのものは測っていない）。

## 設計への指針

- CPU 対戦の思考は、10ms に収めるためにティックへ分割する必要は無い。1回のアラームで読み切ってよい。
- ただし DO は1スレッドなので、思考中はそのルームのほかのイベント（チャット、相手の操作、入退室）が待たされる。1手あたり CPU 数百 ms 程度に抑える。
- 上限は DO の既定 30秒。30秒を超えて計算し続けると DO が退避（evict）されやすくなるとドキュメントにある。
- 無料プランの1日あたりの枠（DO のリクエスト 100,000件、Duration 13,000 GB-s、SQLite の書き込み 100,000行）は CPU 時間とは別に効く。アラームを細かく刻むほどリクエストと書き込みが増える。

## この結果を受けた変更（2026-10-06）

- CPU の思考をティックに分けるのをやめ、ルームの DO のアラーム1回で1手を読み切る形にした（`worker/src/room-do.js` の `runCpuTurn`）。
- Strong の探索量を1手 30,000ノードにした。手元の Mac で1手 中央値30ms・p95 37ms・最大73ms。本番ではこの約3倍の見込み。
- 同時に探索の不具合2つ（1ティックで1つの深さしか読まない、予算切れのとき深さ1の評価値を深い評価値と比べてしまう）を直し、評価関数を高速化した。
- 自己対戦（ランダム序盤60通り×先後入れ替えの120局）で、新しい Strong は以前の Strong に 89.2% / 92.5%（序盤の乱数を変えた2回）勝った。

## まだ確かめていないこと

- 30秒の上限そのもの。試したのは最大で CPU 約3.2秒まで。
- WebSocket メッセージのハンドラでの上限。ドキュメント上は同じく30秒。
- 日や時間帯による差。計測は2026-10-06の1回だけ。Cloudflare が今後制限を変える可能性もある。

## 再現手順

`worker/` の wrangler を使う（wrangler 4.126.0 で確認）。

```bash
cd worker
npx wrangler login                                   # 未ログインなら
npx wrangler deploy -c ../tools/cpu-probe/wrangler.jsonc

# 別のターミナルで CPU 時間のログを取る
npx wrangler tail yonmoque-cpu-probe --format json > tail.json

# デプロイで表示された URL に対して計測する（3〜5分かかる）
../tools/cpu-probe/run.sh https://yonmoque-cpu-probe.<サブドメイン>.workers.dev

# 呼び出しごとの CPU 時間を表にする
python3 ../tools/cpu-probe/parse-tail.py tail.json

# 後片付け
npx wrangler delete -c ../tools/cpu-probe/wrangler.jsonc
```

計測用 Worker は本番と同じ `worker/src/ai.js` を読み込むので、ai.js を変えると1ノードあたりの CPU 時間も変わる。上の結果表は 2026-10-06 時点の ai.js（コミット 1028189）での値。

`tail.json` にはアクセス元の IP アドレスなどが含まれるので、リポジトリに入れないこと。
