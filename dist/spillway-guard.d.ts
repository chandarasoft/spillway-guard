/**
 * Spillway Guard — 페이지 진입형 대기열 가드 (Cloudflare Workers 용, 의존성 없음)
 *
 * 사이트 Worker 의 fetch 맨 앞에서 호출합니다.
 *
 *   const blocked = await guardPage(request, env, { room: "test", engineUrl: "...", protect: ["/reserve"] });
 *   if (blocked) return blocked;      // 대기 화면으로 보내거나, 쿠키를 심고 원래 URL 로 돌려보냄
 *   return handleNormally(request);   // null 이면 통과
 *
 * 필요한 바인딩 (사이트 Worker 의 wrangler 설정):
 *   - SPILLWAY_ROOMS          : 엔진과 같은 KV namespace (대기실 on/off 확인용)
 *   - SPILLWAY_TOKEN_SECRET   : 엔진의 TOKEN_SECRET 과 같은 값 (wrangler secret)
 *   - SPILLWAY_ENGINE (선택)  : 엔진 Worker 의 Service Binding — 헬스체크를 내부망으로
 *
 * 안전 원칙: 판단할 수 없으면 통과시킵니다(fail-open). 대기열 때문에 사이트가 막히면 안 됩니다.
 */
export interface SpillwayEnv {
    SPILLWAY_ROOMS: KVNamespace;
    SPILLWAY_TOKEN_SECRET: string;
    SPILLWAY_ENGINE?: Fetcher;
}
export type PathRule = string | RegExp;
export type GuardOptions = {
    /** 대기실 id (엔진 rooms/{id}.json) */
    room: string;
    /** 엔진 공개 URL. 예: https://spillway-engine.<계정>.workers.dev */
    engineUrl: string;
    /** 대기열을 적용할 경로. 문자열은 접두사("/reserve" → /reserve, /reserve/...), 정규식은 pathname 에 매칭 */
    protect: PathRule[];
    /** 제외할 경로 (protect 보다 우선) */
    exclude?: PathRule[];
    /** 통과시킬 User-Agent (기본: 주요 검색엔진/미리보기 봇) */
    bypassUserAgents?: RegExp | null;
    /** 엔진 헬스체크 여부 (기본 true). 엔진이 응답하지 않으면 통과 */
    healthCheck?: boolean;
};
export declare const TOKEN_PARAM = "__spw";
export declare const cookieName: (room: string) => string;
export declare function guardPage(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null>;
/** 테스트용 */
export declare function _resetHealthCache(): void;
type AccessPayload = {
    t: "ac";
    r: string;
    n: number;
    exp: number;
};
export declare function signToken(payload: object, secret: string): Promise<string>;
export declare function verifyAccess(token: string, secret: string, room: string): Promise<AccessPayload | null>;
export {};
//# sourceMappingURL=spillway-guard.d.ts.map