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

export const TOKEN_PARAM = "__spw";
const DEFAULT_BOTS = /googlebot|bingbot|yeti|daum|duckduckbot|baiduspider|slurp|kakaotalk-scrap|facebookexternalhit|twitterbot|slackbot|linkedinbot/i;
const CHECK_TTL_MS = 10_000;
const CHECK_TIMEOUT_MS = 1_500;

export const cookieName = (tenant: string, room: string) => `__spw_${tenant}_${room}`;

export async function guardPage(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null> {
  try {
    return await guard(request, env, opts);
  } catch (err) {
    console.error("spillway guard error (fail-open)", err);
    return null;
  }
}

async function guard(request: Request, env: SpillwayEnv, opts: GuardOptions): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  if (!matches(url.pathname, opts.protect) || matches(url.pathname, opts.exclude ?? [])) return null;

  const bots = opts.bypassUserAgents === undefined ? DEFAULT_BOTS : opts.bypassUserAgents;
  if (bots && bots.test(request.headers.get("user-agent") ?? "")) return null;

  const secret = env.SPILLWAY_TOKEN_SECRET;
  if (!secret) return null; // 설정 누락 → 통과

  // 1) 대기를 마치고 돌아온 경우: ?__spw=<token> → 쿠키로 바꾸고 깨끗한 URL 로 리다이렉트
  const fromQueue = url.searchParams.get(TOKEN_PARAM);
  if (fromQueue !== null) {
    url.searchParams.delete(TOKEN_PARAM);
    const p = await verifyAccess(fromQueue, secret, opts.tenant, opts.room);
    if (p) {
      const maxAge = Math.max(1, p.exp - nowSec());
      return new Response(null, {
        status: 302,
        headers: {
          location: url.toString(),
          "set-cookie": `${cookieName(opts.tenant, opts.room)}=${fromQueue}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    // 잘못된 토큰이면 아래에서 다시 줄을 세웁니다.
  }

  // 2) 이미 입장한 사용자
  const fromCookie = readCookie(request.headers.get("cookie"), cookieName(opts.tenant, opts.room));
  if (fromCookie && (await verifyAccess(fromCookie, secret, opts.tenant, opts.room))) return null;

  // 3) 대기실이 켜져 있고 엔진이 응답하는지 (/check). 꺼짐·없음·응답 없음이면 통과
  if ((await roomState(env, opts)) !== "enabled") return null;

  // 4) 대기 화면으로
  const wait = new URL(`/q/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(opts.room)}/wait`, opts.engineUrl);
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

function matches(pathname: string, rules: PathRule[]): boolean {
  return rules.some((r) =>
    typeof r === "string" ? pathname === r || pathname.startsWith(r.endsWith("/") ? r : `${r}/`) : r.test(pathname),
  );
}

function isNavigation(req: Request): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

type RoomState = "enabled" | "disabled" | "unavailable";
const states = new Map<string, { state: RoomState; at: number }>();

/** 테스트용 */
export function _resetStateCache() {
  states.clear();
}

/** 엔진 /check 로 대기실 상태를 확인합니다. Worker 인스턴스마다 checkTtlMs 동안 캐시. */
async function roomState(env: SpillwayEnv, opts: GuardOptions): Promise<RoomState> {
  const key = `${opts.engineUrl}|${opts.tenant}/${opts.room}`;
  const now = Date.now();
  const hit = states.get(key);
  if (hit && now - hit.at < (opts.checkTtlMs ?? CHECK_TTL_MS)) return hit.state;

  let state: RoomState = "unavailable";
  try {
    const target = new URL(`/q/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(opts.room)}/check`, opts.engineUrl).toString();
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const res = env.SPILLWAY_ENGINE ? await env.SPILLWAY_ENGINE.fetch(target, { signal }) : await fetch(target, { signal });
    if (res.ok) {
      const body = (await res.json()) as { enabled?: boolean };
      state = body.enabled === true ? "enabled" : "disabled";
    } else {
      if (res.status === 404) console.warn(`spillway: 대기실 ${opts.tenant}/${opts.room} 을(를) 엔진에서 찾을 수 없습니다 (통과 처리)`);
    }
  } catch {
    state = "unavailable";
  }
  states.set(key, { state, at: now });
  return state;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ───────────────── token (spillway-engine/src/token.ts 와 동일한 형식) ─────────────────
// 형식: base64url(JSON) "." base64url(HMAC-SHA256(secret, 앞부분))
// 형식을 바꾸면 엔진도 함께 바꾸고, 두 프로젝트의 SHARED_VECTOR 테스트를 갱신하세요.

type AccessPayload = { t: "ac"; tn: string; r: string; n: number; exp: number; kid: number };

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signToken(payload: object, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyAccess(token: string, secret: string, tenant: string, room: string): Promise<AccessPayload | null> {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(token.slice(dot + 1)), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(b64urlDecode(body))) as AccessPayload;
    if (p.t !== "ac" || p.tn !== tenant || p.r !== room || typeof p.exp !== "number" || p.exp < nowSec()) return null;
    return p;
  } catch {
    return null;
  }
}
