import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetStateCache, cookieName, guardPage, signToken, verifyAccess, type SpillwayEnv } from "../src/spillway-guard";

const SECRET = "tenant-key";
const ENGINE = "https://engine.example.com";
const opts = { tenant: "acme", room: "sale", engineUrl: ENGINE, protect: ["/reserve"], exclude: ["/reserve/admin"] };
const COOKIE = cookieName("acme", "sale");

type Check = { status?: number; body?: unknown; throws?: boolean };

function makeEnv(check: Check = { body: { enabled: true } }): SpillwayEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    SPILLWAY_TOKEN_SECRET: SECRET,
    SPILLWAY_ENGINE: {
      fetch: vi.fn(async (url: string) => {
        calls.push(url);
        if (check.throws) throw new Error("engine down");
        return new Response(JSON.stringify(check.body ?? {}), { status: check.status ?? 200 });
      }),
    } as unknown as Fetcher,
  };
}

const nav = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...headers } });

const access = (o: { exp?: number; tn?: string; r?: string } = {}) =>
  signToken({ t: "ac", tn: o.tn ?? "acme", r: o.r ?? "sale", n: 1, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, kid: 1 }, SECRET);

beforeEach(() => _resetStateCache());

describe("guardPage", () => {
  it("보호 경로가 아니면 통과 (엔진도 호출하지 않음)", async () => {
    const env = makeEnv();
    expect(await guardPage(nav("https://site.com/"), env, opts)).toBeNull();
    expect(await guardPage(nav("https://site.com/reserved"), env, opts)).toBeNull();
    expect(await guardPage(nav("https://site.com/reserve/admin/x"), env, opts)).toBeNull();
    expect(env.calls).toHaveLength(0);
  });

  it("토큰이 없으면 대기 화면으로 보낸다", async () => {
    const env = makeEnv();
    const res = await guardPage(nav("https://site.com/reserve/1?a=b"), env, opts);
    expect(res?.status).toBe(302);
    const loc = new URL(res!.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${ENGINE}/q/acme/sale/wait`);
    expect(loc.searchParams.get("return")).toBe("https://site.com/reserve/1?a=b");
    expect(env.calls).toEqual([`${ENGINE}/q/acme/sale/check`]);
  });

  it("/check 결과를 캐시한다", async () => {
    const env = makeEnv();
    await guardPage(nav("https://site.com/reserve"), env, opts);
    await guardPage(nav("https://site.com/reserve"), env, opts);
    expect(env.calls).toHaveLength(1);
  });

  it("fetch 요청에는 429 를 준다", async () => {
    const req = new Request("https://site.com/reserve/data", { headers: { "sec-fetch-mode": "cors" } });
    expect((await guardPage(req, makeEnv(), opts))?.status).toBe(429);
  });

  it("돌아온 토큰을 쿠키로 바꾸고 깨끗한 URL 로 보낸다", async () => {
    const tok = await access();
    const res = await guardPage(nav(`https://site.com/reserve?x=1&__spw=${tok}`), makeEnv(), opts);
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toBe("https://site.com/reserve?x=1");
    expect(res!.headers.get("set-cookie")).toContain(`${COOKIE}=${tok}`);
    expect(res!.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("유효한 쿠키가 있으면 통과 (엔진 호출 없음)", async () => {
    const env = makeEnv();
    const req = nav("https://site.com/reserve", { cookie: `foo=bar; ${COOKIE}=${await access()}` });
    expect(await guardPage(req, env, opts)).toBeNull();
    expect(env.calls).toHaveLength(0);
  });

  it("만료·다른 대기실·다른 고객사 토큰이면 다시 줄을 세운다", async () => {
    const bad = [
      await access({ exp: Math.floor(Date.now() / 1000) - 1 }),
      await access({ r: "other" }),
      await access({ tn: "other-tenant" }),
    ];
    for (const tok of bad) {
      const req = nav("https://site.com/reserve", { cookie: `${COOKIE}=${tok}` });
      expect((await guardPage(req, makeEnv(), opts))?.status).toBe(302);
    }
  });

  it("다른 고객사 키로 서명된 토큰은 거부한다", async () => {
    const forged = await signToken({ t: "ac", tn: "acme", r: "sale", n: 1, exp: 2_000_000_000, kid: 1 }, "other-tenant-key");
    const req = nav("https://site.com/reserve", { cookie: `${COOKIE}=${forged}` });
    expect((await guardPage(req, makeEnv(), opts))?.status).toBe(302);
  });

  it("fail-open: 꺼짐 / 대기실 없음 / 엔진 오류 / 엔진 응답 없음 / 봇", async () => {
    const url = "https://site.com/reserve";
    for (const check of [{ body: { enabled: false } }, { status: 404 }, { status: 500 }, { throws: true }] as Check[]) {
      _resetStateCache();
      expect(await guardPage(nav(url), makeEnv(check), opts)).toBeNull();
    }
    _resetStateCache();
    expect(await guardPage(nav(url, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }), makeEnv(), opts)).toBeNull();
  });

  it("POST 는 가드하지 않는다 (페이지 진입형)", async () => {
    const req = new Request("https://site.com/reserve", { method: "POST" });
    expect(await guardPage(req, makeEnv(), opts)).toBeNull();
  });
});

describe("token", () => {
  // spillway-engine/test/token.test.ts 와 같은 벡터 — 엔진이 만든 토큰을 가드가 검증할 수 있음을 보장
  const SHARED_VECTOR = "eyJ0IjoiYWMiLCJyIjoidGVzdCIsIm4iOjEsImV4cCI6MjAwMDAwMDAwMH0.XnmAUMHa6_zxrgimxJ2ccMXT6E8rJCwRf5RhdfxHTkU";

  it("공유 테스트 벡터 (서명 형식)", async () => {
    expect(await signToken({ t: "ac", r: "test", n: 1, exp: 2000000000 }, "spillway-shared-vector")).toBe(SHARED_VECTOR);
  });

  it("verifyAccess 는 고객사와 대기실을 모두 확인한다", async () => {
    const tok = await signToken({ t: "ac", tn: "acme", r: "sale", n: 7, exp: 2_000_000_000, kid: 1 }, SECRET);
    expect((await verifyAccess(tok, SECRET, "acme", "sale"))?.n).toBe(7);
    expect(await verifyAccess(tok, SECRET, "acme", "other")).toBeNull();
    expect(await verifyAccess(tok, SECRET, "other", "sale")).toBeNull();
  });
});
