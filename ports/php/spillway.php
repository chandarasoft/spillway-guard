<?php
/**
 * Spillway 가드 — PHP 참조 구현 (연동 프로토콜 v1)
 *
 * 요구 사항: PHP 7.0 이상, 확장 json · hash (기본 포함). curl 이 있으면 쓰고, 없으면 file_get_contents 로 엔진을 부릅니다.
 * 동작은 Cloudflare 가드(spillway-guard v0.6.2)의 withSpillway 와 같습니다.
 *  - 대기실 규칙은 엔진 GET /q/{tenant}/rules 에서 받아 10초 캐시 (APCu 가 있으면 APCu, 없으면 임시 폴더 파일)
 *  - 입장권(__spw_{tenant}_{room} 쿠키 · x-spillway-token 헤더 · ?__spw=)을 고객사 서명 키로 검증
 *  - 자리가 있으면 엔진 POST /enter 로 대기 화면 없이 바로 입장 (응답에 쿠키)
 *  - 판단할 수 없으면 통과 (fail-open)
 *
 * 쓰는 법 (페이지 출력 전에):
 *   require_once __DIR__ . '/spillway.php';
 *   spillway_guard(array('tenant' => 'acme-shop', 'engine_url' => 'https://queue.spillway.co.kr'));
 *
 * 서명 키는 환경 변수 SPILLWAY_TOKEN_SECRET 에서 읽습니다 (또는 옵션 'secret').
 */

if (!defined('SPILLWAY_VERSION')) {
    define('SPILLWAY_VERSION', '0.6.2'); // spillway-guard(npm) 와 같은 번호
}

/**
 * 판단하고 바로 적용합니다. 대기 화면·429 면 응답을 보내고 exit, 통과면 (필요하면 입장 쿠키를 붙이고) 돌아갑니다.
 */
function spillway_guard(array $opts)
{
    $d = spillway_decide($opts);
    if ($d['cookie'] !== null && !headers_sent()) {
        header('Set-Cookie: ' . $d['cookie'], false);
    }
    if ($d['type'] === 'pass') {
        if ($d['cookie'] !== null && !headers_sent()) {
            header('Cache-Control: private, no-store'); // 입장권이 든 응답이 공유 캐시에 남지 않게
        }
        return;
    }
    if (headers_sent()) {
        return; // 이미 출력이 시작됐으면 막을 수 없음 → 통과
    }
    header('Cache-Control: no-store');
    if ($d['type'] === 'redirect') {
        header('Location: ' . $d['location'], true, 302);
        exit;
    }
    http_response_code($d['status']);
    header('Content-Type: application/json; charset=utf-8');
    header('Retry-After: 5');
    echo $d['body'];
    exit;
}

/**
 * 판단만 합니다 (Laravel 미들웨어 등에서 직접 응답을 만들 때).
 * 반환: array('type' => 'pass'|'redirect'|'respond', 'status' => int, 'location' => ?string, 'body' => ?string, 'cookie' => ?string)
 * $req 를 주지 않으면 $_SERVER · $_COOKIE 에서 읽습니다.
 */
function spillway_decide(array $opts, $req = null)
{
    $pass = array('type' => 'pass', 'status' => 200, 'location' => null, 'body' => null, 'cookie' => null);
    try {
        $o = spillway_options($opts);
        if ($o === null) {
            return $pass;
        }
        if ($req === null) {
            $req = spillway_request_from_globals();
        }
        $d = spillway_decide_unsafe($o, $req);
        return array_merge($pass, $d);
    } catch (\Throwable $e) {
        error_log('spillway guard error (fail-open): ' . $e->getMessage());
        return $pass;
    }
}

function spillway_options(array $opts)
{
    $o = array_merge(array(
        'tenant' => null,
        'engine_url' => null,
        'secret' => getenv('SPILLWAY_TOKEN_SECRET'),
        'site_origin' => null,
        'cache_ttl' => 10,
        'timeout' => 1.5,
        'server_enter' => true,
        'skip_static' => true,
        // 통과시킬 User-Agent 정규식 (기본: 없음). User-Agent 는 위장할 수 있어 v0.6.2 부터 끔 — 위험을 알고 쓸 때만
        'bypass_user_agents' => null,
    ), $opts);
    if (PHP_SAPI === 'cli' || empty($o['secret']) || empty($o['tenant']) || empty($o['engine_url'])) {
        return null; // 설정 누락·명령줄 실행 → 통과
    }
    $o['engine_url'] = rtrim($o['engine_url'], '/');
    return $o;
}

