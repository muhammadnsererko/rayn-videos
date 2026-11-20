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
    $number = filter_var($input['episode_number'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    $title = trim(is_string($input['title'] ?? null) ? $input['title'] : '');
    $description = $input['description'] ?? null;
    $duration = filter_var($input['duration_minutes'] ?? null, FILTER_VALIDATE_INT);
    $tier = $input['tier'] ?? null;
    if ($number === false || $title === '' || strlen($title) > 255 || !is_string($description) || strlen($description) > 10000
        || $duration === false || $duration < 1 || $duration > 1000 || !in_array($tier, ['free', 'vip'], true)) {
        json_response(['error' => 'Episode metadata is invalid.'], 422);
    }
    try {
        $statement = $db->prepare(
            'UPDATE episodes SET episode_number = :episode_number, title = :title, description = :description, '
            . 'duration_minutes = :duration_minutes, tier = :tier WHERE id = :id AND deletion_pending = FALSE RETURNING season_id'
        );
        $statement->execute([
            'id' => $id,
            'episode_number' => $number,
            'title' => $title,
            'description' => $description,
            'duration_minutes' => $duration,
            'tier' => $tier,
        ]);
        $seasonId = $statement->fetchColumn();
    } catch (PDOException $exception) {
        if ($exception->getCode() === '23505') {
            json_response(['error' => 'That episode number already exists for this season.'], 409);
        }
        throw $exception;
    }
    if ($seasonId === false) {
        json_response(['error' => 'Episode not found.'], 404);
    }
    admin_log_activity($db, $actorId, 'episode.updated', 'episode', (string) $id, 'Updated episode: ' . $title);
    json_response(['message' => 'Episode updated.']);
}

admin_delete_endpoint($db, $actorId, 'episode', $id);
