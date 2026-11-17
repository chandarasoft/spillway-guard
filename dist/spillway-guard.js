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
export const TOKEN_PARAM = "__spw";
/** 버튼 방식 API 요청에 입장권을 싣는 헤더 (sdk.js 의 Spillway.fetch 가 붙임) */
export const ACTION_HEADER = "x-spillway-token";
/** 통과시킬 Cloudflare 검증 봇 종류 (검색 노출·링크 미리보기) */
const VERIFIED_BOT_CATEGORIES = new Set(["Search Engine Crawler", "Search Engine Optimization", "Page Preview"]);
const CACHE_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 1_500;
/** /enter 서명 유효 시간 (엔진은 ±60초까지 받음) */
const ENTER_AUTH_TTL_SEC = 60;
const STATIC_EXT = new Set([
    "css", "js", "mjs", "cjs", "map", "wasm",
    "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp4", "webm", "mp3", "ogg", "wav", "m4a",
    "pdf", "txt", "xml", "webmanifest",
]);
/** 방문자가 보는 주소: siteOrigin 이 있으면 그 origin + 요청 경로 */
export function publicUrl(url, siteOrigin) {
    if (!siteOrigin)
        return url.toString();
    try {
        const o = new URL(siteOrigin);
        return new URL(url.pathname + url.search, o.origin).toString();
    }
    catch {
        return url.toString();
    }
}
export const cookieName = (tenant, room) => `__spw_${tenant}_${room}`;
const PASS = { pass: true };
/**
 * 사이트 Worker 의 fetch 맨 앞에서 호출합니다. null 이면 통과.
 * 입장 인원 제한 대기실에서 바로 입장하면, 쿠키를 심고 같은 주소로 한 번 302 합니다 (대기 화면은 거치지 않음).
 * 리다이렉트 없이 바로 응답하려면 withSpillway() 를 쓰세요.
 */
export async function guardPage(request, env, opts) {
    try {
        const d = await decide(request, env, opts, false);
        if ("response" in d)
            return d.response;
        if (d.setCookie) {
            const url = new URL(request.url);
            return new Response(null, {
                status: 302,
                headers: { location: url.pathname + url.search, "set-cookie": d.setCookie, "cache-control": "no-store" },
            });
        }
        return null;
    }
    catch (err) {
        console.error("spillway guard error (fail-open)", err);
        return null;
    }
}
/**
 * 사이트 처리(handler)를 감싸는 가드. 대기열이 필요하면 대기 화면·429 를 돌려주고, 아니면 handler 를 부릅니다.
 * 입장 인원 제한 대기실에서 바로 입장하면 handler 응답에 입장 쿠키를 붙입니다 → 방문자는 리다이렉트 없이 바로 페이지를 봅니다.
 * 버튼·이벤트 방식 API 도 입장권이 없을 때 먼저 바로 입장을 시도하고, 자리가 없을 때만 429 를 돌려줍니다.
 */