/** $_SERVER 에서 요청 정보 */
function spillway_request_from_globals()
{
    $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
    $qpos = strpos($uri, '?');
    $path = $qpos === false ? $uri : substr($uri, 0, $qpos);
    $query = isset($_SERVER['QUERY_STRING']) ? $_SERVER['QUERY_STRING'] : ($qpos === false ? '' : substr($uri, $qpos + 1));
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (isset($_SERVER['SERVER_PORT']) && $_SERVER['SERVER_PORT'] == 443);
    $host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'localhost';
    $headers = array();
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) {
            $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = $v;
        }
    }
    return array(
        'method' => isset($_SERVER['REQUEST_METHOD']) ? strtoupper($_SERVER['REQUEST_METHOD']) : 'GET',
        'path' => $path,
        'query' => $query,
        'url' => ($https ? 'https' : 'http') . '://' . $host . $uri,
        'headers' => $headers,
    );
}

function spillway_decide_unsafe(array $o, array $r)
{
    $method = $r['method'];
    $path = $r['path'];
    $h = $r['headers'];
    $read_only = $method === 'GET' || $method === 'HEAD';
    if ($read_only && $o['skip_static'] && spillway_is_static($h, $path)) {
        return array();
    }
    $rules = spillway_rules($o);
    if ($rules === null) {
        return array(); // 엔진 장애 → 통과
    }

    // 버튼·이벤트 방식 (API 보호)
    if ($method !== 'OPTIONS') {
        $act = spillway_find($rules, 'action', $method, $path);
        if ($act !== null) {
            return $act['enabled'] ? spillway_check_action($o, $r, $act) : array();
        }
    }
    if (!$read_only) {
        return array();
    }
    $ua = isset($h['user-agent']) ? $h['user-agent'] : '';
    if ($o['bypass_user_agents'] && $ua !== '' && preg_match($o['bypass_user_agents'], $ua)) {
        return array();
    }

    // 단일 페이지
    $hit = spillway_find($rules, 'page', $method, $path);
    if ($hit === null) {
        return array();
    }
    $room = $hit['room'];

    // 대기를 마치고 돌아온 경우: ?__spw=<입장권> → 쿠키로 바꾸고 깨끗한 주소로 302
    $from_queue = spillway_query_param($r['query'], '__spw');
    if ($from_queue !== null) {
        $p = spillway_verify_access($o, $from_queue, $room);
        if ($p !== null) {
            $rest = spillway_remove_param($r['query'], '__spw');
            return array('type' => 'redirect', 'status' => 302, 'location' => $path . ($rest === '' ? '' : '?' . $rest),
                'cookie' => spillway_cookie($o, $room, $from_queue, $p['exp']));
        }
    }
    if (spillway_verify_access($o, spillway_read_cookie($h, spillway_cookie_name($o, $room)), $room) !== null) {
        return array();
    }
    if (!$hit['enabled']) {
        return array();
    }
    if (spillway_can_enter($o, $hit)) {
        $e = spillway_try_enter($o, $room);
        if ($e['kind'] === 'pass') {
            return array('cookie' => spillway_cookie($o, $room, $e['token'], $e['exp']));
        }
        if ($e['kind'] === 'error') {
            return array();
        }
    }
    $wait = $o['engine_url'] . '/q/' . rawurlencode($o['tenant']) . '/' . rawurlencode($room) . '/wait?return=' . rawurlencode(spillway_public_url($o, $r));
    if (!spillway_is_navigation($h)) {
        return array('type' => 'respond', 'status' => 429, 'body' => json_encode(array('spillway' => 'queued', 'waitUrl' => $wait), JSON_UNESCAPED_SLASHES));
    }
    return array('type' => 'redirect', 'status' => 302, 'location' => $wait);
}

