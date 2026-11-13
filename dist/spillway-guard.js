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
export const TOKEN_PARAM = "__spw";
const DEFAULT_BOTS = /googlebot|bingbot|yeti|daum|duckduckbot|baiduspider|slurp|kakaotalk-scrap|facebookexternalhit|twitterbot|slackbot|linkedinbot/i;
const CACHE_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 1_500;
const STATIC_DESTS = new Set(["style", "script", "image", "font", "audio", "video", "track", "manifest", "worker", "sharedworker", "serviceworker", "object", "embed"]);
const STATIC_EXT = new Set([
    "css", "js", "mjs", "cjs", "map", "wasm",
    "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp4", "webm", "mp3", "ogg", "wav", "m4a",
    "pdf", "txt", "xml", "webmanifest",
]);
export const cookieName = (tenant, room) => `__spw_${tenant}_${room}`;
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
    if (opts.skipStatic !== false && isStaticAsset(request, url))
        return null;
    const bots = opts.bypassUserAgents === undefined ? DEFAULT_BOTS : opts.bypassUserAgents;
    if (bots && bots.test(request.headers.get("user-agent") ?? ""))
        return null;
    const secret = env.SPILLWAY_TOKEN_SECRET;
    if (!secret)
        return null; // 설정 누락 → 통과
    // 1) 이 경로에 걸린 대기실 찾기 (엔진 규칙 또는 코드 규칙). 없거나 판단 불가면 통과
    const hit = await resolveRoom(env, opts, url.pathname);
    if (!hit)
        return null;
    const { room } = hit;
    // 2) 대기를 마치고 돌아온 경우: ?__spw=<token> → 쿠키로 바꾸고 깨끗한 URL 로 리다이렉트
    const fromQueue = url.searchParams.get(TOKEN_PARAM);
    if (fromQueue !== null) {
        url.searchParams.delete(TOKEN_PARAM);
        const p = await verifyAccess(fromQueue, secret, opts.tenant, room);
        if (p) {
            const maxAge = Math.max(1, p.exp - nowSec());
            return new Response(null, {
                status: 302,
                headers: {
                    location: url.toString(),
                    "set-cookie": `${cookieName(opts.tenant, room)}=${fromQueue}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
                    "cache-control": "no-store",
                },
            });
        }
        // 잘못된 토큰이면 아래에서 다시 줄을 세웁니다.
    }
    // 3) 이미 입장한 사용자
    const fromCookie = readCookie(request.headers.get("cookie"), cookieName(opts.tenant, room));
    if (fromCookie && (await verifyAccess(fromCookie, secret, opts.tenant, room)))
        return null;
    // 4) 대기실이 꺼져 있으면 통과
    if (!hit.enabled)
        return null;
    // 5) 대기 화면으로
    const wait = new URL(`/q/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(room)}/wait`, opts.engineUrl);
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
async function resolveRoom(env, opts, pathname) {
    // 코드 규칙 (v0.2 방식)
    if (opts.room || opts.protect) {
        if (!opts.room || !opts.protect) {
            console.warn("spillway: room 과 protect 는 함께 지정해야 합니다 (통과 처리)");
            return null;
        }
        if (!matchesRule(pathname, opts.protect) || matchesRule(pathname, opts.exclude ?? []))
            return null;
        const enabled = await cached(`check|${opts.engineUrl}|${opts.tenant}/${opts.room}`, opts, async () => {
            const body = await engineJson(env, opts, `/q/${encSeg(opts.tenant)}/${encSeg(opts.room)}/check`);
            return body ? body.enabled === true : null;
        });
        return enabled === null ? null : { room: opts.room, enabled };
    }
    // 엔진 규칙
    const rules = await cached(`rules|${opts.engineUrl}|${opts.tenant}`, opts, async () => {
        const body = await engineJson(env, opts, `/q/${encSeg(opts.tenant)}/rules`);
        return body && Array.isArray(body.rooms) ? body.rooms : null;
    });
    if (!rules)
        return null;
    for (const r of rules) {
        if (r.mode !== "page")
            continue; // flow / action 은 아직 지원하지 않음
        if (r.match.some((p) => globMatch(p, pathname)) && !r.exclude.some((p) => globMatch(p, pathname))) {
            return { room: r.room, enabled: r.enabled };
        }
    }
    return null;
}
const encSeg = encodeURIComponent;
const cache = new Map();
/** 테스트용 */
export function _resetCache() {
    cache.clear();
}
/** Worker 인스턴스마다 cacheTtlMs 동안 결과를 기억합니다. 실패(null)도 기억해서 엔진 장애 때 매번 기다리지 않게 합니다. */
async function cached(key, opts, load) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < (opts.cacheTtlMs ?? CACHE_TTL_MS))
        return hit.value;
    let value = null;
    try {
        value = await load();
    }
    catch {
        value = null;
    }
    cache.set(key, { value, at: now });
    return value;
}
async function engineJson(env, opts, path) {
    const target = new URL(path, opts.engineUrl).toString();
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = env.SPILLWAY_ENGINE ? await env.SPILLWAY_ENGINE.fetch(target, { signal }) : await fetch(target, { signal });
    if (!res.ok) {
        if (res.status === 404)
            console.warn(`spillway: 엔진에서 ${path} 를 찾을 수 없습니다 (통과 처리)`);
        return null;
    }
    return (await res.json());
}
// ───────────────────────── helpers ─────────────────────────
const globCache = new Map();
/**
 * 경로 패턴 매칭. "*" 는 "/" 를 포함한 모든 문자에 매칭되고, 나머지는 그대로 비교합니다.
 *   "/"        → "/" 만
 *   "/l/*"     → "/l/1", "/l/1/x" (단 "/l" 은 아님)
 *   "/event*"  → "/event", "/events", "/event/1"
 */
export function globMatch(pattern, pathname) {
    let re = globCache.get(pattern);
    if (!re) {
        re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        globCache.set(pattern, re);
    }
    return re.test(pathname);
}
/** 정적 파일 요청인지 (브라우저가 보낸 요청 종류 또는 확장자로 판단) */
export function isStaticAsset(req, url) {
    const dest = req.headers.get("sec-fetch-dest");
    if (dest && STATIC_DESTS.has(dest))
        return true;
    const m = /\.([a-z0-9]+)$/i.exec(url.pathname);
    return !!m && STATIC_EXT.has(m[1].toLowerCase());
}
function matchesRule(pathname, rules) {
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
export async function verifyAccess(token, secret, tenant, room) {
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
        if (p.t !== "ac" || p.tn !== tenant || p.r !== room || typeof p.exp !== "number" || p.exp < nowSec())
            return null;
        return p;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=spillway-guard.js.map