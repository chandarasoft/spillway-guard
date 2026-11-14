import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCache,
  ACTION_HEADER,
  actionMatch,
  cookieName,
  globMatch,
  guardPage,
  isStaticAsset,
  signToken,
  verifyAccess,
  type GuardOptions,
  type SpillwayEnv,
} from "../src/spillway-guard";

const SECRET = "tenant-key";
const ENGINE = "https://engine.example.com";
const opts: GuardOptions = { tenant: "acme", engineUrl: ENGINE };
const COOKIE = cookieName("acme", "main");

const RULES = {
  tenant: "acme",
  rooms: [
    { room: "main", mode: "page", enabled: true, match: ["/", "/l/*"], exclude: ["/l/admin*"] },
    { room: "sale", mode: "page", enabled: true, match: ["/sale*"], exclude: [] },
    { room: "off", mode: "page", enabled: false, match: ["/closed"], exclude: [] },
    { room: "later", mode: "flow", enabled: true, match: ["/checkout*"], exclude: [] },
  ],
};

type Reply = { status?: number; body?: unknown; throws?: boolean };

/** 엔진 응답을 경로별로 흉내 냄 */
function makeEnv(replies: Record<string, Reply> = { "/q/acme/rules": { body: RULES } }): SpillwayEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    SPILLWAY_TOKEN_SECRET: SECRET,
    SPILLWAY_ENGINE: {
      fetch: vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        calls.push(path);
        const r = replies[path] ?? { status: 404 };
        if (r.throws) throw new Error("engine down");
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
      }),
    } as unknown as Fetcher,
  };
}

const nav = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html", ...headers } });

const access = (o: { exp?: number; tn?: string; r?: string } = {}) =>
  signToken({ t: "ac", tn: o.tn ?? "acme", r: o.r ?? "main", n: 1, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, kid: 1 }, SECRET);

const waitPath = (res: Response | null) => {
  const loc = new URL(res!.headers.get("location")!);
  return loc.origin + loc.pathname;
};

beforeEach(() => _resetCache());

