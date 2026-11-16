// 기준선: Cloudflare 가드 withSpillway 를 Node http 서버에서 그대로 실행 (Workers 와 같은 Request/Response)
import http from "node:http";
import { withSpillway } from "spillway-guard";

const env = { SPILLWAY_TOKEN_SECRET: process.env.SPILLWAY_TOKEN_SECRET };
const opts = { tenant: process.env.T, engineUrl: process.env.E, siteOrigin: "http://localhost:8788" };
http.createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const request = new Request("http://localhost:8788" + req.url, { method: req.method, headers });
  const out = await withSpillway(request, env, opts, (r) => new Response(new URL(r.url).pathname.startsWith("/api/") ? "API OK" : "SITE OK"));
  out.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
  if (out.headers.getSetCookie().length) res.setHeader("set-cookie", out.headers.getSetCookie());
  res.writeHead(out.status);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(8788, "127.0.0.1", () => console.log("workers-baseline test site on 8788"));
