# yonmoque

## Cloudflare の CPU 時間制限

Workers 無料プランで動かしている。CPU 時間の制限は実行場所によって違う。2026-10-06 に実測した。

- 普通の Worker（`worker/src/index.js` の fetch）は 10ms 制限の対象。
- Durable Object（`RoomDurableObject` / `LobbyDurableObject`）の fetch と alarm には 10ms 制限がかからない。CPU 約3秒の処理が通ることを確認した。ドキュメント上の上限は既定30秒。
- 本番の CPU は手元の Mac より約3倍遅い。Mac で測った CPU 時間から本番を見積もるときは3倍以上を見込む。

計測方法、生の数値、まだ確かめていないことは [docs/cloudflare-cpu-limit.md](docs/cloudflare-cpu-limit.md) にある。計測用 Worker は [tools/cpu-probe/](tools/cpu-probe/)。
