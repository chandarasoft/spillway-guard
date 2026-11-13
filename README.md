# spillway-guard

사이트 Worker 에 붙이는 **페이지 진입형** 대기열 가드입니다. 의존성이 없고, GitHub 에서 바로 설치합니다.

## 동작

```
GET 요청 ─┬─ 정적 파일(CSS·JS·이미지·폰트…) / 검색엔진 봇 / POST       → 통과 (엔진 호출 없음)
          ├─ 엔진 규칙(/q/{tenant}/rules)에 맞는 대기실 없음             → 통과
          ├─ ?__spw=<토큰> (대기 후 복귀)                              → 쿠키 저장 후 깨끗한 URL 로 302
          ├─ 유효한 쿠키 __spw_<tenant>_<room>                         → 통과
          ├─ 대기실 꺼짐 / 엔진 응답 없음                               → 통과 (fail-open)
          └─ 그 외                                                     → 엔진 대기 화면으로 302
                                                                        (fetch/XHR 요청이면 429 + waitUrl)
```

- **어느 URL 에 어느 대기실을 걸지는 엔진의 대기실 설정**(`tenants/{tenant}/rooms/*.json` 의 `match`)에서 정합니다. 가드는 규칙 목록을 Worker 인스턴스마다 10초간 캐시합니다. 설정을 바꾸면 사이트를 다시 배포하지 않아도 약 1분 안에 반영됩니다.
- 입장 토큰은 **고객사 서명 키**로 검증합니다. 다른 고객사의 키로 만든 토큰, 다른 대기실의 토큰은 통과하지 못합니다.

## 사이트에 붙이기

**1. 설치** (태그로 버전 고정)
```bash
npm i github:chandarasoft/spillway-guard#v0.4.0
```

**2. 고객사 서명 키 받기**: Spillway 운영자가 엔진에서 조회해 전달합니다.
```bash
curl -H "x-admin-key: <ADMIN_KEY>" https://spillway-engine.<계정>.workers.dev/admin/tenants/<tenant>/key
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

**4. fetch 맨 앞에서 호출** (`examples/site-worker.ts` 참고)
```ts
import { guardPage } from "spillway-guard";

const blocked = await guardPage(request, env, { tenant: "chandarasoft", engineUrl: env.SPILLWAY_ENGINE_URL });
if (blocked) return blocked;
// ...기존 처리
```
Hono 를 쓴다면:
```ts
app.use("*", async (c, next) => (await guardPage(c.req.raw, c.env, { tenant: "chandarasoft", engineUrl: c.env.SPILLWAY_ENGINE_URL })) ?? next());
```

**5. 보호할 페이지가 정적 파일(Workers Assets)이라면** Worker 가 실행되지 않아 가드가 동작하지 않습니다. wrangler 설정의 `assets.run_worker_first` 에 그 경로를 넣으세요.
```jsonc
"assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/", "/index.html", "/l/*"] }
```
`["/*"]` 로 두면 엔진 설정만으로 어느 경로든 걸 수 있습니다. 대신 정적 파일 요청도 Worker 를 거쳐 Worker 요청(100만 건당 약 $0.30)으로 계산됩니다. 가드는 정적 파일을 엔진에 묻지 않고 바로 통과시키므로 속도 영향은 거의 없습니다.

## URL 규칙 (엔진 대기실 설정)

```jsonc
// spillway-engine/tenants/chandarasoft/rooms/main.json
{
  "mode": "page",
  "match": ["/", "/index.html", "/l/*"],
  "exclude": ["/l/admin*"],
  "admitPerSec": 5
}
```

| 패턴 | 매칭 | 매칭 안 됨 |
|---|---|---|
| `/` | `/` | `/a` |
| `/l/*` | `/l/1`, `/l/1/x` | `/l` |
| `/event*` | `/event`, `/events`, `/event/1` | |
| `/sale/*/detail` | `/sale/1/detail` | |

- `*` 는 `/` 를 포함한 모든 문자에 매칭됩니다. 쿼리 문자열(`?a=b`)은 보지 않습니다.
- 여러 대기실이 같은 경로에 맞으면 **파일 이름 순서상 먼저인 대기실**이 적용됩니다.
- `mode` 는 지금 `page`(단일 페이지)만 지원합니다. `flow`(구간), `action`(이벤트)은 예약된 이름이며 가드가 무시합니다.

## 정적 파일 자동 통과

규칙과 상관없이 아래 요청은 엔진에 묻지 않고 바로 통과합니다 (`skipStatic: false` 로 끌 수 있음).
- 브라우저가 보낸 요청 종류(`Sec-Fetch-Dest`)가 `style`, `script`, `image`, `font`, `audio`, `video`, `manifest` 등
- 확장자가 `css`, `js`, `mjs`, `map`, `wasm`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`, `ttf`, `otf`, `mp4`, `webm`, `mp3`, `pdf`, `txt`, `xml` 등

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `tenant` | (필수) | 고객사 id |
| `engineUrl` | (필수) | 엔진 공개 URL |
| `room` + `protect` | — | 엔진 규칙 대신 **코드로 규칙을 정할 때** (v0.2 방식). `protect` 의 문자열은 접두사, 정규식도 가능 |
| `exclude` | `[]` | 코드 규칙의 제외 경로 |
| `bypassUserAgents` | 주요 검색엔진·미리보기 봇 | `null` 이면 봇도 줄 세움 |
| `skipStatic` | `true` | 정적 파일 자동 통과 |
| `cacheTtlMs` | `10000` | 엔진 규칙·상태 캐시 시간 |
| `siteOrigin` | — | 방문자가 보는 사이트 주소 (예: `https://www.example.com`). CloudFront 등 프록시 뒤에 있어 Worker 가 받는 주소가 `*.workers.dev` 일 때 지정 → 대기 후 돌아갈 주소를 이 origin 으로 만듦 |

