package spillway;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

/** 공통 테스트 벡터(docs/test-vectors.json)로 Java 구현 확인: java -cp ... spillway.VectorTest test-vectors.json */
@SuppressWarnings("unchecked")
public class VectorTest {
    public static void main(String[] args) throws Exception {
        Map<String, Object> v = (Map<String, Object>) SpillwayGuard.Json.parse(new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8));
        SpillwayGuard.Options o = new SpillwayGuard.Options();
        o.tenant = (String) v.get("tenant");
        o.engineUrl = "http://127.0.0.1:9";
        o.secret = (String) v.get("secret");
        SpillwayGuard g = new SpillwayGuard(o);
        String room = (String) v.get("room");
        int pass = 0, fail = 0;
        for (Object x : (List<Object>) v.get("verifyAccess")) {
            Map<String, Object> c = (Map<String, Object>) x;
            boolean got = g.verifyAccess((String) c.get("token"), room) != null;
            if (got == (Boolean) c.get("valid")) pass++; else { fail++; System.out.println("FAIL verify " + c.get("name")); }
        }
        for (Object x : (List<Object>) v.get("sign")) {
            Map<String, Object> c = (Map<String, Object>) x;
            if (g.sign((String) c.get("payloadJson")).equals(c.get("token"))) pass++; else { fail++; System.out.println("FAIL sign " + c.get("payloadJson")); }
        }
        for (Object x : (List<Object>) v.get("globMatch")) {
            Map<String, Object> c = (Map<String, Object>) x;
            if (SpillwayGuard.globMatch((String) c.get("pattern"), (String) c.get("path")) == (Boolean) c.get("match")) pass++; else { fail++; System.out.println("FAIL glob " + c); }
        }
        for (Object x : (List<Object>) v.get("actionMatch")) {
            Map<String, Object> c = (Map<String, Object>) x;
            if (SpillwayGuard.actionMatch((String) c.get("pattern"), (String) c.get("method"), (String) c.get("path")) == (Boolean) c.get("match")) pass++; else { fail++; System.out.println("FAIL action " + c); }
        }
        System.out.println("java vectors: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
