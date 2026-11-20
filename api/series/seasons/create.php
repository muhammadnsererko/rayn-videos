<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';
require_once dirname(__DIR__, 2) . '/admin/common.php';

require_method('POST');
$adminUser = require_admin();
$input = request_json();
$seriesId = filter_var($input['series_id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$seasonNumber = filter_var($input['season_number'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$releaseYearInput = $input['release_year'] ?? null;
$releaseYear = $releaseYearInput === null || $releaseYearInput === ''
    ? null
    : filter_var($releaseYearInput, FILTER_VALIDATE_INT);

if ($seriesId === false || $seasonNumber === false) {
    json_response(['error' => 'A positive series_id and season_number are required.'], 422);
}
if ($releaseYearInput !== null && $releaseYearInput !== ''
    && ($releaseYear === false || $releaseYear < 1888 || $releaseYear > (int) date('Y') + 5)) {
    json_response(['error' => 'release_year must be a valid year or null.'], 422);
}

$db = database();
$db->beginTransaction();
$parent = $db->prepare('SELECT id FROM series WHERE id = :id AND deletion_pending = FALSE FOR UPDATE');
$parent->execute(['id' => $seriesId]);
if (!$parent->fetchColumn()) {
    $db->rollBack();
    json_response(['error' => 'Series not found.'], 404);
}

try {
    $statement = $db->prepare(
        'INSERT INTO seasons (series_id, season_number, release_year) '
        . 'VALUES (:series_id, :season_number, :release_year) '
        . 'RETURNING id, series_id, season_number, release_year, created_at'
    );
    $statement->execute([
        'series_id' => $seriesId,
        'season_number' => $seasonNumber,
        'release_year' => $releaseYear,
    ]);
    $season = $statement->fetch();
    admin_log_activity(
        $db,
        admin_actor_id($adminUser),
        'season.created',
        'season',
        (string) $season['id'],
        'Added season ' . $season['season_number'] . ' to series ' . $season['series_id'],
    );
    $db->commit();
} catch (PDOException $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'That season number already exists for this series.'], 409);
    }
    error_log('Season creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create season.'], 500);
} catch (Throwable $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Season creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create season.'], 500);
}

json_response(['season' => $season], 201);
