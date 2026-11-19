<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/series/catalogue.php';

require_method('GET');
header('Cache-Control: no-store');

json_response(['series' => series_catalogue()]);
