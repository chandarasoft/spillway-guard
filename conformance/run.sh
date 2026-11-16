#!/usr/bin/env bash
# 사용법: ./run.sh <이름> <시험 사이트 실행 명령…>
#   엔진을 먼저 띄워 두세요 (spillway-engine: npx wrangler dev --port 8787, .dev.vars 의 ADMIN_KEY).
#   MODE=--down ./run.sh …  → 엔진을 끈 상태에서 fail-open 확인
set -u
name=$1; shift
export E=${E:-http://127.0.0.1:8787} T=${T:-conf} ADMIN_KEY=${ADMIN_KEY:-test-admin-key}
# 시험용 고객사(conf)를 만들고 서명 키를 받아 시험 사이트에 넘김
if [ "${MODE:-}" != "--down" ]; then
  curl -s -X PUT "$E/admin/tenants/$T/config" -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"version\":1,\"tenant\":{\"enabled\":true,\"keyVersion\":1,\"origins\":[\"http://localhost:8788\"]},\"rooms\":{}}" > /dev/null
  export SPILLWAY_TOKEN_SECRET=$(curl -s "$E/admin/tenants/$T/key" -H "x-admin-key: $ADMIN_KEY" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).key))')
  echo "$SPILLWAY_TOKEN_SECRET" > .last-key
else
  export SPILLWAY_TOKEN_SECRET=$(cat .last-key)
fi
"$@" > ".site-$name.log" 2>&1 &
pid=$!
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:8788/about && break; sleep 0.3; done
echo "== $name"
node "$(dirname "$0")/conformance.mjs" ${MODE:-}
code=$?
kill $pid 2>/dev/null; wait $pid 2>/dev/null
exit $code
