# spillway-guard

사이트 Worker 에 붙이는 **페이지 진입형** 대기열 가드입니다. 의존성이 없고, GitHub 에서 바로 설치합니다.

> **Cloudflare Workers 가 아닌 사이트**(Spring Boot·전자정부·PHP·Express·Next.js)는 [`ports/`](ports/) 의 서버 가드를 씁니다. 모든 구현은 [`conformance/`](conformance/) 의 공통 테스트 벡터·적합성 시험을 통과합니다.

## 동작

```
GET 요청 ─┬─ 정적 파일(확장자) / Cloudflare 검증 검색 봇 / POST       → 통과 (엔진 호출 없음)
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
npm i github:chandarasoft/spillway-guard#v0.6.2
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

**4. 사이트 처리를 감싸기** (`examples/site-worker.ts` 참고) — 권장 (v0.6.0)
```ts
import { withSpillway } from "spillway-guard";

export default {
  fetch: (request, env) =>
    withSpillway(request, env, { tenant: "chandarasoft", engineUrl: env.SPILLWAY_ENGINE_URL }, (req) => handleNormally(req, env)),
};
```
바로 들어갈 수 있으면(입장 인원 제한: 자리가 있을 때, 입장 속도 제한: 기다리는 사람이 없고 속도 여유가 있을 때) 대기 화면 없이 `handleNormally` 의 응답에 입장 쿠키를 붙여 보냅니다.

기존처럼 **fetch 맨 앞에서 호출**해도 됩니다 (자리가 있으면 쿠키를 심고 같은 주소로 한 번 302):
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
- 확장자가 `css`, `js`, `mjs`, `map`, `wasm`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`, `ttf`, `otf`, `mp4`, `webm`, `mp3`, `pdf`, `txt`, `xml` 등
- 요청 헤더(`Sec-Fetch-Dest`)는 보지 않습니다 (v0.6.2 — 매크로가 위장할 수 있음). 확장자 없는 이미지 주소(`/img?id=3`)가 대기열 적용 경로 아래에 있으면, 입장 쿠키가 없는 요청은 대기 화면으로 갑니다.

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `tenant` | (필수) | 고객사 id |
| `engineUrl` | (필수) | 엔진 공개 URL |
| `room` + `protect` | — | 엔진 규칙 대신 **코드로 규칙을 정할 때** (v0.2 방식). `protect` 의 문자열은 접두사, 정규식도 가능 |
| `exclude` | `[]` | 코드 규칙의 제외 경로 |
| `bypassVerifiedBots` | `true` | Cloudflare 가 검증한 검색엔진·링크 미리보기 봇(`request.cf.verifiedBotCategory`)은 통과. 위장 불가 |
| `bypassUserAgents` | 없음 (v0.6.2) | 통과시킬 User-Agent 정규식. User-Agent 는 위장할 수 있어 매크로가 대기열을 건너뛸 수 있음 — 위험을 알고 쓸 때만 |
| `skipStatic` | `true` | 정적 파일 자동 통과 |
| `cacheTtlMs` | `10000` | 엔진 규칙·상태 캐시 시간 |
| `serverEnter` | `true` | 가드가 먼저 엔진 `/enter` 로 바로 입장을 시도 (입장 방식 상관없이, v0.6.1). `false` 면 항상 대기 화면을 거침 |
| `siteOrigin` | — | 방문자가 보는 사이트 주소 (예: `https://www.example.com`). CloudFront 등 프록시 뒤에 있어 Worker 가 받는 주소가 `*.workers.dev` 일 때 지정 → 대기 후 돌아갈 주소를 이 origin 으로 만듦 |

## CDN·프록시 뒤에서 쓸 때 (CloudFront 등)

방문자 → CloudFront → `*.workers.dev` 처럼 앞단 프록시가 있으면 Worker 는 workers.dev 주소로 요청을 받습니다.
- `siteOrigin` 에 방문자 주소를 넣어 주세요. 안 넣으면 대기 후 workers.dev 주소로 돌아갑니다.
- 엔진 고객사 설정의 **허용 사이트**에 그 주소를 넣어야 합니다.
- 프록시가 **쿼리 문자열(`__spw`)과 쿠키(`__spw_*`)를 Worker 로 전달**해야 하고, 대기열이 걸린 페이지(HTML)를 **캐시하지 않아야** 합니다. 캐시된 HTML 이 나가면 가드를 거치지 않습니다.

## 바로 입장 (v0.6.0 입장 인원 제한, v0.6.1 입장 속도 제한까지)

쿠키 없는 방문자가 오면 가드가 먼저 엔진에 묻습니다. 입장 인원 제한은 자리가 있으면, 입장 속도 제한은 기다리는 사람이 없고 지금 속도 여유(분당 입장만큼 쌓이는 몫)가 있으면 바로 입장합니다.

