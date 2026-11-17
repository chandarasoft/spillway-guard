# Spillway 서버 가드 — 다른 환경용

Cloudflare Workers 가 아닌 사이트에 Spillway 대기열을 붙이는 코드입니다. 모두 연동 프로토콜 v1 (사내 문서 docs/protocol-v1.md, 고객사용 안내는 [연동 가이드](https://www.spillway.co.kr/guide))을 따르고, Cloudflare 가드(`withSpillway`)와 같은 동작을 합니다.

| 폴더 | 환경 | 쓰는 법 |
|---|---|---|
| [`java/`](java/) | Spring Boot 2·3, 전자정부 표준프레임워크, JSP/Servlet | `SpillwayGuard.java` + 필터 하나(`jakarta/` 또는 `javax/`)를 프로젝트에 복사. Java 8+, 외부 라이브러리 없음 |
| [`php/`](php/) | 그누보드·영카트, 워드프레스, Laravel, 일반 PHP | `spillway.php` 를 올리고 페이지 출력 전에 `spillway_guard([...])`. PHP 7.0+ |
| [`node/`](node/) | Express, NestJS | `npm i github:chandarasoft/spillway-guard#v0.6.2` + `spillway-express.mjs` |
| [`next/`](next/) | Next.js 16+ (`proxy.ts`), 15 이하는 `middleware.ts` 로 | `npm i github:chandarasoft/spillway-guard#v0.6.2` + `proxy.ts` |

설치 방법은 연동 가이드 3장(환경별 탭)과 관리 콘솔 [사이트 연동]에 있습니다.

- 서명 키는 환경 변수 `SPILLWAY_TOKEN_SECRET` 으로 넣습니다. 코드에 넣지 마세요.
- 엔진에 연결할 수 없으면 대기 없이 통과시킵니다 (fail-open).
- 모든 구현은 [`../conformance/`](../conformance/) 의 공통 테스트 벡터와 적합성 시험(26개 시나리오)을 통과합니다.
