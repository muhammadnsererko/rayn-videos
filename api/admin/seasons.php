<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/common.php';

$user = require_admin();
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['PUT', 'DELETE'], true)) {
    header('Allow: PUT, DELETE, OPTIONS');
    json_response(['error' => 'Method not allowed.'], 405);
}
$id = admin_id_from_query();
$db = database();
$actorId = admin_actor_id($user);

if ($method === 'PUT') {
    $input = request_json();
    $number = filter_var($input['season_number'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    $yearInput = $input['release_year'] ?? null;
    $year = $yearInput === null || $yearInput === '' ? null : filter_var($yearInput, FILTER_VALIDATE_INT);
    if ($number === false || ($yearInput !== null && $yearInput !== '' && ($year === false || $year < 1888 || $year > (int) date('Y') + 5))) {
        json_response(['error' => 'Season number and release year are invalid.'], 422);
    }
    try {
        $statement = $db->prepare('UPDATE seasons SET season_number = :season_number, release_year = :release_year WHERE id = :id AND deletion_pending = FALSE RETURNING series_id');
        $statement->execute(['id' => $id, 'season_number' => $number, 'release_year' => $year]);
        $seriesId = $statement->fetchColumn();
    } catch (PDOException $exception) {
        if ($exception->getCode() === '23505') {
            json_response(['error' => 'That season number already exists for this series.'], 409);
        }
        throw $exception;
    }
    if ($seriesId === false) {
        json_response(['error' => 'Season not found.'], 404);
    }
    admin_log_activity($db, $actorId, 'season.updated', 'season', (string) $id, 'Updated season ' . $number . ' in series ' . $seriesId);
    json_response(['message' => 'Season updated.']);
}

admin_delete_endpoint($db, $actorId, 'season', $id);