describe("엔진 규칙 (기본)", () => {
  it("규칙에 맞는 대기실의 대기 화면으로 보낸다", async () => {
    const env = makeEnv();
    const r1 = await guardPage(nav("https://site.com/"), env, opts);
    expect(r1?.status).toBe(302);
    expect(waitPath(r1)).toBe(`${ENGINE}/q/acme/main/wait`);
    expect(new URL(r1!.headers.get("location")!).searchParams.get("return")).toBe("https://site.com/");

    expect(waitPath(await guardPage(nav("https://site.com/l/123"), env, opts))).toBe(`${ENGINE}/q/acme/main/wait`);
    expect(waitPath(await guardPage(nav("https://site.com/sale/shoes"), env, opts))).toBe(`${ENGINE}/q/acme/sale/wait`);
    expect(env.calls).toEqual(["/q/acme/rules"]); // 규칙은 한 번만 받아 옴 (캐시)
  });

  it("규칙에 없는 경로, exclude, 꺼진 대기실, 미지원 mode 는 통과", async () => {
    const env = makeEnv();
    for (const u of ["/about", "/l", "/l/admin/x", "/closed", "/checkout/1"]) {
      expect(await guardPage(nav(`https://site.com${u}`), env, opts)).toBeNull();
    }
  });

  it("정적 파일은 규칙이 넓어도 엔진에 묻지 않고 통과", async () => {
    const env = makeEnv({ "/q/acme/rules": { body: { rooms: [{ room: "all", mode: "page", enabled: true, match: ["/*"], exclude: [] }] } } });
    const assets = [
      new Request("https://site.com/css/style.css"),
      new Request("https://site.com/js/app.js"),
      new Request("https://site.com/og.png"),
      new Request("https://site.com/fonts/a.woff2"),
      new Request("https://site.com/img?id=3", { headers: { "sec-fetch-dest": "image" } }),
    ];
    for (const req of assets) expect(await guardPage(req, env, opts)).toBeNull();
    expect(env.calls).toHaveLength(0);
    // 페이지는 걸림
    expect((await guardPage(nav("https://site.com/anything"), env, opts))?.status).toBe(302);
  });

  it("skipStatic:false 면 정적 파일도 규칙대로", async () => {
    const env = makeEnv({ "/q/acme/rules": { body: { rooms: [{ room: "all", mode: "page", enabled: true, match: ["/*"], exclude: [] }] } } });
    const res = await guardPage(new Request("https://site.com/app.js", { headers: { "sec-fetch-mode": "no-cors" } }), env, { ...opts, skipStatic: false });
    expect(res?.status).toBe(429);
  });

  it("siteOrigin 이 있으면 돌아갈 주소를 방문자 주소로 만든다 (CloudFront 등 프록시 뒤)", async () => {
    const res = await guardPage(nav("https://site.acme.workers.dev/l/9?a=1"), makeEnv(), { ...opts, siteOrigin: "https://www.acme.com" });
    expect(new URL(res!.headers.get("location")!).searchParams.get("return")).toBe("https://www.acme.com/l/9?a=1");
    const bad = await guardPage(nav("https://site.com/"), makeEnv(), { ...opts, siteOrigin: "not a url" });
    expect(new URL(bad!.headers.get("location")!).searchParams.get("return")).toBe("https://site.com/");
  });

  it("fetch 요청에는 429 를 준다", async () => {
    const req = new Request("https://site.com/sale/data", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } });
    expect((await guardPage(req, makeEnv(), opts))?.status).toBe(429);
  });

  it("돌아온 토큰을 쿠키로 바꾸고 깨끗한 URL 로 보낸다", async () => {
    const tok = await access();
    const res = await guardPage(nav(`https://site.com/?x=1&__spw=${tok}`), makeEnv(), opts);
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toBe("/?x=1"); // 상대 주소 (프록시 뒤에서도 방문자 주소 유지)
    expect(res!.headers.get("set-cookie")).toContain(`${COOKIE}=${tok}`);
  });

  it("유효한 쿠키면 통과, 다른 대기실 쿠키로는 통과 못 함", async () => {
    const tok = await access();
    expect(await guardPage(nav("https://site.com/", { cookie: `${COOKIE}=${tok}` }), makeEnv(), opts)).toBeNull();
    // main 대기실 토큰을 sale 경로 쿠키 이름에 넣어도 거부
    const req = nav("https://site.com/sale", { cookie: `${cookieName("acme", "sale")}=${tok}` });
    expect((await guardPage(req, makeEnv(), opts))?.status).toBe(302);
  });

  it("만료·다른 고객사·다른 키로 서명된 토큰은 다시 줄을 세운다", async () => {
    const bad = [
      await access({ exp: Math.floor(Date.now() / 1000) - 1 }),
      await access({ tn: "other" }),
      await signToken({ t: "ac", tn: "acme", r: "main", n: 1, exp: 2_000_000_000, kid: 1 }, "other-tenant-key"),
    ];
    for (const tok of bad) {
      expect((await guardPage(nav("https://site.com/", { cookie: `${COOKIE}=${tok}` }), makeEnv(), opts))?.status).toBe(302);
    }
  });

  it("fail-open: 엔진 오류·응답 없음·고객사 없음·봇·POST", async () => {
    for (const reply of [{ status: 500 }, { throws: true }, { status: 404 }] as Reply[]) {
      _resetCache();
      expect(await guardPage(nav("https://site.com/"), makeEnv({ "/q/acme/rules": reply }), opts)).toBeNull();
    }
    _resetCache();
    expect(await guardPage(nav("https://site.com/", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }), makeEnv(), opts)).toBeNull();
    expect(await guardPage(new Request("https://site.com/", { method: "POST" }), makeEnv(), opts)).toBeNull();
  });
});

describe("코드 규칙 (room + protect, v0.2 방식)", () => {
  const codeOpts: GuardOptions = { tenant: "acme", engineUrl: ENGINE, room: "sale", protect: ["/reserve"], exclude: ["/reserve/admin"] };
  const env = () => makeEnv({ "/q/acme/sale/check": { body: { enabled: true } } });

  it("protect 경로만 /check 로 확인하고 대기 화면으로", async () => {
    const e = env();
    expect(await guardPage(nav("https://site.com/"), e, codeOpts)).toBeNull();
    expect(await guardPage(nav("https://site.com/reserve/admin/x"), e, codeOpts)).toBeNull();
    expect(waitPath(await guardPage(nav("https://site.com/reserve/1"), e, codeOpts))).toBe(`${ENGINE}/q/acme/sale/wait`);
    expect(e.calls).toEqual(["/q/acme/sale/check"]);
  });

  it("room 만 있고 protect 가 없으면 통과", async () => {
    expect(await guardPage(nav("https://site.com/reserve"), env(), { tenant: "acme", engineUrl: ENGINE, room: "sale" })).toBeNull();
  });
});

