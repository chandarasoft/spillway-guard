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
export const TOKEN_PARAM = "__spw";
const DEFAULT_BOTS = /googlebot|bingbot|yeti|daum|duckduckbot|baiduspider|slurp|kakaotalk-scrap|facebookexternalhit|twitterbot|slackbot|linkedinbot/i;
const HEALTH_TTL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1_500;
export const cookieName = (room) => `__spw_${room}`;
export async function guardPage(request, env, opts) {
    try {
        return await guard(request, env, opts);
    }
    catch (err) {
        console.error("spillway guard error (fail-open)", err);
        return null;
    }
}
async function guard(request, env, opts) {
    if (request.method !== "GET" && request.method !== "HEAD")
        return null;
    const url = new URL(request.url);
    if (!matches(url.pathname, opts.protect) || matches(url.pathname, opts.exclude ?? []))
        return null;
    const bots = opts.bypassUserAgents === undefined ? DEFAULT_BOTS : opts.bypassUserAgents;
    if (bots && bots.test(request.headers.get("user-agent") ?? ""))
        return null;
    const secret = env.SPILLWAY_TOKEN_SECRET;
    if (!secret)
        return null; // 설정 누락 → 통과
    // 1) 대기를 마치고 돌아온 경우: ?__spw=<token> → 쿠키로 바꾸고 깨끗한 URL 로 리다이렉트
    const fromQueue = url.searchParams.get(TOKEN_PARAM);
    if (fromQueue !== null) {
        url.searchParams.delete(TOKEN_PARAM);
        const p = await verifyAccess(fromQueue, secret, opts.room);
        if (p) {
            const maxAge = Math.max(1, p.exp - nowSec());
            return new Response(null, {
                status: 302,
                headers: {
                    location: url.toString(),
                    "set-cookie": `${cookieName(opts.room)}=${fromQueue}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
                    "cache-control": "no-store",
                },
            });
        }
        // 잘못된 토큰이면 아래에서 다시 줄을 세웁니다.
    }
    // 2) 이미 입장한 사용자
    const fromCookie = readCookie(request.headers.get("cookie"), cookieName(opts.room));
    if (fromCookie && (await verifyAccess(fromCookie, secret, opts.room)))
        return null;
    // 3) 대기열이 켜져 있는지 (KV). 읽지 못하면 통과
    const cfg = await env.SPILLWAY_ROOMS.get(`room:${opts.room}`, { type: "json", cacheTtl: 30 });
    if (!cfg || cfg.enabled === false)
        return null;
    // 4) 엔진이 살아 있는지. 죽어 있으면 통과
    if (opts.healthCheck !== false && !(await engineHealthy(env, opts.engineUrl)))
        return null;
    // 5) 대기 화면으로
    const wait = new URL(`/q/${encodeURIComponent(opts.room)}/wait`, opts.engineUrl);
    wait.searchParams.set("return", url.toString());
    if (!isNavigation(request)) {
        // fetch/XHR 요청에는 리다이렉트 대신 429 + 대기 URL
        return new Response(JSON.stringify({ spillway: "queued", waitUrl: wait.toString() }), {
            status: 429,
            headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" },
        });
    }
    return new Response(null, { status: 302, headers: { location: wait.toString(), "cache-control": "no-store" } });
}
// ───────────────────────── helpers ─────────────────────────
function matches(pathname, rules) {
    return rules.some((r) => typeof r === "string" ? pathname === r || pathname.startsWith(r.endsWith("/") ? r : `${r}/`) : r.test(pathname));
}
function isNavigation(req) {
    const mode = req.headers.get("sec-fetch-mode");
    if (mode)
        return mode === "navigate";
    return (req.headers.get("accept") ?? "").includes("text/html");
}
function readCookie(header, name) {
    if (!header)
        return null;
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name)
            return part.slice(i + 1).trim();
    }
    return null;
}
let health = null;
/** 테스트용 */
export function _resetHealthCache() {
    health = null;
}
async function engineHealthy(env, engineUrl) {
    const now = Date.now();
    if (health && now - health.at < HEALTH_TTL_MS)
        return health.ok;
    let ok = false;
    try {
        const target = new URL("/health", engineUrl).toString();
        const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
        const res = env.SPILLWAY_ENGINE ? await env.SPILLWAY_ENGINE.fetch(target, { signal }) : await fetch(target, { signal });
        ok = res.ok;
    }
    catch {
        ok = false;
    }
    health = { ok, at: now };
    return ok;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map();
function hmacKey(secret) {
    let k = keyCache.get(secret);
    if (!k) {
        k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        keyCache.set(secret, k);
    }
    return k;
}
function b64urlEncode(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
export async function signToken(payload, secret) {
    const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
    return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}
export async function verifyAccess(token, secret, room) {
    if (!token || token.length > 2048)
        return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf("."))
        return null;
    const body = token.slice(0, dot);
    try {
        const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(token.slice(dot + 1)), enc.encode(body));
        if (!ok)
            return null;
        const p = JSON.parse(dec.decode(b64urlDecode(body)));
        if (p.t !== "ac" || p.r !== room || typeof p.exp !== "number" || p.exp < nowSec())
            return null;
        return p;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=spillway-guard.js.map