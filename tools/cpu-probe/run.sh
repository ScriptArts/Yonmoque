#!/bin/bash
# 使い方: ./run.sh https://yonmoque-cpu-probe.<サブドメイン>.workers.dev
# 別のターミナルで `npx wrangler tail yonmoque-cpu-probe --format json > tail.json` を
# 走らせておくと、呼び出しごとの CPU 時間を parse-tail.py で表にできる。
# 各ノード数を3回ずつ、Worker / DO fetch / DO alarm で走らせて結果を表にする。
BASE="${1:?URL を指定してください}"
TMP=$(mktemp -d)
printf '%-8s %-8s %-6s %s\n' where nodes try result
for n in 1000 50000 500000; do
  for t in 1 2 3; do
    # Worker の fetch
    r=$(curl -s -o "$TMP/w" -w '%{http_code}' "$BASE/worker?nodes=$n"); printf '%-8s %-8s %-6s %s %s\n' worker $n $t "$r" "$(head -c 120 "$TMP/w")"
    # Durable Object の fetch
    r=$(curl -s -o "$TMP/d" -w '%{http_code}' "$BASE/do?nodes=$n"); printf '%-8s %-8s %-6s %s %s\n' do $n $t "$r" "$(head -c 120 "$TMP/d")"
    # Durable Object の alarm（仕掛けてから最大20秒結果を待つ）
    curl -s "$BASE/alarm?nodes=$n" >/dev/null
    for i in $(seq 1 20); do
      sleep 1
      res=$(curl -s "$BASE/result")
      case "$res" in *'"status":"done"'*) break;; esac
    done
    printf '%-8s %-8s %-6s %s\n' alarm $n $t "$res"
  done
done