function spillway_check_action(array $o, array $r, array $hit)
{
    $room = $hit['room'];
    $h = $r['headers'];
    $from_header = isset($h['x-spillway-token']) ? $h['x-spillway-token'] : null;
    if (spillway_verify_access($o, $from_header, $room) !== null) {
        return array();
    }
    if (spillway_verify_access($o, spillway_read_cookie($h, spillway_cookie_name($o, $room)), $room) !== null) {
        return array();
    }
    if (spillway_can_enter($o, $hit)) {
        $e = spillway_try_enter($o, $room);
        if ($e['kind'] === 'pass') {
            return array('cookie' => spillway_cookie($o, $room, $e['token'], $e['exp']));
        }
        if ($e['kind'] === 'error') {
            return array();
        }
    }
    return array('type' => 'respond', 'status' => 429,
        'body' => json_encode(array('spillway' => 'queued', 'mode' => 'action', 'tenant' => $o['tenant'], 'room' => $room), JSON_UNESCAPED_SLASHES));
}

function spillway_can_enter(array $o, array $hit)
{
    return $o['server_enter'] && ($hit['phase'] === null || $hit['phase'] === 'open');
}

// ───────────────────────── 엔진 호출 ─────────────────────────

/** 대기실 규칙 (캐시). 실패(null)도 캐시해서 엔진 장애 때 매번 기다리지 않음 */
function spillway_rules(array $o)
{
    static $mem = array();
    $key = 'spillway_rules_' . md5($o['engine_url'] . '|' . $o['tenant']);
    $now = microtime(true);
    if (isset($mem[$key]) && $now - $mem[$key]['at'] < $o['cache_ttl']) {
        return $mem[$key]['value'];
    }
    $apcu = function_exists('apcu_fetch') && ini_get('apc.enabled') && (PHP_SAPI !== 'cli' || ini_get('apc.enable_cli'));
    $file = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . $key . '.json';
    $cached = null;
    if ($apcu) {
        $ok = false;
        $cached = apcu_fetch($key, $ok);
        if (!$ok) {
            $cached = null;
        }
    } elseif (is_file($file)) {
        $cached = json_decode((string) @file_get_contents($file), true);
    }
    if (is_array($cached) && array_key_exists('at', $cached) && $now - $cached['at'] < $o['cache_ttl']) {
        $mem[$key] = $cached;
        return $cached['value'];
    }

    $value = null;
    $res = spillway_http($o, 'GET', '/q/' . rawurlencode($o['tenant']) . '/rules', null);
    if ($res !== null && $res['status'] === 200) {
        $body = json_decode($res['body'], true);
        if (is_array($body) && isset($body['rooms']) && is_array($body['rooms'])) {
            $value = array();
            foreach ($body['rooms'] as $n) {
                if (!is_array($n) || !isset($n['room'], $n['mode']) || !is_string($n['room']) || !is_string($n['mode'])) {
                    continue;
                }
                $value[] = array(
                    'room' => $n['room'],
                    'mode' => $n['mode'],
                    'phase' => isset($n['phase']) && is_string($n['phase']) ? $n['phase'] : null,
                    'enabled' => isset($n['enabled']) && $n['enabled'] === true,
                    'match' => isset($n['match']) && is_array($n['match']) ? array_values(array_filter($n['match'], 'is_string')) : array(),
                    'exclude' => isset($n['exclude']) && is_array($n['exclude']) ? array_values(array_filter($n['exclude'], 'is_string')) : array(),
                );
            }
        }
    } elseif ($res !== null && $res['status'] === 404) {
        error_log('spillway: 엔진에 고객사 ' . $o['tenant'] . ' 가 없습니다 (통과 처리)');
    }
    $entry = array('at' => $now, 'value' => $value);
    $mem[$key] = $entry;
    if ($apcu) {
        apcu_store($key, $entry, (int) ceil($o['cache_ttl']) + 1);
    } else {
        $tmp = @tempnam(dirname($file), 'spw');
        if ($tmp !== false && @file_put_contents($tmp, json_encode($entry)) !== false) {
            @rename($tmp, $file);
        }
    }
    return $value;
}

