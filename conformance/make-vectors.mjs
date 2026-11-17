// 공통 테스트 벡터 생성 — 기준은 공식 가드(spillway-guard)의 구현입니다.
//   node make-vectors.mjs > ../docs/test-vectors.json
import { createHmac } from "node:crypto";
import { signToken, verifyAccess, globMatch, actionMatch } from "spillway-guard";

const secret = "spillway-test-vector-secret";
const tenant = "acme", room = "sale";
const FUTURE = 4102444800; // 2100-01-01
const PAST = 1000000000;   // 2001-09-09

const ac = (o = {}) => ({ t: "ac", tn: tenant, r: room, n: 7, exp: FUTURE, kid: 1, ...o });
const good = await signToken(ac(), secret);
const [body, sig] = good.split(".");
const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
const notJson = Buffer.from("not json").toString("base64url");

const tokens = [
  ["유효한 입장권", good, true],
  ["다른 대기실", await signToken(ac({ r: "other" }), secret), false],
  ["다른 고객사", await signToken(ac({ tn: "other" }), secret), false],
  ["입장권이 아닌 종류 (t=tk 순번표)", await signToken(ac({ t: "tk" }), secret), false],
  ["만료됨", await signToken(ac({ exp: PAST }), secret), false],
  ["exp 가 문자열", await signToken(ac({ exp: String(FUTURE) }), secret), false],
  ["exp 없음", await signToken({ t: "ac", tn: tenant, r: room, n: 1 }, secret), false],
  ["다른 키로 서명", await signToken(ac(), secret + "x"), false],
  ["본문 변조 (서명 그대로)", Buffer.from(JSON.stringify(ac({ n: 8 }))).toString("base64url") + "." + sig, false],
  ["서명 변조", body + "." + flip(sig), false],
  ["점이 두 개", good + ".x", false],
  ["점이 없음", body + sig, false],
  ["빈 문자열", "", false],
  ["2048자 초과", body + "." + sig + "A".repeat(2049 - good.length), false],
  ["본문이 JSON 이 아님 (서명은 맞음)", notJson + "." + createHmac("sha256", secret).update(notJson).digest("base64url"), false],
];
const verify = [];
for (const [name, token, valid] of tokens) {
  const got = (await verifyAccess(token, secret, tenant, room)) !== null;
  if (got !== valid) throw new Error(`기준 구현과 다름: ${name}`);
  verify.push({ name, token, valid });
}
const signPayloads = [
  { t: "en", tn: tenant, r: room, iat: 1800000000, exp: 1800000060 },
  { t: "ac", tn: tenant, r: room, n: 1, exp: FUTURE, kid: 1 },
];
const sign = [];
for (const p of signPayloads) {
  const json = JSON.stringify(p);
  sign.push({ payloadJson: json, token: await signToken(p, secret) });
}

const globs = [
  ["/", "/", true], ["/", "/a", false],
  ["/event*", "/event", true], ["/event*", "/events", true], ["/event*", "/event/1", true], ["/event*", "/eve", false],
  ["/l/*", "/l/1", true], ["/l/*", "/l/1/x", true], ["/l/*", "/l", false],
  ["/a.b", "/a.b", true], ["/a.b", "/axb", false],
  ["/p(1)", "/p(1)", true], ["/x+y", "/x+y", true], ["/x+y", "/xxy", false],
  ["*", "/anything/at/all", true], ["/a*b", "/a/x/b", true], ["/a*b", "/a/x/c", false],
];
const glob = globs.map(([pattern, path, match]) => {
  if (globMatch(pattern, path) !== match) throw new Error(`glob ${pattern} ${path}`);
  return { pattern, path, match };
});
const actions = [
  ["POST /api/orders", "POST", "/api/orders", true],
  ["POST /api/orders", "GET", "/api/orders", false],
  ["POST /api/orders", "POST", "/api/orders/1", false],
  ["POST /api/orders*", "POST", "/api/orders/1", true],
  ["/api/vote/*", "PUT", "/api/vote/3", true],
  ["/api/vote/*", "DELETE", "/api/vote/3", true],
  ["api/vote", "POST", "api/vote", false],
  ["PATCH /x", "PATCH", "/x", true],
  ["OPTIONS /x", "OPTIONS", "/x", false],
];
const action = actions.map(([pattern, method, path, match]) => {
  if (actionMatch(pattern, method, path) !== match) throw new Error(`action ${pattern} ${method} ${path}`);
  return { pattern, method, path, match };
});

console.log(JSON.stringify({
  description: "Spillway 연동 프로토콜 v1 공통 테스트 벡터 — 모든 언어의 가드가 같은 결과를 내야 합니다. 기준: spillway-guard v0.6.2",
  secret, tenant, room,
  verifyAccess: verify,
  sign,
  globMatch: glob,
  actionMatch: action,
}, null, 2));
