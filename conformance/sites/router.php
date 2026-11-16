<?php
require __DIR__ . '/../../ports/php/spillway.php';
spillway_guard(array('tenant' => getenv('T'), 'engine_url' => getenv('E'), 'site_origin' => 'http://localhost:8788'));
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
echo strpos($p, '/api/') === 0 ? 'API OK' : 'SITE OK';
