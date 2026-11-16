// Spillway — Next.js 16+ (proxy.ts, Node.js 런타임). Next.js 15 이하는 파일 이름을 middleware.ts, 함수 이름을 middleware 로.
import { NextResponse, type NextRequest } from "next/server";
import { withSpillway } from "spillway-guard";

const SPILLWAY = {
  tenant: process.env.SPILLWAY_TENANT!,            // 고객사 id
  engineUrl: process.env.SPILLWAY_ENGINE_URL!,     // 엔진 주소
  siteOrigin: process.env.SPILLWAY_SITE_ORIGIN,    // (선택) 프록시·CDN 뒤일 때 방문자가 보는 주소
};
const env = { SPILLWAY_TOKEN_SECRET: process.env.SPILLWAY_TOKEN_SECRET ?? "" };
const PASS = "x-spillway-pass";

export async function proxy(request: NextRequest) {
  // 통과하면 가드가 표시 응답에 입장 쿠키를 붙여 돌려줌 → 원래 페이지로 진행
  const out = await withSpillway(request, env, SPILLWAY, () => new Response(null, { status: 204, headers: { [PASS]: "1" } }));
  if (!out.headers.has(PASS)) {
    // 대기 화면으로 302, 또는 429. Next.js 는 상대 주소 Location 을 받지 않으므로 절대 주소로 바꿈
    const loc = out.headers.get("location");
    if (loc && loc.startsWith("/")) {
      const headers = new Headers(out.headers);
      headers.set("location", new URL(loc, SPILLWAY.siteOrigin || request.url).toString());
      return new Response(null, { status: out.status, headers });
    }
    return out;
  }
  const res = NextResponse.next();
  for (const c of out.headers.getSetCookie()) res.headers.append("set-cookie", c);
  if (out.headers.getSetCookie().length) res.headers.set("cache-control", "private, no-store");
  return res;
}

export const config = {
  matcher: [
    {
      // Next 내부 파일은 제외. 링크 미리 가져오기(prefetch)는 자리를 차지하지 않도록 제외
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
