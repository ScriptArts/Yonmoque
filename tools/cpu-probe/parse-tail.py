# wrangler tail --format json の出力（整形済みJSONの連結）を読み、呼び出しごとのCPU時間を表にする
# 使い方: python3 parse-tail.py tail.json
import json, sys
from urllib.parse import urlparse, parse_qs
text = open(sys.argv[1]).read()
dec = json.JSONDecoder(); i = 0; events = []
while True:
    while i < len(text) and text[i].isspace(): i += 1
    if i >= len(text): break
    obj, i = dec.raw_decode(text, i); events.append(obj)
rows = []
for e in events:
    ev = e.get('event') or {}
    if 'request' in ev:
        u = urlparse(ev['request']['url']); kind = u.path; nodes = parse_qs(u.query).get('nodes', [''])[0]
    elif 'scheduledTime' in ev:
        kind = 'alarm()'; nodes = ''
    else:
        kind = '?' + ','.join(ev.keys()); nodes = ''
    rows.append((e.get('eventTimestamp'), e.get('executionModel'), kind, nodes, e.get('outcome'), e.get('cpuTime'), e.get('wallTime')))
rows.sort(key=lambda r: r[0] or 0)
print(f"{'model':<14}{'event':<10}{'nodes':>8} {'outcome':<12}{'cpu ms':>7}{'wall ms':>8}")
for r in rows:
    if r[2] == '/result': continue
    print(f"{str(r[1]):<14}{r[2]:<10}{r[3]:>8} {str(r[4]):<12}{str(r[5]):>7}{str(r[6]):>8}")
