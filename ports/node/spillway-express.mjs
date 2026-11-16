/**
 * Spillway — Express(Node.js 20+) 연결 코드
 * 공식 가드(spillway-guard)를 그대로 쓰고, Express 요청을 웹 표준 Request 로 바꿔 넘깁니다.
 *
 *   npm i github:chandarasoft/spillway-guard#v0.6.1
 *   app.use(spillway({ tenant: "acme-shop", engineUrl: process.env.SPILLWAY_ENGINE_URL }));
 *
 * 서명 키는 환경 변수 SPILLWAY_TOKEN_SECRET 에서 읽습니다.
 * 프록시(Nginx·ALB 등) 뒤라면 siteOrigin 옵션(방문자가 보는 주소)을 주세요.
 */
import { withSpillway } from "spillway-guard";

const PASS = "x-spillway-pass";

export function spillway(opts, env = process.env) {
  return async function spillwayMiddleware(req, res, next) {
    let out;
    try {
      const url = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      // 통과하면 가드가 이 표시 응답에 입장 쿠키를 붙여 돌려줌 → Express 처리로 넘김
      out = await withSpillway(new Request(url, { method: req.method, headers }), env, opts,
        () => new Response(null, { status: 204, headers: { [PASS]: "1" } }));
    } catch (err) {
      console.error("spillway (fail-open)", err);
      return next();
    }
    const cookies = out.headers.getSetCookie();
    if (out.headers.has(PASS)) {
      if (cookies.length) {
        res.append("set-cookie", cookies);
        res.setHeader("cache-control", "private, no-store"); // 입장권이 공유 캐시에 남지 않게
      }
      return next();
    }
    res.status(out.status);
    out.headers.forEach((value, name) => { if (name !== "set-cookie") res.setHeader(name, value); });
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.end(Buffer.from(await out.arrayBuffer()));
  };
}
