/**
 * 기존 사이트 Worker 에 Spillway 를 붙이는 예시.
 * 사이트 프로젝트에서: npm i github:chandarasoft/spillway-guard#v0.3.0
 */
import { guardPage, type SpillwayEnv } from "spillway-guard";

interface Env extends SpillwayEnv {
  SPILLWAY_ENGINE_URL: string; // vars 로 설정 (로컬은 .dev.vars 에서 http://localhost:8787)
  // 사이트가 원래 쓰던 바인딩들 (DB, ASSETS 등)
}

// 어느 URL 에 대기열을 걸지는 엔진의 대기실 설정(tenants/{tenant}/rooms/*.json 의 match)에서 정합니다.
const SPILLWAY = { tenant: "chandarasoft" };

// 코드에서 직접 정하고 싶다면 (v0.2 방식):
// const SPILLWAY = { tenant: "chandarasoft", room: "main", protect: ["/reserve"], exclude: ["/reserve/admin"] };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ① 맨 앞에서 가드 — Response 가 오면 그대로 반환, null 이면 통과
    const blocked = await guardPage(request, env, { ...SPILLWAY, engineUrl: env.SPILLWAY_ENGINE_URL });
    if (blocked) return blocked;

    // ② 원래 사이트 처리
    const url = new URL(request.url);
    if (url.pathname.startsWith("/reserve")) {
      return new Response(`<h1>예약 페이지</h1><p>대기열을 통과했습니다. (${new Date().toISOString()})</p>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(`<h1>홈</h1><a href="/reserve">예약하러 가기</a>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