/** 엔진 POST /enter — 고객사 키로 서명한 x-spillway-auth 를 붙임 */
function spillway_try_enter(array $o, $room)
{
    $iat = time();
    $auth = spillway_sign($o, json_encode(array('t' => 'en', 'tn' => $o['tenant'], 'r' => $room, 'iat' => $iat, 'exp' => $iat + 60)));
    $res = spillway_http($o, 'POST', '/q/' . rawurlencode($o['tenant']) . '/' . rawurlencode($room) . '/enter', $auth);
    if ($res === null || $res['status'] >= 500) {
        return array('kind' => 'error');
    }
    if ($res['status'] !== 200) {
        if ($res['status'] === 401) {
            error_log('spillway: /enter 서명이 맞지 않습니다 — 서명 키를 확인하세요 (대기 화면으로 보냄)');
        }
        return array('kind' => 'queue');
    }
    $b = json_decode($res['body'], true);
    if (!is_array($b) || !isset($b['pass']) || $b['pass'] !== true || !isset($b['token']) || !is_string($b['token'])) {
        return array('kind' => 'queue');
    }
    $p = spillway_verify_access($o, $b['token'], $room);
    return $p === null ? array('kind' => 'queue') : array('kind' => 'pass', 'token' => $b['token'], 'exp' => $p['exp']);
}

/** 엔진 호출 (시간 제한 timeout 초). 실패하면 null */
function spillway_http(array $o, $method, $path, $auth)
{
    $url = $o['engine_url'] . $path;
    $headers = array('Accept: application/json');
    if ($auth !== null) {
        $headers[] = 'x-spillway-auth: ' . $auth;
        $headers[] = 'Content-Length: 0';
    }
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT_MS => (int) ($o['timeout'] * 1000),
            CURLOPT_CONNECTTIMEOUT_MS => (int) ($o['timeout'] * 1000),
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_NOSIGNAL => true,
        ));
        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, '');
        }
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return $body === false || $status === 0 ? null : array('status' => $status, 'body' => $body);
    }
    $ctx = stream_context_create(array('http' => array(
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'timeout' => $o['timeout'],
        'ignore_errors' => true,
        'follow_location' => 0,
    )));
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false || empty($http_response_header) || !preg_match('#^HTTP/\S+\s+(\d{3})#', $http_response_header[0], $m)) {
        return null;
    }
    return array('status' => (int) $m[1], 'body' => $body);
}

// ───────────────────────── 토큰 (base64url(JSON) "." base64url(HMAC-SHA256)) ─────────────────────────

function spillway_b64url_encode($bin)
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function spillway_b64url_decode($s)
{
    if (!preg_match('/^[A-Za-z0-9_-]*$/', $s)) {
        return false;
    }
    return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
}

function spillway_sign(array $o, $payload_json)
{
    $body = spillway_b64url_encode($payload_json);
    return $body . '.' . spillway_b64url_encode(hash_hmac('sha256', $body, $o['secret'], true));
}

/** 입장권 검증: 서명 · t=ac · 고객사 · 대기실 · 만료. 실패하면 null */
function spillway_verify_access(array $o, $token, $room)
{
    if (!is_string($token) || $token === '' || strlen($token) > 2048) {
        return null;
    }
    $dot = strpos($token, '.');
    if ($dot === false || $dot === 0 || $dot !== strrpos($token, '.')) {
        return null;
    }
    $body = substr($token, 0, $dot);
    $sig = spillway_b64url_decode(substr($token, $dot + 1));
    if ($sig === false || !hash_equals(hash_hmac('sha256', $body, $o['secret'], true), $sig)) {
        return null;
    }
    $json = spillway_b64url_decode($body);
    $p = $json === false ? null : json_decode($json, true);
    if (!is_array($p) || !isset($p['t'], $p['tn'], $p['r'], $p['exp'])) {
        return null;
    }
    if ($p['t'] !== 'ac' || $p['tn'] !== $o['tenant'] || $p['r'] !== $room) {
        return null;
    }
    if (!(is_int($p['exp']) || is_float($p['exp'])) || $p['exp'] < time()) {
        return null;
    }
    return $p;
}

// ───────────────────────── helpers ─────────────────────────

function spillway_cookie_name(array $o, $room)
{
    return '__spw_' . $o['tenant'] . '_' . $room;
}

