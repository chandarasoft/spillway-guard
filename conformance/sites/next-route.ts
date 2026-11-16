export const dynamic = "force-dynamic";
const ok = (req: Request) => new Response(new URL(req.url).pathname.startsWith("/api/") ? "API OK" : "SITE OK");
export const GET = ok;
export const POST = ok;
export const PUT = ok;
export const OPTIONS = ok;
