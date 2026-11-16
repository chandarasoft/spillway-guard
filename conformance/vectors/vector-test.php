<?php
// 공통 테스트 벡터(docs/test-vectors.json)로 PHP 구현 확인: php vector-test.php test-vectors.json
require __DIR__ . '/../../ports/php/spillway.php';
$v = json_decode(file_get_contents($argv[1]), true);
$o = array('tenant' => $v['tenant'], 'secret' => $v['secret'], 'engine_url' => 'http://127.0.0.1:9');
$pass = 0;
$fail = 0;
foreach ($v['verifyAccess'] as $c) {
    $got = spillway_verify_access($o, $c['token'], $v['room']) !== null;
    if ($got === $c['valid']) { $pass++; } else { $fail++; echo "FAIL verify {$c['name']}\n"; }
}
foreach ($v['sign'] as $c) {
    if (spillway_sign($o, $c['payloadJson']) === $c['token']) { $pass++; } else { $fail++; echo "FAIL sign {$c['payloadJson']}\n"; }
}
foreach ($v['globMatch'] as $c) {
    if (spillway_glob_match($c['pattern'], $c['path']) === $c['match']) { $pass++; } else { $fail++; echo "FAIL glob {$c['pattern']} {$c['path']}\n"; }
}
foreach ($v['actionMatch'] as $c) {
    if (spillway_action_match($c['pattern'], $c['method'], $c['path']) === $c['match']) { $pass++; } else { $fail++; echo "FAIL action {$c['pattern']}\n"; }
}
echo "php vectors: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
