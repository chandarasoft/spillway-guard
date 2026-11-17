/**
 * Spillway Guard — 페이지 진입형 대기열 가드 (Cloudflare Workers 용, 의존성 없음)
 *
 * 사이트 Worker 의 fetch 맨 앞에서 호출합니다.
 *
 *   const blocked = await guardPage(request, env, { tenant: "acme", engineUrl: env.SPILLWAY_ENGINE_URL });
 *   if (blocked) return blocked;      // 대기 화면으로 보내거나, 쿠키를 심고 원래 URL 로 돌려보냄
 *   return handleNormally(request);   // null 이면 통과
 *
 * 어느 URL 에 어느 대기실을 걸지는 엔진의 대기실 설정(match/exclude)에서 받아 옵니다 (GET /q/{tenant}/rules, 10초 캐시).
 * 코드에서 직접 정하고 싶으면 room + protect 옵션을 주면 됩니다 (v0.2 방식).
 *
 * 필요한 설정 (사이트 Worker):
 *   - SPILLWAY_TOKEN_SECRET   : 고객사 서명 키 (wrangler secret) — Spillway 에서 발급
 *   - SPILLWAY_ENGINE (선택)  : 엔진 Worker 의 Service Binding — 엔진과 같은 Cloudflare 계정일 때만
 *
 * 버튼·이벤트 방식(대기실 mode "action")은 페이지가 아니라 API 를 보호합니다.
 *   대기실 규칙에 "POST /api/reserve" 처럼 적힌 요청에 입장권이 없으면 429 {"spillway":"queued"} 를 돌려줍니다.
 *   입장권은 사이트 화면의 sdk.js 가 대기 창에서 받아 x-spillway-token 헤더와 쿠키(__spw_{tenant}_{room})로 붙입니다.
 *
 * 쿠키 없는 방문자가 오면 가드가 먼저 엔진 /enter 로 바로 입장을 시도합니다.
 *   입장 인원 제한은 자리가 있으면, 입장 속도 제한은 기다리는 사람이 없고 속도 여유가 있으면
 *   대기 화면 없이 입장권을 쿠키로 심고 통과, 아니면 대기 화면으로 보냅니다.
 *   응답에 쿠키를 붙이려면 withSpillway() 로 사이트 처리를 감싸 주세요 (guardPage() 는 같은 주소로 한 번 302).
 *
 *   export default {
 *     fetch: (req, env) => withSpillway(req, env, { tenant: "acme", engineUrl: env.SPILLWAY_ENGINE_URL }, (r) => handleNormally(r, env)),
 *   };
 *
 * CSS·JS·이미지·폰트 같은 정적 파일은 규칙과 상관없이 엔진에 묻지 않고 바로 통과합니다.
 * 안전 원칙: 판단할 수 없으면 통과시킵니다(fail-open). 대기열 때문에 사이트가 막히면 안 됩니다.
 */
