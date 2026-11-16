// Spillway 가드 적합성 시험 — 언어와 상관없이 "사이트(가드)"를 HTTP 로 두드려 같은 결과가 나오는지 봅니다.
//   준비: 엔진(로컬 8787) + 시험 사이트(8788, 통과하면 "SITE OK" / /api/* 는 "API OK")
//   node conformance.mjs            기본 시나리오
//   node conformance.mjs --down     엔진을 끈 뒤 fail-open 확인
const E = process.env.E ?? "http://127.0.0.1:8787";
const SITE = "http://localhost:8788";
const T = process.env.T ?? "conf";
const ADMIN = { "x-admin-key": process.env.ADMIN_KEY ?? "test-admin-key", "content-type": "application/json" };
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html" };
let pass = 0, fail = 0;

// Node fetch(undici)는 sec-fetch-* 헤더를 덮어쓰므로, 사이트 요청은 node:http 로 보냄 (브라우저와 같은 헤더)
import http from "node:http";
function raw(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const h = res.headers;
        resolve({
          status: res.statusCode,
          headers: { get: (n) => { const v = h[n.toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v ?? null; }, getSetCookie: () => h["set-cookie"] ?? [] },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const site = (path, init = {}) => raw(SITE + path, init);
const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}${!c && x !== undefined ? "  → " + JSON.stringify(x) : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function store(jar, res) {
  for (const sc of res.headers.getSetCookie()) {
    const [kv] = sc.split(";");
    const i = kv.indexOf("=");
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1);
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

/** 브라우저 흉내: 리다이렉트를 따라가고, 엔진 대기 화면에 닿으면 멈춤 */
async function browse(url, jar = {}, headers = NAV, max = 10) {
  const hops = [];
  for (let i = 0; i < max; i++) {
    const u = new URL(url, SITE);
    hops.push(u.origin === SITE ? u.pathname + u.search.replace(/__spw=[^&]+/, "__spw=…") : "ENGINE" + u.pathname);
    const h = { ...headers };
    if (u.origin === SITE && Object.keys(jar).length) h.cookie = cookieHeader(jar);
    const res = u.origin === SITE ? await raw(u, { headers: h }) : await fetch(u, { headers: h, redirect: "manual" });
    if (u.origin === SITE) store(jar, res);
    if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get("location"), u).toString(); continue; }
    return { status: res.status, url: u.toString(), hops, body: await res.text(), res };
  }
  return { status: "LOOP", hops };
}

const onWait = (r) => r.url && r.url.startsWith(E) && r.url.includes("/wait");

/** 대기 화면의 스크립트 흉내: join → (필요하면 일괄 입장) → status → 입장권으로 돌아감 */
async function finishWait(r, jar, room) {
  const ret = new URL(r.url).searchParams.get("return");
  let j = await (await fetch(`${E}/q/${T}/${room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  let token = j.token;
  for (let i = 0; !token && i < 10; i++) {
    await fetch(`${E}/q/${T}/${room}/flush`, { method: "POST", headers: ADMIN });
    const s = await (await fetch(`${E}/q/${T}/${room}/status?ticket=${encodeURIComponent(j.ticket)}`)).json();
    token = s.token;
    if (!token) await sleep(500);
  }
  const back = new URL(ret);
  back.searchParams.set("__spw", token);
  return { ret, token, r: await browse(back.toString(), jar) };
}

let v = Date.now();
const tenant = { enabled: true, keyVersion: 1, origins: [SITE], defaults: { admitPerSec: 1 } };
const rooms = (o = {}) => ({
  main: { enabled: true, mode: "page", policy: "capacity", maxActive: 1, accessTtlSec: 600, match: ["/reserve*"], exclude: ["/reserve/free"], ...(o.main ?? {}) },
  buy: { enabled: true, mode: "action", policy: "capacity", maxActive: 1, accessTtlSec: 600, match: ["POST /api/orders"], exclude: [], ...(o.buy ?? {}) },
});
const publish = async (rs) => {
  const res = await fetch(`${E}/admin/tenants/${T}/config`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ version: ++v, tenant, rooms: rs }) });
  if (!res.ok) throw new Error("publish " + res.status + " " + (await res.text()));
};
const reset = () => Promise.all(["main", "buy"].map((r) => fetch(`${E}/q/${T}/${r}/reset`, { method: "POST", headers: ADMIN })));

if (process.argv.includes("--down")) {
  // 엔진이 꺼진 상태: 가드 캐시(10초)가 지난 뒤 보호 경로가 막히지 않아야 함
  const t0 = Date.now();
  const r = await browse(SITE + "/reserve");
  ok(r.body === "SITE OK", "엔진 장애 → 보호 경로도 통과 (fail-open)", r.hops);
  ok(Date.now() - t0 < 5000, `엔진 장애 때 응답 시간 ${Date.now() - t0}ms (< 5초)`);
  const a = await site("/api/orders", { method: "POST" });
  ok(a.status === 200, "엔진 장애 → 버튼 API 도 통과", a.status);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

await publish(rooms());
await reset();
await sleep(11_000); // 가드 규칙 캐시(10초)가 새 설정을 읽도록

// ── 단일 페이지 ──
let r = await browse(SITE + "/about");
ok(r.body === "SITE OK" && r.hops.length === 1, "대기실 규칙에 없는 경로 → 통과", r.hops);
const A = {};
r = await browse(SITE + "/reserve", A);
ok(r.body === "SITE OK" && !r.hops.some((x) => x.startsWith("ENGINE")), "자리 있음 → 대기 화면 없이 바로 입장", r.hops);
ok(Object.keys(A).includes(`__spw_${T}_main`), "바로 입장 시 입장 쿠키 __spw_{tenant}_{room}", Object.keys(A));
const B = {};
r = await browse(SITE + "/reserve", B);
ok(onWait(r) && r.status === 200, "자리 없음 → 엔진 대기 화면으로 302", r.hops);
ok(onWait(r) && new URL(r.url).searchParams.get("return") === SITE + "/reserve", "대기 화면 return = 방문자 주소", r.url);
r = await browse(SITE + "/reserve/app.css", {}, { "sec-fetch-dest": "style" });
ok(r.body === "SITE OK", "정적 파일 → 통과 (자리 없어도)", r.hops);
r = await browse(SITE + "/reserve/free");
ok(r.body === "SITE OK", "제외 경로 → 통과", r.hops);
r = await browse(SITE + "/reserve", {}, { ...NAV, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
ok(r.body === "SITE OK", "검색엔진 봇 → 통과", r.hops);
r = await browse(SITE + "/reserve", A);
ok(r.body === "SITE OK" && r.hops.length === 1, "입장 쿠키로 재방문 → 통과", r.hops);
r = await browse(SITE + "/reserve", {}, { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "*/*" });
let j = r.status === 429 ? JSON.parse(r.body) : null;
ok(j?.spillway === "queued" && String(j.waitUrl).includes(`/q/${T}/main/wait`), "fetch/XHR → 429 {spillway:queued, waitUrl}", { status: r.status, body: r.body });

// 대기 → 입장권 → 쿠키
r = await browse(SITE + "/reserve?x=1&y=%ED%95%9C", B);
const w = await finishWait(r, B, "main");
ok(w.ret === SITE + "/reserve?x=1&y=%ED%95%9C", "return 에 원래 쿼리 유지", w.ret);
ok(w.r.body === "SITE OK", "대기 후 ?__spw=입장권 → 쿠키 저장 → 통과", w.r.hops);
ok(w.r.hops[1] === "/reserve?x=1&y=%ED%95%9C", "입장권 파라미터만 지운 주소로 302", w.r.hops);
ok(Object.keys(B).includes(`__spw_${T}_main`), "대기 후 입장 쿠키 저장", Object.keys(B));

const C = {};
r = await browse(SITE + "/reserve?__spw=eyJ0IjoiYWMifQ.AAAA", C);
ok(onWait(r), "위조 입장권 → 다시 줄 섬", r.hops);
const forgedBody = Buffer.from(JSON.stringify({ t: "ac", tn: T, r: "main", n: 1, exp: 4102444800, kid: 1 })).toString("base64url");
r = await browse(SITE + "/reserve", { [`__spw_${T}_main`]: forgedBody + "." + w.token.split(".")[1] });
ok(onWait(r), "다른 본문에 서명만 옮긴 입장권 → 거부", r.hops);
r = await browse(SITE + "/reserve", { [`__spw_${T}_main`]: "x".repeat(3000) });
ok(onWait(r), "너무 긴 입장권 → 거부", r.hops);

// ── 버튼·이벤트 (API) ──
const D = {};
let res = await site("/api/orders", { method: "POST" });
store(D, res);
ok(res.status === 200 && (await res.text()) === "API OK" && D[`__spw_${T}_buy`], "API: 자리 있음 → 바로 통과 + 입장 쿠키", { status: res.status, cookies: Object.keys(D) });
res = await site("/api/orders", { method: "POST" });
j = res.status === 429 ? await res.json() : null;
ok(j?.spillway === "queued" && j.mode === "action" && j.room === "buy" && j.tenant === T, "API: 자리 없음·입장권 없음 → 429 {spillway:queued, mode:action}", { status: res.status, j });
res = await site("/api/orders", { method: "POST", headers: { "x-spillway-token": D[`__spw_${T}_buy`] } });
ok(res.status === 200, "API: x-spillway-token 헤더 → 통과", res.status);
res = await site("/api/orders", { method: "POST", headers: { cookie: cookieHeader(D) } });
ok(res.status === 200, "API: 입장 쿠키 → 통과", res.status);
res = await site("/api/orders", { method: "POST", headers: { "x-spillway-token": A[`__spw_${T}_main`] } });
ok(res.status === 429, "API: 다른 대기실(main) 입장권 → 거부", res.status);
res = await site("/api/orders", { method: "PUT" });
ok(res.status === 200, "API: 규칙에 없는 메서드(PUT) → 통과", res.status);
res = await site("/api/orders", { method: "OPTIONS" });
ok(res.status === 200, "API: OPTIONS(CORS 사전 요청) → 통과", res.status);

// ── 끄기 ──
await publish(rooms({ main: { enabled: false }, buy: { enabled: false } }));
await sleep(16_000); // 엔진 규칙 캐시 5초 + 가드 캐시 10초
r = await browse(SITE + "/reserve");
ok(r.body === "SITE OK" && r.hops.length === 1, "대기실 끔 → 엔진 거치지 않고 통과", r.hops);
res = await site("/api/orders", { method: "POST" });
ok(res.status === 200, "버튼 대기실 끔 → API 통과", res.status);
await publish(rooms());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