function spillway_cookie(array $o, $room, $token, $exp)
{
    return spillway_cookie_name($o, $room) . '=' . $token . '; Path=/; Max-Age=' . max(1, (int) $exp - time()) . '; HttpOnly; Secure; SameSite=Lax';
}

/** Cookie 헤더에서 직접 읽음 ($_COOKIE 는 이름의 "." 를 "_" 로 바꾸므로 쓰지 않음) */
function spillway_read_cookie(array $h, $name)
{
    if (!isset($h['cookie'])) {
        return null;
    }
    foreach (explode(';', $h['cookie']) as $part) {
        $i = strpos($part, '=');
        if ($i > 0 && trim(substr($part, 0, $i)) === $name) {
            return trim(substr($part, $i + 1));
        }
    }
    return null;
}

function spillway_find(array $rules, $mode, $method, $path)
{
    foreach ($rules as $r) {
        if ($r['mode'] !== $mode) {
            continue;
        }
        $in = false;
        foreach ($r['match'] as $p) {
            if ($mode === 'action' ? spillway_action_match($p, $method, $path) : spillway_glob_match($p, $path)) {
                $in = true;
                break;
            }
        }
        if (!$in) {
            continue;
        }
        foreach ($r['exclude'] as $p) {
            if ($mode === 'action' ? spillway_action_match($p, $method, $path) : spillway_glob_match($p, $path)) {
                continue 2;
            }
        }
        return $r;
    }
    return null;
}

/** "*" 는 "/" 를 포함한 모든 문자, 나머지는 그대로 비교 */
function spillway_glob_match($pattern, $path)
{
    $parts = array_map(function ($s) { return preg_quote($s, '#'); }, explode('*', $pattern));
    return preg_match('#^' . implode('.*', $parts) . '$#s', $path) === 1;
}

/** "POST /api/orders" (메서드 + 경로) 또는 "/api/orders" (모든 메서드) */
function spillway_action_match($pattern, $method, $path)
{
    if (preg_match('#^(GET|POST|PUT|PATCH|DELETE) (/.*)$#s', $pattern, $m)) {
        return $m[1] === $method && spillway_glob_match($m[2], $path);
    }
    return strpos($pattern, '/') === 0 && spillway_glob_match($pattern, $path);
}

function spillway_is_static(array $h, $path)
{
    static $exts = array('css', 'js', 'mjs', 'cjs', 'map', 'wasm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
        'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'ogg', 'wav', 'm4a', 'pdf', 'txt', 'xml', 'webmanifest');
    // 확장자로만 판단 (Sec-Fetch-Dest 는 위장할 수 있어 보지 않음, v0.6.2)
    return preg_match('/\.([a-z0-9]+)$/i', $path, $m) === 1 && in_array(strtolower($m[1]), $exts, true);
}

function spillway_is_navigation(array $h)
{
    if (isset($h['sec-fetch-mode'])) {
        return $h['sec-fetch-mode'] === 'navigate';
    }
    return isset($h['accept']) && strpos($h['accept'], 'text/html') !== false;
}

function spillway_public_url(array $o, array $r)
{
    if (empty($o['site_origin'])) {
        return $r['url'];
    }
    $u = parse_url($o['site_origin']);
    if (!$u || empty($u['scheme']) || empty($u['host'])) {
        return $r['url'];
    }
    $origin = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
    return $origin . $r['path'] . ($r['query'] === '' ? '' : '?' . $r['query']);
}

function spillway_query_param($query, $name)
{
    if ($query === '' || $query === null) {
        return null;
    }
    foreach (explode('&', $query) as $kv) {
        $i = strpos($kv, '=');
        $k = rawurldecode(str_replace('+', ' ', $i === false ? $kv : substr($kv, 0, $i)));
        if ($k === $name) {
            return $i === false ? '' : rawurldecode(str_replace('+', ' ', substr($kv, $i + 1)));
        }
    }
    return null;
}

function spillway_remove_param($query, $name)
{
    $out = array();
    foreach (explode('&', $query) as $kv) {
        if ($kv === '') {
            continue;
        }
        $i = strpos($kv, '=');
        if (rawurldecode(str_replace('+', ' ', $i === false ? $kv : substr($kv, 0, $i))) === $name) {
            continue;
        }
        $out[] = $kv;
    }
    return implode('&', $out);
}