describe("helpers", () => {
  it("globMatch", () => {
    expect(globMatch("/", "/")).toBe(true);
    expect(globMatch("/", "/a")).toBe(false);
    expect(globMatch("/l/*", "/l/1")).toBe(true);
    expect(globMatch("/l/*", "/l/1/x")).toBe(true);
    expect(globMatch("/l/*", "/l")).toBe(false);
    expect(globMatch("/event*", "/events")).toBe(true);
    expect(globMatch("/a.b", "/axb")).toBe(false); // . 은 그대로 비교
    expect(globMatch("/index.html", "/index.html")).toBe(true);
  });

  it("isStaticAsset", () => {
    const u = (p: string) => new URL(`https://site.com${p}`);
    expect(isStaticAsset(new Request("https://site.com/a.css"), u("/a.css"))).toBe(true);
    expect(isStaticAsset(new Request("https://site.com/A.PNG"), u("/A.PNG"))).toBe(true);
    expect(isStaticAsset(new Request("https://site.com/index.html"), u("/index.html"))).toBe(false);
    expect(isStaticAsset(new Request("https://site.com/"), u("/"))).toBe(false);
    expect(isStaticAsset(new Request("https://site.com/x", { headers: { "sec-fetch-dest": "font" } }), u("/x"))).toBe(true);
    expect(isStaticAsset(new Request("https://site.com/x", { headers: { "sec-fetch-dest": "document" } }), u("/x"))).toBe(false);
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

describe("버튼·이벤트 방식 (action)", () => {
  const ACTION_RULES = {
    tenant: "acme",
    rooms: [
      { room: "main", mode: "page", enabled: true, match: ["/"], exclude: [] },
      { room: "send", mode: "action", enabled: true, match: ["POST /api/letters", "/api/vote/*"], exclude: ["/api/vote/result"] },
      { room: "paused", mode: "action", enabled: false, match: ["POST /api/paused"], exclude: [] },
    ],
  };
  const env = () => makeEnv({ "/q/acme/rules": { body: ACTION_RULES } });
  const post = (path: string, headers: Record<string, string> = {}) => new Request("https://site.com" + path, { method: "POST", headers });
  const sendToken = () => access({ r: "send" });

  it("규칙 매칭: 메서드 + 경로, 메서드 없는 경로는 모든 메서드", () => {
    expect(actionMatch("POST /api/letters", "post", "/api/letters")).toBe(true);
    expect(actionMatch("POST /api/letters", "GET", "/api/letters")).toBe(false);
    expect(actionMatch("/api/vote/*", "PUT", "/api/vote/3")).toBe(true);
    expect(actionMatch("/api/vote/*", "PUT", "/api/other")).toBe(false);
  });

  it("입장권 없이 막힌 API 를 부르면 429 queued", async () => {
    const res = await guardPage(post("/api/letters"), env(), opts);
    expect(res!.status).toBe(429);
    expect(await res!.json()).toMatchObject({ spillway: "queued", mode: "action", room: "send" });
  });

  it("헤더나 쿠키에 입장권이 있으면 통과", async () => {
    const t = await sendToken();
    expect(await guardPage(post("/api/letters", { [ACTION_HEADER]: t }), env(), opts)).toBeNull();
    expect(await guardPage(post("/api/letters", { cookie: `${cookieName("acme", "send")}=${t}` }), env(), opts)).toBeNull();
  });

  it("다른 대기실의 입장권이나 만료된 입장권은 거부", async () => {
    const other = await access({ r: "main" });
    expect((await guardPage(post("/api/letters", { [ACTION_HEADER]: other }), env(), opts))!.status).toBe(429);
    const old = await access({ r: "send", exp: Math.floor(Date.now() / 1000) - 5 });
    expect((await guardPage(post("/api/letters", { [ACTION_HEADER]: old }), env(), opts))!.status).toBe(429);
  });

  it("규칙에 없는 메서드·경로, 제외 경로, 꺼진 대기실, OPTIONS 는 통과", async () => {
    expect(await guardPage(new Request("https://site.com/api/letters"), env(), opts)).toBeNull(); // GET
    expect(await guardPage(post("/api/vote/result"), env(), opts)).toBeNull();
    expect(await guardPage(post("/api/paused"), env(), opts)).toBeNull();
    expect(await guardPage(new Request("https://site.com/api/letters", { method: "OPTIONS" }), env(), opts)).toBeNull();
  });

  it("엔진 장애 때는 통과 (fail-open)", async () => {
    expect(await guardPage(post("/api/letters"), makeEnv({ "/q/acme/rules": { throws: true } }), opts)).toBeNull();
  });

  it("페이지 방식은 그대로 동작", async () => {
    const res = await guardPage(nav("https://site.com/"), env(), opts);
    expect(res!.status).toBe(302);
  });
});