```
방문자 → 가드 ──POST /q/{tenant}/{room}/enter (x-spillway-auth: 고객사 키 서명)──▶ 엔진
  ├ 자리 있음  → 입장권 받아 이 사이트 키로 검증 → 쿠키 심고 통과 (대기 화면 없음)
  ├ 자리 없음  → 지금처럼 대기 화면으로 302 (fetch 요청은 429)
  ├ 404·401    → 대기 화면으로 (구버전 엔진, 키 불일치)
  └ 시간 초과·5xx → 통과 (fail-open)
```
- 구버전 엔진(0.11.0 미만)은 입장 속도 제한 대기실의 `/enter` 에 늘 `pass:false` 를 주므로 지금처럼 대기 화면으로 갑니다. `/enter` 가 없는 엔진(404)도 대기 화면으로.
- 버튼·이벤트 방식도 `withSpillway` 로 감싸면, 입장권 없는 API 요청에 먼저 바로 입장을 시도해 자리가 있으면 그대로 통과시킵니다. `guardPage` 는 지금처럼 429 (sdk.js 가 대기 창을 띄움).
- 바로 입장도 엔진에서 순번을 받고 사용량(`direct`)으로 집계됩니다.
- 예약 시작 대기실이 **시작 전·종료**(`phase` pre/closed)일 때는 `/enter` 를 부르지 않고 대기 화면으로 보냅니다 (시작 전 카운트다운·종료 안내는 대기 화면이 보여 줌).

## 버전별 변경점

**v0.6.2** (보안 — 대기열 우회 차단)
- 검색엔진 봇 User-Agent 를 기본으로 통과시키지 않음 (`bypassUserAgents` 기본값 없음). User-Agent 는 위장할 수 있어 매크로가 "Googlebot" 으로 건너뛸 수 있었음
- Cloudflare 가 검증한 검색엔진·링크 미리보기 봇(`request.cf.verifiedBotCategory`)만 통과 (`bypassVerifiedBots`, 기본 true — 위장 불가)
- 정적 파일 판정에서 `Sec-Fetch-Dest` 헤더를 빼고 확장자로만 판단 ("Sec-Fetch-Dest: image" 를 붙여 보호된 페이지를 통과하던 문제)
- 서버 가드(Java·PHP)도 같은 변경 (봇 User-Agent 기본 통과 끔, Sec-Fetch-Dest 판정 제거). 서버 가드 버전을 1.0.0 → **0.6.2** 로 바꿔 npm 가드와 번호를 맞춤 (앞으로 모든 가드가 같은 번호)

**v0.6.1**
- 입장 속도 제한 대기실도 먼저 `/enter` 로 바로 입장 시도 → 한가할 때는 대기 화면을 거치지 않음 (엔진 v0.11.0 이상)

**v0.6.0**
- 입장 인원 제한 대기실: 가드가 먼저 `/enter` 로 바로 입장 시도 (`serverEnter`, 기본 true)
- `withSpillway(request, env, opts, handler)` 추가 — 사이트 응답에 입장 쿠키를 붙여 리다이렉트 없이 입장
- 엔진 v0.8.0 이상 필요 (이전 엔진에서는 v0.5.0 처럼 동작)

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
git tag -a v0.6.0 -m "v0.6.0"   # package.json 의 version 과 맞추기 (-a: 주석 태그)
git push --follow-tags          # 커밋과 주석 태그를 함께 푸시 → CI 통과 후 GitHub Release 자동 생성
```
`git tag v0.6.0` 처럼 `-a` 없이 만든 태그는 `--follow-tags` 로 올라가지 않습니다. 그럴 때는 `git push origin v0.6.0` 으로 태그를 직접 푸시하세요.

## 버튼·이벤트 방식 (v0.5.0)

콘솔에서 대기실 방식을 **버튼·이벤트**로 고르고 막을 API 를 적습니다. 예: `POST /api/letters` (메서드 없이 `/api/vote/*` 는 모든 메서드)

**서버** — 코드 변경 없음. `guardPage` 가 그 API 요청에 입장권이 없으면 `429 {"spillway":"queued"}` 를 돌려줍니다.
입장권은 `x-spillway-token` 헤더 또는 쿠키 `__spw_{tenant}_{room}` 에서 읽습니다.

**화면** — 엔진의 `sdk.js` 를 넣고 버튼에 속성 하나:

```html
<script src="http://localhost:8787/sdk/v0.6.1.js" data-tenant="hello-x-mas" defer></script>

<form action="/api/letters" method="post">
  <button type="submit" data-spillway-room="send">편지 보내기</button>
</form>
```

- 누르면 페이지 위에 대기 창이 뜨고, 차례가 되면 창이 닫히면서 원래 클릭(폼 전송 등)이 이어집니다.
- 코드로: `await Spillway.fetch("send", "/api/letters", { method: "POST", body })` / `await Spillway.gate("send")`
- 입장권은 대기실의 "입장 후 유지 시간" 동안 유효합니다 (그동안은 다시 눌러도 바로 통과).
- 사이트에 CSP 가 있으면 `script-src`, `frame-src` 에 엔진 주소를 넣어 주세요.
- 엔진이 응답하지 않으면 대기 없이 통과합니다 (fail-open).
