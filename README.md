# spillway-guard

사이트 Worker 에 붙이는 **페이지 진입형** 대기열 가드입니다. 의존성이 없고, GitHub 에서 바로 설치합니다.

## 동작

```
GET /reserve/... ─┬─ 보호 경로 아님 / 검색엔진 봇 / POST            → 통과
                  ├─ ?__spw=<토큰> (대기 후 복귀)                  → 쿠키 저장 후 깨끗한 URL 로 302
                  ├─ 유효한 쿠키 __spw_<room>                      → 통과
                  ├─ 대기실 꺼짐 / KV 오류 / 엔진 응답 없음           → 통과 (fail-open)
                  └─ 그 외                                         → 엔진 대기 화면으로 302
                                                                    (fetch/XHR 요청이면 429 + waitUrl)
```

## 사이트에 붙이기

**1. 설치** (태그로 버전 고정)
```bash
npm i github:chandarasoft/spillway-guard#v0.1.0
```
업데이트는 태그만 바꿔서 다시 설치합니다. (`#v0.2.0`)

**2. wrangler 설정에 바인딩 추가** (`examples/wrangler.example.jsonc` 참고)
```jsonc
"kv_namespaces": [{ "binding": "SPILLWAY_ROOMS", "id": "<엔진과 같은 KV id>" }],
"services": [{ "binding": "SPILLWAY_ENGINE", "service": "spillway-engine" }]
```

**3. 비밀값**: 엔진의 `TOKEN_SECRET` 과 **같은 값**
```bash
npx wrangler secret put SPILLWAY_TOKEN_SECRET
```
GitHub Actions 로 배포한다면 사이트 저장소의 wrangler-action 에 추가합니다.
```yaml
secrets: |
  SPILLWAY_TOKEN_SECRET
env:
  SPILLWAY_TOKEN_SECRET: ${{ secrets.SPILLWAY_TOKEN_SECRET }}
```

**4. fetch 맨 앞에서 호출** (`examples/site-worker.ts` 참고)
```ts
import { guardPage } from "spillway-guard";

const blocked = await guardPage(request, env, {
  room: "test",
  engineUrl: "https://spillway-engine.<계정>.workers.dev",
  protect: ["/reserve"],          // 접두사 또는 정규식
  exclude: ["/reserve/admin"],
});
if (blocked) return blocked;
// ...기존 처리
```
Hono 를 쓴다면 미들웨어로 넣으면 됩니다.
```ts
app.use("*", async (c, next) => (await guardPage(c.req.raw, c.env, SPILLWAY)) ?? next());
```

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `room` | (필수) | 엔진의 대기실 id |
| `engineUrl` | (필수) | 엔진 공개 URL |
| `protect` | (필수) | 대기열을 걸 경로. `"/reserve"` 는 `/reserve` 와 `/reserve/...` 에 매칭 (`/reserved` 는 아님) |
| `exclude` | `[]` | 제외 경로 (protect 보다 우선) |
| `bypassUserAgents` | 주요 검색엔진·미리보기 봇 | `null` 이면 봇도 줄 세움 |
| `healthCheck` | `true` | 엔진 `/health` 를 10초마다 확인, 응답 없으면 통과 |

## 개발과 릴리스

```bash
npm install
npm test          # 9개 테스트 (엔진과 공유하는 토큰 테스트 벡터 포함)
npm run typecheck
npm run build     # src → dist (JS + 타입 정의)
```

GitHub 설치는 저장소의 `dist/` 를 그대로 쓰므로, **소스를 고쳤으면 `npm run build` 후 `dist/` 도 함께 커밋**하세요. CI 가 `dist/` 가 소스와 다르면 실패시킵니다.

릴리스:
```bash
npm version patch      # package.json 버전 올리고 v0.1.1 태그 생성
git push --follow-tags # CI 통과 후 GitHub Release 자동 생성
```

나중에 npm 레지스트리로 옮길 때는 `name` 을 `@spillway/guard` 같은 scope 이름으로 바꾸고 `npm publish --access public` 하면 됩니다. 사용하는 쪽 import 경로만 바뀝니다.

토큰 형식은 `spillway-engine/src/token.ts` 와 같습니다. 바꿀 때는 두 곳을 함께 바꾸고 `SHARED_VECTOR` 테스트를 갱신하세요.
