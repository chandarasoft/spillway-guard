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
    /** 통과시킬 User-Agent (기본: 주요 검색엔진/미리보기 봇). null 이면 봇도 줄 세움 */
    bypassUserAgents?: RegExp | null;
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
};
export declare const TOKEN_PARAM = "__spw";
/** 방문자가 보는 주소: siteOrigin 이 있으면 그 origin + 요청 경로 */
export declare function publicUrl(url: URL, siteOrigin?: string): string;
export declare const cookieName: (tenant: string, room: string) => string;
export declare function guardPage(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null>;
/** 테스트용 */
export declare function _resetCache(): void;
/**
 * 경로 패턴 매칭. "*" 는 "/" 를 포함한 모든 문자에 매칭되고, 나머지는 그대로 비교합니다.
 *   "/"        → "/" 만
 *   "/l/*"     → "/l/1", "/l/1/x" (단 "/l" 은 아님)
 *   "/event*"  → "/event", "/events", "/event/1"
 */
export declare function globMatch(pattern: string, pathname: string): boolean;
/** 정적 파일 요청인지 (브라우저가 보낸 요청 종류 또는 확장자로 판단) */
export declare function isStaticAsset(req: Request, url: URL): boolean;
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