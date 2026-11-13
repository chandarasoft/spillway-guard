import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetHealthCache, cookieName, guardPage, signToken, verifyAccess, type SpillwayEnv } from "../src/spillway-guard";

const SECRET = "test-secret";
const ENGINE = "https://engine.example.com";
const opts = { room: "test", engineUrl: ENGINE, protect: ["/reserve"], exclude: ["/reserve/admin"] };

function makeEnv(cfg: unknown, engineOk = true): SpillwayEnv {
  return {
    SPILLWAY_TOKEN_SECRET: SECRET,
    SPILLWAY_ROOMS: { get: vi.fn(async () => cfg) } as unknown as KVNamespace,
    SPILLWAY_ENGINE: { fetch: vi.fn(async () => new Response("{}", { status: engineOk ? 200 : 503 })) } as unknown as Fetcher,
  };
}

const nav = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...headers } });

const access = (exp = Math.floor(Date.now() / 1000) + 600, room = "test") => signToken({ t: "ac", r: room, n: 1, exp }, SECRET);

beforeEach(() => _resetHealthCache());

describe("guardPage", () => {
  it("보호 경로가 아니면 통과", async () => {
    expect(await guardPage(nav("https://site.com/"), makeEnv({ enabled: true }), opts)).toBeNull();
    expect(await guardPage(nav("https://site.com/reserved"), makeEnv({ enabled: true }), opts)).toBeNull();
    expect(await guardPage(nav("https://site.com/reserve/admin/x"), makeEnv({ enabled: true }), opts)).toBeNull();
  });

  it("토큰이 없으면 대기 화면으로 보낸다", async () => {
    const res = await guardPage(nav("https://site.com/reserve/1?a=b"), makeEnv({ enabled: true }), opts);
    expect(res?.status).toBe(302);
    const loc = new URL(res!.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${ENGINE}/q/test/wait`);
    expect(loc.searchParams.get("return")).toBe("https://site.com/reserve/1?a=b");
  });

  it("fetch 요청에는 429 를 준다", async () => {
    const req = new Request("https://site.com/reserve/data", { headers: { "sec-fetch-mode": "cors" } });
    const res = await guardPage(req, makeEnv({ enabled: true }), opts);
    expect(res?.status).toBe(429);
  });

  it("돌아온 토큰을 쿠키로 바꾸고 깨끗한 URL 로 보낸다", async () => {
    const tok = await access();
    const res = await guardPage(nav(`https://site.com/reserve?x=1&__spw=${tok}`), makeEnv({ enabled: true }), opts);
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toBe("https://site.com/reserve?x=1");
    expect(res!.headers.get("set-cookie")).toContain(`${cookieName("test")}=${tok}`);
    expect(res!.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("유효한 쿠키가 있으면 통과", async () => {
    const tok = await access();
    const req = nav("https://site.com/reserve", { cookie: `foo=bar; ${cookieName("test")}=${tok}` });
    expect(await guardPage(req, makeEnv({ enabled: true }), opts)).toBeNull();
  });

  it("만료되었거나 다른 대기실 토큰이면 다시 줄을 세운다", async () => {
    const expired = await access(Math.floor(Date.now() / 1000) - 1);
    const other = await access(undefined, "other");
    for (const tok of [expired, other]) {
      const req = nav("https://site.com/reserve", { cookie: `${cookieName("test")}=${tok}` });
      expect((await guardPage(req, makeEnv({ enabled: true }), opts))?.status).toBe(302);
    }
  });

  it("fail-open: 꺼짐 / 설정 없음 / KV 오류 / 엔진 장애 / 봇", async () => {
    const url = "https://site.com/reserve";
    expect(await guardPage(nav(url), makeEnv({ enabled: false }), opts)).toBeNull();
    expect(await guardPage(nav(url), makeEnv(null), opts)).toBeNull();

    const broken = makeEnv({ enabled: true });
    (broken.SPILLWAY_ROOMS.get as any).mockRejectedValue(new Error("kv down"));
    expect(await guardPage(nav(url), broken, opts)).toBeNull();

    _resetHealthCache();
    expect(await guardPage(nav(url), makeEnv({ enabled: true }, false), opts)).toBeNull();

    _resetHealthCache();
    expect(await guardPage(nav(url, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }), makeEnv({ enabled: true }), opts)).toBeNull();
  });

  it("POST 는 가드하지 않는다 (페이지 진입형)", async () => {
    const req = new Request("https://site.com/reserve", { method: "POST" });
    expect(await guardPage(req, makeEnv({ enabled: true }), opts)).toBeNull();
  });
});

describe("token", () => {
  // spillway-engine/test/token.test.ts 와 같은 벡터 — 엔진이 만든 토큰을 가드가 검증할 수 있음을 보장
  const SHARED_VECTOR = "eyJ0IjoiYWMiLCJyIjoidGVzdCIsIm4iOjEsImV4cCI6MjAwMDAwMDAwMH0.XnmAUMHa6_zxrgimxJ2ccMXT6E8rJCwRf5RhdfxHTkU";

  it("공유 테스트 벡터", async () => {
    expect(await signToken({ t: "ac", r: "test", n: 1, exp: 2000000000 }, "spillway-shared-vector")).toBe(SHARED_VECTOR);
    expect((await verifyAccess(SHARED_VECTOR, "spillway-shared-vector", "test"))?.n).toBe(1);
  });
});
