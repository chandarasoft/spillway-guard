import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import spillway.SpillwayGuard;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/** 시험용 사이트: SpillwayGuard 판단을 SpillwayFilter 와 같은 방식으로 적용 (서블릿 컨테이너 대신 JDK HttpServer) */
public class TestSite {
    public static void main(String[] a) throws Exception {
        SpillwayGuard.Options o = new SpillwayGuard.Options();
        o.tenant = System.getenv("T");
        o.engineUrl = System.getenv("E");
        o.secret = System.getenv("SPILLWAY_TOKEN_SECRET");
        o.siteOrigin = "http://localhost:8788";
        final SpillwayGuard g = new SpillwayGuard(o);
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 8788), 0);
        s.createContext("/", (HttpExchange x) -> {
            SpillwayGuard.Decision d = g.decide(new SpillwayGuard.Req() {
                public String method() { return x.getRequestMethod(); }
                public String path() { return x.getRequestURI().getRawPath(); }
                public String query() { return x.getRequestURI().getRawQuery(); }
                public String url() { return "http://localhost:8788" + x.getRequestURI(); }
                public String header(String n) { return x.getRequestHeaders().getFirst(n); }
            });
            if (d.setCookie != null) x.getResponseHeaders().add("Set-Cookie", d.setCookie);
            byte[] body;
            int status;
            if (d.type == SpillwayGuard.Type.REDIRECT) { x.getResponseHeaders().set("Location", d.location); status = 302; body = new byte[0]; }
            else if (d.type == SpillwayGuard.Type.RESPOND) { x.getResponseHeaders().set("content-type", d.contentType); status = d.status; body = d.body.getBytes(StandardCharsets.UTF_8); }
            else { status = 200; body = (x.getRequestURI().getPath().startsWith("/api/") ? "API OK" : "SITE OK").getBytes(StandardCharsets.UTF_8); }
            x.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
            if (body.length > 0) x.getResponseBody().write(body);
            x.close();
        });
        s.start();
        System.out.println("java test site on 8788");
    }
}
