<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/catalogue.php';

require_method('GET');
header('Cache-Control: no-store');

$seriesId = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
if ($seriesId === false) {
    json_response(['error' => 'Series id must be a positive integer.'], 422);
}

$series = series_catalogue($seriesId);
if ($series === []) {
    json_response(['error' => 'Series not found.'], 404);
}

json_response(['series' => $series[0]]);
