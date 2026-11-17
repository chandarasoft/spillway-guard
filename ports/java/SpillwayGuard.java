package spillway;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spillway 가드 — Java 참조 구현 (연동 프로토콜 v1)
 *
 * 서블릿 API 에 의존하지 않는 판단 로직입니다. SpillwayFilter(javax / jakarta)가 이 클래스를 씁니다.
 * 요구 사항: Java 8 이상. 외부 라이브러리 없음 (JSON 도 이 파일 안의 작은 파서로 읽습니다)
 *
 * 동작은 Cloudflare 가드(spillway-guard v0.6.2)의 withSpillway 와 같습니다.
 *  - 대기실 규칙은 엔진 GET /q/{tenant}/rules 에서 받아 10초 캐시
 *  - 입장권(__spw_{tenant}_{room} 쿠키 · x-spillway-token 헤더 · ?__spw=)을 고객사 서명 키로 검증
 *  - 자리가 있으면 엔진 POST /enter 로 대기 화면 없이 바로 입장 (응답에 쿠키)
 *  - 판단할 수 없으면 통과 (fail-open)
 */
public final class SpillwayGuard {

    public static final String VERSION = "0.6.2"; // spillway-guard(npm) 와 같은 번호
    public static final String TOKEN_PARAM = "__spw";
    public static final String ACTION_HEADER = "x-spillway-token";

    private static final Logger LOG = Logger.getLogger(SpillwayGuard.class.getName());
    private static final int ENTER_AUTH_TTL_SEC = 60;
    private static final Pattern ACTION_RULE = Pattern.compile("^(GET|POST|PUT|PATCH|DELETE) (/.*)$");
    private static final Pattern EXT = Pattern.compile("\\.([a-zA-Z0-9]+)$");
    private static final Set<String> STATIC_EXT = new HashSet<String>(Arrays.asList(
            "css", "js", "mjs", "cjs", "map", "wasm",
            "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
            "woff", "woff2", "ttf", "otf", "eot",
            "mp4", "webm", "mp3", "ogg", "wav", "m4a",
            "pdf", "txt", "xml", "webmanifest"));
    /** 예전 기본값(검색엔진 봇 User-Agent). User-Agent 는 위장할 수 있어 v0.6.2 부터 기본으로 쓰지 않음 — 위험을 알고 직접 넣을 때만 */
    public static final Pattern DEFAULT_BOTS = Pattern.compile(
            "googlebot|bingbot|yeti|daum|duckduckbot|baiduspider|slurp|kakaotalk-scrap|facebookexternalhit|twitterbot|slackbot|linkedinbot",
            Pattern.CASE_INSENSITIVE);

    // ───────────────────────── 설정 ─────────────────────────

    public static final class Options {
        /** 고객사 id (콘솔 [사이트 연동]) */
        public String tenant;
        /** 엔진 주소. 예: https://queue.spillway.co.kr */
        public String engineUrl;
        /** 고객사 서명 키 (비밀 값 — 환경 변수 등으로) */
        public String secret;
        /** (선택) 방문자가 보는 사이트 주소. 프록시·CDN 뒤에서 요청 주소와 다를 때. 예: https://www.example.com */
        public String siteOrigin;
        /** 규칙 캐시 ms (기본 10초) */
        public long cacheTtlMs = 10_000;
        /** 엔진 호출 시간 제한 ms (기본 1.5초) */
        public int timeoutMs = 1_500;
        /** 자리가 있으면 대기 화면 없이 바로 입장 (기본 true) */
        public boolean serverEnter = true;
        /** 통과시킬 User-Agent (기본: 없음). 매크로가 "Googlebot" 으로 위장하면 대기열을 건너뛰므로 위험을 알고 쓸 때만 */
        public Pattern bypassUserAgents = null;
        /** 정적 파일 자동 통과 (기본 true) */
        public boolean skipStatic = true;
    }

    /** 가드가 보는 요청 (서블릿 등에서 맞춰 줍니다) */
    public interface Req {
        String method();
        /** 경로 (컨텍스트 경로 포함, 쿼리 제외). 예: /event/1 */
        String path();
        /** 원본 쿼리 문자열 (없으면 null) */
        String query();
        /** 요청 전체 주소 (siteOrigin 이 없을 때 돌아올 주소로 씀) */
        String url();
        /** 헤더 값 (없으면 null, 이름은 소문자) */
        String header(String name);
    }

