/**
 * Spillway Guard — 페이지 진입형 대기열 가드 (Cloudflare Workers 용, 의존성 없음)
 *
 * 사이트 Worker 의 fetch 맨 앞에서 호출합니다.
 *
 *   const blocked = await guardPage(request, env, { tenant: "acme", room: "sale", engineUrl: "...", protect: ["/reserve"] });
 *   if (blocked) return blocked;      // 대기 화면으로 보내거나, 쿠키를 심고 원래 URL 로 돌려보냄
 *   return handleNormally(request);   // null 이면 통과
 *
 * 필요한 설정 (사이트 Worker):
 *   - SPILLWAY_TOKEN_SECRET   : 고객사 서명 키 (wrangler secret) — Spillway 에서 발급
 *   - SPILLWAY_ENGINE (선택)  : 엔진 Worker 의 Service Binding — 엔진과 같은 Cloudflare 계정일 때만
 *
 * 대기실이 켜져 있는지는 엔진의 /check API 로 확인합니다 (헬스체크 겸용, 10초 캐시).
 * 안전 원칙: 판단할 수 없으면 통과시킵니다(fail-open). 대기열 때문에 사이트가 막히면 안 됩니다.
 */
export interface SpillwayEnv {
    SPILLWAY_TOKEN_SECRET: string;
    SPILLWAY_ENGINE?: Fetcher;
}
export type PathRule = string | RegExp;
export type GuardOptions = {
    /** 고객사 id (엔진 tenants/{tenant}) */
    tenant: string;
    /** 대기실 id (엔진 tenants/{tenant}/rooms/{room}.json) */
    room: string;
    /** 엔진 공개 URL. 예: https://spillway-engine.<계정>.workers.dev */
    engineUrl: string;
    /** 대기열을 적용할 경로. 문자열은 접두사("/reserve" → /reserve, /reserve/...), 정규식은 pathname 에 매칭 */
    protect: PathRule[];
    /** 제외할 경로 (protect 보다 우선) */
    exclude?: PathRule[];
    /** 통과시킬 User-Agent (기본: 주요 검색엔진/미리보기 봇) */
    bypassUserAgents?: RegExp | null;
    /** 대기실 상태(/check) 캐시 시간 ms (기본 10초) */
    checkTtlMs?: number;
};
export declare const TOKEN_PARAM = "__spw";
export declare const cookieName: (tenant: string, room: string) => string;
export declare function guardPage(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null>;
/** 테스트용 */
export declare function _resetStateCache(): void;
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