export interface SpillwayEnv {
    SPILLWAY_TOKEN_SECRET: string;
    SPILLWAY_ENGINE?: Fetcher;
}
export type PathRule = string | RegExp;
export type GuardOptions = {
    /** 고객사 id */
    tenant: string;
    /** 엔진 공개 URL. 예: https://spillway-engine.<계정>.workers.dev */
    engineUrl: string;
    /**
     * (선택) 코드로 규칙을 정할 때의 대기실 id. protect 와 함께 주면 엔진 규칙 대신 이것을 씁니다.
     */
    room?: string;
    /** (선택, room 과 함께) 대기열을 걸 경로. 문자열은 접두사("/reserve" → /reserve, /reserve/...), 정규식은 pathname 에 매칭 */
    protect?: PathRule[];
    /** (선택, room 과 함께) 제외할 경로 (protect 보다 우선) */
    exclude?: PathRule[];
    /**
     * 통과시킬 User-Agent (기본: 없음 — v0.6.2 부터).
     * User-Agent 는 누구나 바꿔 보낼 수 있어 매크로가 "Googlebot" 으로 위장하면 대기열을 건너뜁니다. 위험을 알고 쓸 때만 넣으세요.
     */
    bypassUserAgents?: RegExp | null;
    /**
     * Cloudflare 가 검증한 검색엔진·링크 미리보기 봇(request.cf.verifiedBotCategory)은 통과 (기본 true).
     * Cloudflare 가 IP 로 확인해 붙이는 값이라 위장할 수 없습니다. Cloudflare 를 거치지 않는 환경에서는 값이 없어 아무 영향 없음.
     */
    bypassVerifiedBots?: boolean;
    /** 정적 파일(CSS·JS·이미지·폰트 등)을 자동으로 통과 (기본 true) */
    skipStatic?: boolean;
    /** 엔진 규칙·상태 캐시 시간 ms (기본 10초) */
    cacheTtlMs?: number;
    /**
     * (선택) 방문자가 보는 사이트 주소. 예: https://www.example.com
     * CloudFront·다른 CDN·프록시가 앞에 있어서 Worker 가 받는 주소(*.workers.dev)와 방문자 주소가 다를 때 지정합니다.
     * 대기 후 돌아갈 주소(return)를 이 origin 으로 만듭니다. 없으면 요청 주소를 그대로 씁니다.
     */
    siteOrigin?: string;
    /**
     * 입장 인원 제한(capacity) 대기실에서 가드가 먼저 바로 입장을 시도할지 (기본 true).
     * false 면 지금까지처럼 항상 대기 화면을 거칩니다.
     */
    serverEnter?: boolean;
};
export declare const TOKEN_PARAM = "__spw";
/** 버튼 방식 API 요청에 입장권을 싣는 헤더 (sdk.js 의 Spillway.fetch 가 붙임) */
export declare const ACTION_HEADER = "x-spillway-token";
/** 방문자가 보는 주소: siteOrigin 이 있으면 그 origin + 요청 경로 */
export declare function publicUrl(url: URL, siteOrigin?: string): string;
export declare const cookieName: (tenant: string, room: string) => string;
/**
 * 사이트 Worker 의 fetch 맨 앞에서 호출합니다. null 이면 통과.
 * 입장 인원 제한 대기실에서 바로 입장하면, 쿠키를 심고 같은 주소로 한 번 302 합니다 (대기 화면은 거치지 않음).
 * 리다이렉트 없이 바로 응답하려면 withSpillway() 를 쓰세요.
 */
export declare function guardPage(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null>;
/**
 * 사이트 처리(handler)를 감싸는 가드. 대기열이 필요하면 대기 화면·429 를 돌려주고, 아니면 handler 를 부릅니다.
 * 입장 인원 제한 대기실에서 바로 입장하면 handler 응답에 입장 쿠키를 붙입니다 → 방문자는 리다이렉트 없이 바로 페이지를 봅니다.
 * 버튼·이벤트 방식 API 도 입장권이 없을 때 먼저 바로 입장을 시도하고, 자리가 없을 때만 429 를 돌려줍니다.
 */
export declare function withSpillway(request: Request, env: SpillwayEnv, opts: GuardOptions, handler: (request: Request) => Response | Promise<Response>): Promise<Response>;
/**
 * 버튼 방식 규칙 매칭: "POST /api/reserve" (메서드 + 경로) 또는 "/api/reserve" (모든 메서드).
 * 경로 부분은 globMatch 와 같은 규칙입니다.
 */
export declare function actionMatch(pattern: string, method: string, pathname: string): boolean;
/** 테스트용 */
export declare function _resetCache(): void;
/**
 * 경로 패턴 매칭. "*" 는 "/" 를 포함한 모든 문자에 매칭되고, 나머지는 그대로 비교합니다.
 *   "/"        → "/" 만
 *   "/l/*"     → "/l/1", "/l/1/x" (단 "/l" 은 아님)
 *   "/event*"  → "/event", "/events", "/event/1"
 */
export declare function globMatch(pattern: string, pathname: string): boolean;
/**
 * 정적 파일 요청인지 — 경로의 확장자로만 판단합니다.
 * (v0.6.1 까지는 Sec-Fetch-Dest 헤더도 봤지만, 매크로가 "Sec-Fetch-Dest: image" 를 붙여 보호된 페이지를 통과할 수 있어 뺐습니다)
 */
export declare function isStaticAsset(_req: Request, url: URL): boolean;
/** Cloudflare 가 검증한 검색엔진·미리보기 봇인지 (Workers 의 request.cf 에만 있음, 위장 불가) */
export declare function isVerifiedBot(req: Request): boolean;
type AccessPayload = {
    t: "ac";
    tn: string;
    r: string;
    n: number;
    exp: number;
    kid: number;
};
export declare function signToken(payload: object, secret: string): Promise<string>;
export declare function verifyAccess(token: string, secret: string, tenant: string, room: string): Promise<AccessPayload | null>;
export {};
//# sourceMappingURL=spillway-guard.d.ts.map