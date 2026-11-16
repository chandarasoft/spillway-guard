package spillway;

import javax.servlet.Filter;
import javax.servlet.FilterChain;
import javax.servlet.FilterConfig;
import javax.servlet.ServletException;
import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Spillway 서블릿 필터 (javax — Spring Boot 2.x, 전자정부 표준프레임워크, Tomcat 9 이하)
 *
 * 설정 (init-param 또는 생성자 Options):
 *   tenant      고객사 id                         (필수)
 *   engineUrl   엔진 주소                          (필수)
 *   siteOrigin  방문자가 보는 사이트 주소            (프록시·CDN 뒤일 때)
 *   서명 키      환경 변수 SPILLWAY_TOKEN_SECRET 또는 JVM 옵션 -Dspillway.tokenSecret=
 */
public class SpillwayFilter implements Filter {

    private SpillwayGuard guard;

    /** web.xml 등록용 (init() 에서 init-param 을 읽음) */
    public SpillwayFilter() {}

    /** 코드 등록용 (Spring Boot FilterRegistrationBean 등) */
    public SpillwayFilter(SpillwayGuard.Options options) {
        this.guard = new SpillwayGuard(options);
    }

    @Override
    public void init(FilterConfig cfg) {
        if (guard != null) return;
        SpillwayGuard.Options o = new SpillwayGuard.Options();
        o.tenant = param(cfg, "tenant", "SPILLWAY_TENANT");
        o.engineUrl = param(cfg, "engineUrl", "SPILLWAY_ENGINE_URL");
        o.siteOrigin = param(cfg, "siteOrigin", "SPILLWAY_SITE_ORIGIN");
        o.secret = secretFromEnv();
        guard = new SpillwayGuard(o);
    }

    /** 서명 키: 환경 변수 SPILLWAY_TOKEN_SECRET → JVM 옵션 spillway.tokenSecret */
    public static String secretFromEnv() {
        String s = System.getenv("SPILLWAY_TOKEN_SECRET");
        return s != null && !s.isEmpty() ? s : System.getProperty("spillway.tokenSecret");
    }

    private static String param(FilterConfig cfg, String name, String env) {
        String v = cfg.getInitParameter(name);
        if (v == null || v.isEmpty()) v = System.getenv(env);
        return v == null || v.isEmpty() ? null : v;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) throws IOException, ServletException {
        if (guard == null || !(request instanceof HttpServletRequest)) {
            chain.doFilter(request, response);
            return;
        }
        final HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;
        SpillwayGuard.Decision d = guard.decide(new SpillwayGuard.Req() {
            public String method() { return req.getMethod(); }
            public String path() { return req.getRequestURI(); }
            public String query() { return req.getQueryString(); }
            public String url() {
                String q = req.getQueryString();
                return req.getRequestURL().toString() + (q == null ? "" : "?" + q);
            }
            public String header(String name) { return req.getHeader(name); }
        });

        if (d.setCookie != null) res.addHeader("Set-Cookie", d.setCookie);
        switch (d.type) {
            case REDIRECT:
                res.setStatus(302);
                res.setHeader("Location", d.location);
                res.setHeader("Cache-Control", "no-store");
                return;
            case RESPOND:
                res.setStatus(d.status);
                res.setHeader("Cache-Control", "no-store");
                res.setHeader("Retry-After", "5");
                res.setContentType(d.contentType + ";charset=UTF-8");
                res.getOutputStream().write(d.body.getBytes(StandardCharsets.UTF_8));
                return;
            default:
                // 입장권이 든 응답이 공유 캐시에 저장되지 않게 (다른 방문자에게 같은 입장권이 나가는 것을 막음)
                if (d.setCookie != null) res.setHeader("Cache-Control", "private, no-store");
                chain.doFilter(request, response);
        }
    }

    @Override
    public void destroy() {}
}