    public enum Type { PASS, REDIRECT, RESPOND }

    /** 판단 결과 */
    public static final class Decision {
        public final Type type;
        public final int status;
        public final String location;
        public final String contentType;
        public final String body;
        /** 붙일 Set-Cookie (없으면 null) */
        public final String setCookie;

        private Decision(Type type, int status, String location, String contentType, String body, String setCookie) {
            this.type = type; this.status = status; this.location = location;
            this.contentType = contentType; this.body = body; this.setCookie = setCookie;
        }
        static final Decision PASS = new Decision(Type.PASS, 0, null, null, null, null);
        static Decision passWithCookie(String c) { return new Decision(Type.PASS, 0, null, null, null, c); }
        static Decision redirect(String loc, String c) { return new Decision(Type.REDIRECT, 302, loc, null, null, c); }
        static Decision queued(String json) { return new Decision(Type.RESPOND, 429, null, "application/json", json, null); }
    }

    // ───────────────────────── 판단 ─────────────────────────

    private final Options o;
    private final byte[] key;
    private volatile Cached rules;

    public SpillwayGuard(Options options) {
        this.o = options;
        this.key = options.secret == null ? null : options.secret.getBytes(StandardCharsets.UTF_8);
        if (o.tenant == null || o.engineUrl == null) throw new IllegalArgumentException("spillway: tenant, engineUrl 은 필수입니다");
        while (o.engineUrl.endsWith("/")) o.engineUrl = o.engineUrl.substring(0, o.engineUrl.length() - 1);
    }

    /** 요청을 판단합니다. 예외가 나면 통과(PASS)를 돌려줍니다. */
    public Decision decide(Req r) {
        try {
            return decideUnsafe(r);
        } catch (RuntimeException e) {
            LOG.warning("spillway guard error (fail-open): " + e);
            return Decision.PASS;
        }
    }

    private Decision decideUnsafe(Req r) {
        if (key == null || key.length == 0) return Decision.PASS; // 서명 키 누락 → 통과
        String method = r.method().toUpperCase(Locale.ROOT);
        String path = r.path();
        boolean readOnly = method.equals("GET") || method.equals("HEAD");
        if (readOnly && o.skipStatic && isStatic(r, path)) return Decision.PASS;

        List<Rule> list = rules();
        if (list == null) return Decision.PASS; // 엔진 장애 → 통과

        // 버튼·이벤트 방식 (API 보호)
        if (!method.equals("OPTIONS")) {
            Rule act = find(list, "action", method, path);
            if (act != null) return act.enabled ? checkAction(r, act) : Decision.PASS;
        }
        if (!readOnly) return Decision.PASS;
        String ua = r.header("user-agent");
        if (o.bypassUserAgents != null && ua != null && o.bypassUserAgents.matcher(ua).find()) return Decision.PASS;

        // 단일 페이지
        Rule hit = find(list, "page", method, path);
        if (hit == null) return Decision.PASS;

        // 대기를 마치고 돌아온 경우: ?__spw=<입장권> → 쿠키로 바꾸고 깨끗한 주소로 302
        String q = r.query();
        String fromQueue = queryParam(q, TOKEN_PARAM);
        if (fromQueue != null) {
            Map<String, Object> p = verifyAccess(fromQueue, hit.room);
            if (p != null) {
                String rest = removeParam(q, TOKEN_PARAM);
                return Decision.redirect(path + (rest.isEmpty() ? "" : "?" + rest), cookie(hit.room, fromQueue, num(p.get("exp"))));
            }
        }
        if (verifyAccess(readCookie(r.header("cookie"), cookieName(hit.room)), hit.room) != null) return Decision.PASS;
        if (!hit.enabled) return Decision.PASS;

        if (canEnter(hit)) {
            Enter e = tryEnter(hit.room);
            if (e.kind == 'p') return Decision.passWithCookie(cookie(hit.room, e.token, e.exp));
            if (e.kind == 'e') return Decision.PASS;
        }

        String wait = o.engineUrl + "/q/" + enc(o.tenant) + "/" + enc(hit.room) + "/wait?return=" + enc(publicUrl(r, path, q));
        if (!isNavigation(r)) return Decision.queued("{\"spillway\":\"queued\",\"waitUrl\":" + jsonStr(wait) + "}");
        return Decision.redirect(wait, null);
    }