## CDN·프록시 뒤에서 쓸 때 (CloudFront 등)

방문자 → CloudFront → `*.workers.dev` 처럼 앞단 프록시가 있으면 Worker 는 workers.dev 주소로 요청을 받습니다.
- `siteOrigin` 에 방문자 주소를 넣어 주세요. 안 넣으면 대기 후 workers.dev 주소로 돌아갑니다.
- 엔진 고객사 설정의 **허용 사이트**에 그 주소를 넣어야 합니다.
- 프록시가 **쿼리 문자열(`__spw`)과 쿠키(`__spw_*`)를 Worker 로 전달**해야 하고, 대기열이 걸린 페이지(HTML)를 **캐시하지 않아야** 합니다. 캐시된 HTML 이 나가면 가드를 거치지 않습니다.

## 버전별 변경점

**v0.4.0**
- `siteOrigin` 옵션 추가 (CDN·프록시 뒤 사이트)
- 토큰을 쿠키로 바꾼 뒤의 리다이렉트를 상대 주소로 (프록시 뒤에서도 방문자 주소 유지)


**v0.3.0**
- URL 규칙을 엔진 대기실 설정(`match`/`exclude`)에서 받아 옴 → 사이트 코드에는 `tenant` 와 `engineUrl` 만
- 정적 파일 자동 통과 (`skipStatic`)
- `room` 이 선택 옵션이 됨 (코드 규칙을 쓸 때만). `checkTtlMs` → `cacheTtlMs`

**v0.2.0**
- `tenant` 옵션 추가, 엔진 URL `/q/{tenant}/{room}`
- `SPILLWAY_ROOMS` KV 바인딩 제거 → 엔진 API 사용
- `SPILLWAY_TOKEN_SECRET` 은 고객사 서명 키, 쿠키 이름 `__spw_<tenant>_<room>`

## 개발과 릴리스

```bash
npm install
npm test          # 15개 테스트 (엔진과 공유하는 토큰 테스트 벡터 포함)
npm run typecheck
npm run build     # src → dist (JS + 타입 정의)
```

GitHub 설치는 저장소의 `dist/` 를 그대로 쓰므로, **소스를 고쳤으면 `npm run build` 후 `dist/` 도 함께 커밋**하세요. CI 가 `dist/` 가 소스와 다르면 실패시킵니다.

릴리스:
```bash
git tag -a v0.4.0 -m "v0.4.0"   # package.json 의 version 과 맞추기 (-a: 주석 태그)
git push --follow-tags          # 커밋과 주석 태그를 함께 푸시 → CI 통과 후 GitHub Release 자동 생성
```
`git tag v0.4.0` 처럼 `-a` 없이 만든 태그는 `--follow-tags` 로 올라가지 않습니다. 그럴 때는 `git push origin v0.4.0` 으로 태그를 직접 푸시하세요.