export async function withSpillway(request, env, opts, handler) {
    let d;
    try {
        d = await decide(request, env, opts, true);
    }
    catch (err) {
        console.error("spillway guard error (fail-open)", err);
        return handler(request);
    }
    if ("response" in d)
        return d.response;
    const res = await handler(request);
    if (!d.setCookie || res.status === 101 || res.webSocket)
        return res;
    const out = new Response(res.body, res);
    out.headers.append("set-cookie", d.setCookie);
    // 입장권이 든 응답이 CDN·공유 캐시에 저장되면 다른 방문자에게 같은 입장권이 나가므로 막습니다
    out.headers.set("cache-control", "private, no-store");
    return out;
}
const accessCookie = (tenant, room, token, exp) => `${cookieName(tenant, room)}=${token}; Path=/; Max-Age=${Math.max(1, exp - nowSec())}; HttpOnly; Secure; SameSite=Lax`;
async function decide(request, env, opts, canWrap) {
    const url = new URL(request.url);
    const secret = env.SPILLWAY_TOKEN_SECRET;
    if (!secret)
        return PASS; // 설정 누락 → 통과
    // 정적 파일(GET)은 규칙과 상관없이 엔진에 묻지 않고 통과
    const readOnly = request.method === "GET" || request.method === "HEAD";
    if (readOnly && opts.skipStatic !== false && isStaticAsset(request, url))
        return PASS;
    // 버튼·이벤트 방식: API 요청 (메서드 무관, 엔진 규칙을 쓸 때만)
    if (!opts.room && !opts.protect && request.method !== "OPTIONS") {
        const act = await resolveAction(env, opts, request.method, url.pathname);
        if (act)
            return act.enabled ? await checkAction(request, env, opts, secret, act, canWrap) : PASS;
    }
    if (!readOnly)
        return PASS;
    if (opts.bypassVerifiedBots !== false && isVerifiedBot(request))
        return PASS;
    const bots = opts.bypassUserAgents ?? null;
    if (bots && bots.test(request.headers.get("user-agent") ?? ""))
        return PASS;
    // 1) 이 경로에 걸린 대기실 찾기 (엔진 규칙 또는 코드 규칙). 없거나 판단 불가면 통과
    const hit = await resolveRoom(env, opts, url.pathname);
    if (!hit)
        return PASS;
    const { room } = hit;
    // 2) 대기를 마치고 돌아온 경우: ?__spw=<token> → 쿠키로 바꾸고 깨끗한 URL 로 리다이렉트
    const fromQueue = url.searchParams.get(TOKEN_PARAM);
    if (fromQueue !== null) {
        url.searchParams.delete(TOKEN_PARAM);
        const p = await verifyAccess(fromQueue, secret, opts.tenant, room);
        if (p) {
            return {
                response: new Response(null, {
                    status: 302,
                    headers: {
                        location: url.pathname + url.search, // 상대 주소 — 프록시 뒤에서도 방문자 주소 그대로
                        "set-cookie": accessCookie(opts.tenant, room, fromQueue, p.exp),
                        "cache-control": "no-store",
                    },
                }),
            };
        }
        // 잘못된 토큰이면 아래에서 다시 줄을 세웁니다.
    }
    // 3) 이미 입장한 사용자
    const fromCookie = readCookie(request.headers.get("cookie"), cookieName(opts.tenant, room));
    if (fromCookie && (await verifyAccess(fromCookie, secret, opts.tenant, room)))
        return PASS;
    // 4) 대기실이 꺼져 있으면 통과
    if (!hit.enabled)
        return PASS;
    // 5) 입장 인원 제한: 자리가 있으면 대기 화면 없이 바로 입장
    if (canEnter(hit, opts)) {
        const e = await tryEnter(env, opts, secret, room);
        if (e.kind === "pass")
            return { pass: true, setCookie: accessCookie(opts.tenant, room, e.token, e.exp) };
        if (e.kind === "error")
            return PASS; // 엔진 장애 → 통과 (fail-open)
        // 자리 없음·구버전 엔진 → 대기 화면
    }
    // 6) 대기 화면으로 (돌아올 주소는 방문자가 보는 주소로)
    const wait = new URL(`/q/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(room)}/wait`, opts.engineUrl);
    wait.searchParams.set("return", publicUrl(url, opts.siteOrigin));
    if (!isNavigation(request)) {
        // fetch/XHR 요청에는 리다이렉트 대신 429 + 대기 URL
        return {
            response: new Response(JSON.stringify({ spillway: "queued", waitUrl: wait.toString() }), {
                status: 429,
                headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" },
            }),
        };
    }
    return { response: new Response(null, { status: 302, headers: { location: wait.toString(), "cache-control": "no-store" } }) };
}
/**
 * 엔진 POST /q/{tenant}/{room}/enter — 고객사 키로 서명한 x-spillway-auth 를 붙여 보냅니다.
 *  - pass  : 자리 있음. 받은 입장권을 이 사이트의 키로 다시 검증한 뒤 사용
 *  - queue : 자리 없음, 또는 엔진이 /enter 를 모름(404)·서명 불일치(401) → 대기 화면으로
 *  - error : 시간 초과·네트워크·5xx → 통과 (fail-open)
 */
async function tryEnter(env, opts, secret, room) {
    const iat = nowSec();
    const auth = await signToken({ t: "en", tn: opts.tenant, r: room, iat, exp: iat + ENTER_AUTH_TTL_SEC }, secret);
    let res;
    try {
        res = await engineFetch(env, opts, `/q/${encSeg(opts.tenant)}/${encSeg(room)}/enter`, {
            method: "POST",
            headers: { "x-spillway-auth": auth },
        });
    }
    catch {
        return { kind: "error" };
    }
    if (res.status >= 500)
        return { kind: "error" };
    if (!res.ok) {
        if (res.status === 401)
            console.warn("spillway: /enter 서명이 맞지 않습니다 — SPILLWAY_TOKEN_SECRET 을 확인하세요 (대기 화면으로 보냄)");
        return { kind: "queue" };
    }
    const body = (await res.json().catch(() => null));
    if (!body?.pass || typeof body.token !== "string")
        return { kind: "queue" };
    const p = await verifyAccess(body.token, secret, opts.tenant, room);
    return p ? { kind: "pass", token: body.token, exp: p.exp } : { kind: "queue" };
}
/**
 * 바로 입장(/enter)을 시도할 대기실인지: 진행 중이면 입장 방식과 상관없이 (시작 전·종료면 대기 화면이 안내).
 * 입장 인원 제한은 자리가 있으면, 입장 속도 제한은 기다리는 사람이 없고 속도 여유가 있으면 바로 입장 (엔진 0.11 부터)
 */
