# spillway-guard

사이트 Worker 에 붙이는 **페이지 진입형** 대기열 가드입니다. 의존성이 없고, GitHub 에서 바로 설치합니다.

## 동작

```
GET /reserve/... ─┬─ 보호 경로 아님 / 검색엔진 봇 / POST            → 통과
                  ├─ ?__spw=<토큰> (대기 후 복귀)                  → 쿠키 저장 후 깨끗한 URL 로 302
                  ├─ 유효한 쿠키 __spw_<tenant>_<room>             → 통과 (엔진 호출 없음)
                  ├─ 엔진 /check: 꺼짐 / 대기실 없음 / 응답 없음     → 통과 (fail-open)
                  └─ 그 외                                         → 엔진 대기 화면으로 302
                                                                    (fetch/XHR 요청이면 429 + waitUrl)
```

- 입장 토큰은 **고객사 서명 키**로 검증합니다. 다른 고객사의 키로 만든 토큰, 다른 대기실의 토큰은 통과하지 못합니다.
- 대기실 on/off 는 엔진의 `GET /q/{tenant}/{room}/check` 로 확인합니다 (헬스체크 겸용, Worker 인스턴스마다 10초 캐시). 사이트 쪽에 KV 설정이 필요 없습니다.

## 사이트에 붙이기

**1. 설치** (태그로 버전 고정)
```bash
npm i github:chandarasoft/spillway-guard#v0.2.0
```

**2. 고객사 서명 키 받기**: Spillway 운영자가 엔진에서 조회해 전달합니다.
```bash
curl -H "x-admin-key: <ADMIN_KEY>" https://spillway-engine.<계정>.workers.dev/admin/tenants/<tenant>/key
# → {"tenantId":"...","keyVersion":1,"key":"..."}
```

**3. 사이트 Worker 설정** (`examples/wrangler.example.jsonc` 참고)
```jsonc
"vars": { "SPILLWAY_ENGINE_URL": "https://spillway-engine.<계정>.workers.dev" },
// (선택) 엔진과 같은 Cloudflare 계정일 때만
"services": [{ "binding": "SPILLWAY_ENGINE", "service": "spillway-engine" }]
```
```bash
npx wrangler secret put SPILLWAY_TOKEN_SECRET   # 2번에서 받은 key
```
GitHub Actions 로 배포한다면 배포 워크플로의 secret 목록에 `SPILLWAY_TOKEN_SECRET` 을 추가하세요.

**4. fetch 맨 앞에서 호출** (`examples/site-worker.ts` 참고)
```ts
import { guardPage } from "spillway-guard";

const blocked = await guardPage(request, env, {
  tenant: "chandarasoft",
  room: "test",
  engineUrl: env.SPILLWAY_ENGINE_URL,
  protect: ["/reserve"],          // 접두사 또는 정규식
  exclude: ["/reserve/admin"],
});
if (blocked) return blocked;
// ...기존 처리
```
Hono 를 쓴다면 미들웨어로 넣으면 됩니다.
```ts
app.use("*", async (c, next) => (await guardPage(c.req.raw, c.env, { ...SPILLWAY, engineUrl: c.env.SPILLWAY_ENGINE_URL })) ?? next());
```

⚠️ 보호할 페이지가 **정적 파일(Workers Assets)** 이면 Worker 가 실행되지 않아 가드가 동작하지 않습니다. wrangler 설정의 `assets.run_worker_first` 에 그 경로를 넣으세요. (예: `["/", "/index.html"]`)

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `tenant` | (필수) | 고객사 id |
| `room` | (필수) | 대기실 id |
| `engineUrl` | (필수) | 엔진 공개 URL |
| `protect` | (필수) | 대기열을 걸 경로. `"/reserve"` 는 `/reserve` 와 `/reserve/...` 에 매칭 (`/reserved` 는 아님). `"/"` 는 모든 경로에 매칭되므로 루트만 걸려면 `/^\/$/` |
| `exclude` | `[]` | 제외 경로 (protect 보다 우선) |
| `bypassUserAgents` | 주요 검색엔진·미리보기 봇 | `null` 이면 봇도 줄 세움 |
| `checkTtlMs` | `10000` | 엔진 `/check` 결과 캐시 시간 |

## v0.1 → v0.2 변경점

- `tenant` 옵션 추가 (필수). 엔진 URL 이 `/q/{tenant}/{room}` 으로 바뀜
- `SPILLWAY_ROOMS` KV 바인딩 제거 → 엔진 `/check` API 사용. `healthCheck` 옵션 제거 (`/check` 가 대신함)
- `SPILLWAY_TOKEN_SECRET` 은 엔진 마스터 키가 아니라 **고객사 서명 키**
- 쿠키 이름 `__spw_<room>` → `__spw_<tenant>_<room>`

## 개발과 릴리스

```bash
npm install
npm test          # 12개 테스트 (엔진과 공유하는 토큰 테스트 벡터 포함)
npm run typecheck
npm run build     # src → dist (JS + 타입 정의)
```

GitHub 설치는 저장소의 `dist/` 를 그대로 쓰므로, **소스를 고쳤으면 `npm run build` 후 `dist/` 도 함께 커밋**하세요. CI 가 `dist/` 가 소스와 다르면 실패시킵니다.

릴리스:
```bash
git tag -a v0.2.0 -m "v0.2.0"   # package.json 의 version 과 맞추기 (-a: 주석 태그)
git push --follow-tags          # 커밋과 주석 태그를 함께 푸시 → CI 통과 후 GitHub Release 자동 생성
```
`git tag v0.2.0` 처럼 `-a` 없이 만든 태그는 `--follow-tags` 로 올라가지 않습니다. 그럴 때는 `git push origin v0.2.0` 으로 태그를 직접 푸시하세요.

나중에 npm 레지스트리로 옮길 때는 `name` 을 `@spillway/guard` 같은 scope 이름으로 바꾸고 `npm publish --access public` 하면 됩니다.