    private Decision checkAction(Req r, Rule hit) {
        if (verifyAccess(r.header(ACTION_HEADER), hit.room) != null) return Decision.PASS;
        if (verifyAccess(readCookie(r.header("cookie"), cookieName(hit.room)), hit.room) != null) return Decision.PASS;
        if (canEnter(hit)) {
            Enter e = tryEnter(hit.room);
            if (e.kind == 'p') return Decision.passWithCookie(cookie(hit.room, e.token, e.exp));
            if (e.kind == 'e') return Decision.PASS;
        }
        return Decision.queued("{\"spillway\":\"queued\",\"mode\":\"action\",\"tenant\":" + jsonStr(o.tenant) + ",\"room\":" + jsonStr(hit.room) + "}");
    }

    private boolean canEnter(Rule hit) {
        return o.serverEnter && (hit.phase == null || hit.phase.equals("open"));
    }

    // ───────────────────────── 엔진 호출 ─────────────────────────

    private static final class Rule {
        String room, mode, phase;
        boolean enabled;
        List<String> match = new ArrayList<String>(), exclude = new ArrayList<String>();
    }

    private static final class Cached {
        final List<Rule> value; final long at;
        Cached(List<Rule> v, long at) { this.value = v; this.at = at; }
    }

    /** 대기실 규칙 (캐시). 실패(null)도 캐시해서 엔진 장애 때 매번 기다리지 않음 */
    private List<Rule> rules() {
        Cached c = rules;
        long now = System.currentTimeMillis();
        if (c != null && now - c.at < o.cacheTtlMs) return c.value;
        synchronized (this) {
            c = rules;
            if (c != null && System.currentTimeMillis() - c.at < o.cacheTtlMs) return c.value;
            List<Rule> v = null;
            try {
                Http res = http("GET", "/q/" + enc(o.tenant) + "/rules", null);
                if (res.status == 200) v = parseRules(Json.parse(res.body));
                else if (res.status == 404) LOG.warning("spillway: 엔진에 고객사 " + o.tenant + " 가 없습니다 (통과 처리)");
            } catch (Exception e) {
                v = null;
            }
            rules = new Cached(v, System.currentTimeMillis());
            return v;
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Rule> parseRules(Object body) {
        if (!(body instanceof Map)) return null;
        Object rooms = ((Map<String, Object>) body).get("rooms");
        if (!(rooms instanceof List)) return null;
        List<Rule> out = new ArrayList<Rule>();
        for (Object o : (List<Object>) rooms) {
            if (!(o instanceof Map)) continue;
            Map<String, Object> n = (Map<String, Object>) o;
            Rule r = new Rule();
            r.room = str(n.get("room"));
            r.mode = str(n.get("mode"));
            r.phase = str(n.get("phase"));
            r.enabled = Boolean.TRUE.equals(n.get("enabled"));
            if (r.room == null || r.mode == null) continue;
            if (n.get("match") instanceof List) for (Object m : (List<Object>) n.get("match")) if (m instanceof String) r.match.add((String) m);
            if (n.get("exclude") instanceof List) for (Object m : (List<Object>) n.get("exclude")) if (m instanceof String) r.exclude.add((String) m);
            out.add(r);
        }
        return out;
    }

    private static final class Enter {
        final char kind; final String token; final long exp; // 'p' 입장, 'q' 대기, 'e' 오류
        Enter(char k, String t, long e) { kind = k; token = t; exp = e; }
    }

    /** 엔진 POST /enter — 고객사 키로 서명한 x-spillway-auth 를 붙임 */
    private Enter tryEnter(String room) {
        long iat = nowSec();
        String auth = "{\"t\":\"en\",\"tn\":" + jsonStr(o.tenant) + ",\"r\":" + jsonStr(room)
                + ",\"iat\":" + iat + ",\"exp\":" + (iat + ENTER_AUTH_TTL_SEC) + "}";
        Http res;
        try {
            res = http("POST", "/q/" + enc(o.tenant) + "/" + enc(room) + "/enter", sign(auth));
        } catch (Exception e) {
            return new Enter('e', null, 0);
        }
        if (res.status >= 500) return new Enter('e', null, 0);
        if (res.status != 200) {
            if (res.status == 401) LOG.warning("spillway: /enter 서명이 맞지 않습니다 — 서명 키를 확인하세요 (대기 화면으로 보냄)");
            return new Enter('q', null, 0);
        }
        try {
            Object b = Json.parse(res.body);
            if (!(b instanceof Map)) return new Enter('q', null, 0);
            Map<?, ?> m = (Map<?, ?>) b;
            if (!Boolean.TRUE.equals(m.get("pass")) || !(m.get("token") instanceof String)) return new Enter('q', null, 0);
            String token = (String) m.get("token");
            Map<String, Object> p = verifyAccess(token, room);
            return p == null ? new Enter('q', null, 0) : new Enter('p', token, num(p.get("exp")));
        } catch (Exception e) {
            return new Enter('q', null, 0);
        }
    }

    private static final class Http { int status; String body; }

    private Http http(String method, String path, String auth) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(o.engineUrl + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(o.timeoutMs);
            c.setReadTimeout(o.timeoutMs);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("accept", "application/json");
            if (auth != null) {
                c.setRequestProperty("x-spillway-auth", auth);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(0);
            }
            Http h = new Http();
            h.status = c.getResponseCode();
            InputStream in = h.status >= 400 ? c.getErrorStream() : c.getInputStream();
            h.body = in == null ? "" : readAll(in);
            return h;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws java.io.IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    // ───────────────────────── 토큰 (base64url(JSON) "." base64url(HMAC-SHA256)) ─────────────────────────

    String sign(String payloadJson) {
        String body = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        return body + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(hmac(body));
    }

    private byte[] hmac(String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(body.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 입장권 검증: 서명 · t=ac · 고객사 · 대기실 · 만료. 실패하면 null */
    @SuppressWarnings("unchecked")
    Map<String, Object> verifyAccess(String token, String room) {
        if (token == null || token.isEmpty() || token.length() > 2048) return null;
        int dot = token.indexOf('.');
        if (dot <= 0 || dot != token.lastIndexOf('.')) return null;
        String body = token.substring(0, dot);
        try {
            byte[] sig = Base64.getUrlDecoder().decode(token.substring(dot + 1));
            if (!MessageDigest.isEqual(hmac(body), sig)) return null;
            Object parsed = Json.parse(new String(Base64.getUrlDecoder().decode(body), StandardCharsets.UTF_8));
            if (!(parsed instanceof Map)) return null;
            Map<String, Object> p = (Map<String, Object>) parsed;
            if (!"ac".equals(p.get("t")) || !o.tenant.equals(p.get("tn")) || !room.equals(p.get("r"))) return null;
            Object exp = p.get("exp");
            if (!(exp instanceof Number) || ((Number) exp).doubleValue() < nowSec()) return null;
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    // ───────────────────────── helpers ─────────────────────────

    public String cookieName(String room) { return "__spw_" + o.tenant + "_" + room; }

    private String cookie(String room, String token, long exp) {
        return cookieName(room) + "=" + token + "; Path=/; Max-Age=" + Math.max(1, exp - nowSec()) + "; HttpOnly; Secure; SameSite=Lax";
    }

    private static Rule find(List<Rule> list, String mode, String method, String path) {
        for (Rule r : list) {
            if (!mode.equals(r.mode)) continue;
            boolean in = false, out = false;
            for (String p : r.match) if (mode.equals("action") ? actionMatch(p, method, path) : globMatch(p, path)) { in = true; break; }
            if (!in) continue;
            for (String p : r.exclude) if (mode.equals("action") ? actionMatch(p, method, path) : globMatch(p, path)) { out = true; break; }
            if (!out) return r;
        }
        return null;
    }

    private static final ConcurrentHashMap<String, Pattern> GLOB = new ConcurrentHashMap<String, Pattern>();

    /** "*" 는 "/" 를 포함한 모든 문자, 나머지는 그대로 비교 */
    static boolean globMatch(String pattern, String path) {
        Pattern p = GLOB.get(pattern);
        if (p == null) {
            StringBuilder sb = new StringBuilder("^");
            String[] parts = pattern.split("\\*", -1);
            for (int i = 0; i < parts.length; i++) {
                if (i > 0) sb.append(".*");
                if (!parts[i].isEmpty()) sb.append(Pattern.quote(parts[i]));
            }
            p = Pattern.compile(sb.append("$").toString(), Pattern.DOTALL);
            if (GLOB.size() < 1000) GLOB.put(pattern, p);
        }
        return p.matcher(path).matches();
    }

    /** "POST /api/orders" (메서드 + 경로) 또는 "/api/orders" (모든 메서드) */
    static boolean actionMatch(String pattern, String method, String path) {
        Matcher m = ACTION_RULE.matcher(pattern);
        if (m.matches()) return m.group(1).equals(method) && globMatch(m.group(2), path);
        return pattern.startsWith("/") && globMatch(pattern, path);
    }

    /** 정적 파일: 확장자로만 판단 (Sec-Fetch-Dest 는 위장할 수 있어 보지 않음, v0.6.2) */
    private static boolean isStatic(Req r, String path) {
        Matcher m = EXT.matcher(path);
        return m.find() && STATIC_EXT.contains(m.group(1).toLowerCase(Locale.ROOT));
    }

    private static boolean isNavigation(Req r) {
        String mode = r.header("sec-fetch-mode");
        if (mode != null) return mode.equals("navigate");
        String accept = r.header("accept");
        return accept != null && accept.contains("text/html");
    }

    private String publicUrl(Req r, String path, String query) {
        if (o.siteOrigin == null || o.siteOrigin.isEmpty()) return r.url();
        try {
            URL u = new URL(o.siteOrigin);
            String origin = u.getProtocol() + "://" + u.getAuthority();
            return origin + path + (query == null || query.isEmpty() ? "" : "?" + query);
        } catch (Exception e) {
            return r.url();
        }
    }

    static String readCookie(String header, String name) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            int i = part.indexOf('=');
            if (i > 0 && part.substring(0, i).trim().equals(name)) return part.substring(i + 1).trim();
        }
        return null;
    }

    static String queryParam(String query, String name) {
        if (query == null || query.isEmpty()) return null;
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            String k = dec(i < 0 ? kv : kv.substring(0, i));
            if (k.equals(name)) return i < 0 ? "" : dec(kv.substring(i + 1));
        }
        return null;
    }

    static String removeParam(String query, String name) {
        StringBuilder sb = new StringBuilder();
        for (String kv : query.split("&")) {
            if (kv.isEmpty()) continue;
            int i = kv.indexOf('=');
            if (dec(i < 0 ? kv : kv.substring(0, i)).equals(name)) continue;
            if (sb.length() > 0) sb.append('&');
            sb.append(kv);
        }
        return sb.toString();
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (UnsupportedEncodingException e) { throw new IllegalStateException(e); }
    }

    private static String dec(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** JSON 문자열 리터럴 */
    static String jsonStr(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    private static String str(Object v) { return v instanceof String ? (String) v : null; }
    private static long num(Object v) { return v instanceof Number ? ((Number) v).longValue() : 0L; }

    /** 아주 작은 JSON 파서 (엔진 응답·토큰 본문용): 객체 → Map, 배열 → List, 숫자 → Long/Double, 문자열, true/false, null */
    static final class Json {
        private final String s; private int i;
        private Json(String s) { this.s = s; }

        static Object parse(String text) {
            Json j = new Json(text);
            Object v = j.value();
            j.ws();
            if (j.i != j.s.length()) throw new IllegalArgumentException("json: trailing data");
            return v;
        }

        private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        private Object value() {
            ws();
            if (i >= s.length()) throw new IllegalArgumentException("json: eof");
            char c = s.charAt(i);
            if (c == '{') {
                i++;
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                ws();
                if (peek('}')) return m;
                while (true) {
                    ws();
                    String k = string();
                    ws(); expect(':');
                    m.put(k, value());
                    ws();
                    if (peek('}')) return m;
                    expect(',');
                }
            }
            if (c == '[') {
                i++;
                List<Object> l = new ArrayList<Object>();
                ws();
                if (peek(']')) return l;
                while (true) {
                    l.add(value());
                    ws();
                    if (peek(']')) return l;
                    expect(',');
                }
            }
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(st, i);
            if (n.isEmpty()) throw new IllegalArgumentException("json: unexpected " + c);
            if (n.indexOf('.') < 0 && n.indexOf('e') < 0 && n.indexOf('E') < 0) {
                try { return Long.valueOf(n); } catch (NumberFormatException ignore) { /* 아래에서 double */ }
            }
            return Double.valueOf(n);
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new IllegalArgumentException("json: unterminated string");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: sb.append(e);
                }
            }
        }

        private boolean peek(char c) { if (i < s.length() && s.charAt(i) == c) { i++; return true; } return false; }
        private void expect(char c) { if (!peek(c)) throw new IllegalArgumentException("json: expected " + c + " at " + i); }
    }

    private static long nowSec() { return System.currentTimeMillis() / 1000L; }
}
