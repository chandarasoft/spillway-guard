# 가드 적합성 시험

모든 언어의 가드가 같은 결과를 내는지 확인합니다. 자세한 설명은 사내 문서 `spillway-docs/16-가드-포팅-검증.md`.

| 파일 | 내용 |
|---|---|
| `test-vectors.json` | 공통 테스트 벡터 (입장권 검증 15 · 서명 2 · 경로 패턴 17 · API 규칙 9). `npm run vectors` 로 공식 가드에서 다시 생성 |
| `vectors/VectorTest.java`, `vectors/vector-test.php` | 언어별 벡터 실행기 |
| `conformance.mjs` | 엔진 + 시험 사이트(127.0.0.1:8788)를 HTTP 로 두드리는 27개 시나리오. `--down` 은 엔진을 끈 뒤 fail-open 확인 |
| `sites/` | 언어별 시험 사이트 (통과하면 `SITE OK`, `/api/*` 는 `API OK`) |
| `run.sh` | 시험용 고객사 만들기 → 서명 키 받기 → 시험 사이트 실행 → 시나리오 실행 |

```bash
# spillway-engine 에서: npx wrangler dev --port 8787   (.dev.vars: ADMIN_KEY=test-admin-key)
npm install
node make-vectors.mjs | diff - test-vectors.json && echo "벡터 그대로"
php vectors/vector-test.php test-vectors.json
javac -d /tmp/j ../ports/java/SpillwayGuard.java vectors/VectorTest.java sites/TestSite.java
java -cp /tmp/j spillway.VectorTest test-vectors.json

./run.sh workers node sites/workers.mjs
./run.sh express node sites/express.mjs
./run.sh java    java -cp /tmp/j TestSite
PHP_CLI_SERVER_WORKERS=4 ./run.sh php php -S 127.0.0.1:8788 sites/router.php
MODE=--down ./run.sh php php -S 127.0.0.1:8788 sites/router.php   # 엔진을 끈 뒤
```