const canEnter = (hit, opts) => (hit.phase ?? "open") === "open" && opts.serverEnter !== false;
async function resolveRoom(env, opts, pathname) {
    // 코드 규칙 (v0.2 방식)
    if (opts.room || opts.protect) {
        if (!opts.room || !opts.protect) {
            console.warn("spillway: room 과 protect 는 함께 지정해야 합니다 (통과 처리)");
            return null;
        }
        if (!matchesRule(pathname, opts.protect) || matchesRule(pathname, opts.exclude ?? []))
            return null;
        const check = await cached(`check|${opts.engineUrl}|${opts.tenant}/${opts.room}`, opts, async () => {
            const body = await engineJson(env, opts, `/q/${encSeg(opts.tenant)}/${encSeg(opts.room)}/check`);
            return body ? { enabled: body.enabled === true, policy: body.policy, phase: body.phase } : null;
        });
        return check === null ? null : { room: opts.room, enabled: check.enabled, policy: check.policy, phase: check.phase };
    }
    // 엔진 규칙
    const rules = await engineRules(env, opts);
    if (!rules)
        return null;
    for (const r of rules) {
        if (r.mode !== "page")
            continue; // action 은 resolveAction, flow 는 아직 지원하지 않음
        if (r.match.some((p) => globMatch(p, pathname)) && !r.exclude.some((p) => globMatch(p, pathname))) {
            return { room: r.room, enabled: r.enabled, policy: r.policy, phase: r.phase };
        }
    }
    return null;
}
/** 엔진의 대기실 규칙 (캐시) */
function engineRules(env, opts) {
    return cached(`rules|${opts.engineUrl}|${opts.tenant}`, opts, async () => {
        const body = await engineJson(env, opts, `/q/${encSeg(opts.tenant)}/rules`);
        return body && Array.isArray(body.rooms) ? body.rooms : null;
    });
}
/** 버튼 방식 대기실 중 이 요청(메서드 + 경로)에 걸리는 것 */
async function resolveAction(env, opts, method, pathname) {
    const rules = await engineRules(env, opts);
    if (!rules)
        return null;
    for (const r of rules) {
        if (r.mode !== "action")
            continue;
        if (r.match.some((p) => actionMatch(p, method, pathname)) && !r.exclude.some((p) => actionMatch(p, method, pathname))) {
            return { room: r.room, enabled: r.enabled, policy: r.policy, phase: r.phase };
        }
    }
    return null;
}
/**
 * 입장권(헤더 또는 쿠키)이 있으면 통과, 없으면 429 — sdk.js 가 이 응답을 보고 대기 창을 띄웁니다.
 * withSpillway 로 감싼 입장 인원 제한 대기실이면, 먼저 바로 입장을 시도해 자리가 있으면 API 를 그대로 통과시키고 쿠키를 붙입니다.
 */
async function checkAction(request, env, opts, secret, hit, canWrap) {
    const { tenant } = opts;
    const { room } = hit;
    const fromHeader = request.headers.get(ACTION_HEADER);
    if (fromHeader && (await verifyAccess(fromHeader, secret, tenant, room)))
        return PASS;
    const fromCookie = readCookie(request.headers.get("cookie"), cookieName(tenant, room));
    if (fromCookie && (await verifyAccess(fromCookie, secret, tenant, room)))
        return PASS;
    if (canWrap && canEnter(hit, opts)) {
        const e = await tryEnter(env, opts, secret, room);
        if (e.kind === "pass")
            return { pass: true, setCookie: accessCookie(tenant, room, e.token, e.exp) };
        if (e.kind === "error")
            return PASS; // 엔진 장애 → 통과 (fail-open)
    }
    return {
        response: new Response(JSON.stringify({ spillway: "queued", mode: "action", tenant, room }), {
            status: 429,
            headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" },
        }),
    };
}
/**
 * 버튼 방식 규칙 매칭: "POST /api/reserve" (메서드 + 경로) 또는 "/api/reserve" (모든 메서드).
 * 경로 부분은 globMatch 와 같은 규칙입니다.
 */
export function actionMatch(pattern, method, pathname) {
    const m = /^(GET|POST|PUT|PATCH|DELETE) (\/.*)$/.exec(pattern);
    if (m)
        return m[1] === method.toUpperCase() && globMatch(m[2], pathname);
    return pattern.startsWith("/") && globMatch(pattern, pathname);
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
/** 엔진 호출 (Service Binding 이 있으면 그쪽으로, 시간 제한 1.5초) */
function engineFetch(env, opts, path, init = {}) {
    const target = new URL(path, opts.engineUrl).toString();
    const req = { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    return env.SPILLWAY_ENGINE ? env.SPILLWAY_ENGINE.fetch(target, req) : fetch(target, req);
}
async function engineJson(env, opts, path) {
    const res = await engineFetch(env, opts, path);
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
/**
 * 정적 파일 요청인지 — 경로의 확장자로만 판단합니다.
 * (v0.6.1 까지는 Sec-Fetch-Dest 헤더도 봤지만, 매크로가 "Sec-Fetch-Dest: image" 를 붙여 보호된 페이지를 통과할 수 있어 뺐습니다)
 */
export function isStaticAsset(_req, url) {
    const m = /\.([a-z0-9]+)$/i.exec(url.pathname);
    return !!m && STATIC_EXT.has(m[1].toLowerCase());
}
/** Cloudflare 가 검증한 검색엔진·미리보기 봇인지 (Workers 의 request.cf 에만 있음, 위장 불가) */
export function isVerifiedBot(req) {
    const cat = req.cf?.verifiedBotCategory;
    return typeof cat === "string" && VERIFIED_BOT_CATEGORIES.has(cat);
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