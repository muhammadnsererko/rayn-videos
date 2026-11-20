<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';
require_once dirname(__DIR__, 2) . '/admin/common.php';

require_method('POST');
$adminUser = require_admin();
$input = request_json();
$seasonId = filter_var($input['season_id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$episodeNumber = filter_var($input['episode_number'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$title = trim(is_string($input['title'] ?? null) ? $input['title'] : '');
$descriptionInput = $input['description'] ?? '';
if (!is_string($descriptionInput)) {
    json_response(['error' => 'description must be a string.'], 422);
}
$description = trim($descriptionInput);
$durationMinutes = filter_var($input['duration_minutes'] ?? null, FILTER_VALIDATE_INT);
$tier = strtolower(trim(is_string($input['tier'] ?? null) ? $input['tier'] : ''));

if ($seasonId === false || $episodeNumber === false) {
    json_response(['error' => 'A positive season_id and episode_number are required.'], 422);
}
if ($title === '' || strlen($title) > 255) {
    json_response(['error' => 'Title is required and must be at most 255 characters.'], 422);
}
if (strlen($description) > 10000) {
    json_response(['error' => 'Description must be at most 10000 characters.'], 422);
}
if ($durationMinutes === false || $durationMinutes < 1 || $durationMinutes > 1000) {
    json_response(['error' => 'duration_minutes must be between 1 and 1000.'], 422);
}
if (!in_array($tier, ['free', 'vip'], true)) {
    json_response(['error' => 'Tier must be free or vip.'], 422);
}

$db = database();
$db->beginTransaction();
$parent = $db->prepare('SELECT id FROM seasons WHERE id = :id AND deletion_pending = FALSE FOR UPDATE');
$parent->execute(['id' => $seasonId]);
if (!$parent->fetchColumn()) {
    $db->rollBack();
    json_response(['error' => 'Season not found.'], 404);
}

try {
    $statement = $db->prepare(
        'INSERT INTO episodes (season_id, episode_number, title, description, duration_minutes, tier) '
        . 'VALUES (:season_id, :episode_number, :title, :description, :duration_minutes, :tier) '
        . 'RETURNING id, season_id, episode_number, title, description, duration_minutes, tier, created_at'
    );
    $statement->execute([
        'season_id' => $seasonId,
        'episode_number' => $episodeNumber,
        'title' => $title,
        'description' => $description,
        'duration_minutes' => $durationMinutes,
        'tier' => $tier,
    ]);
    $episode = $statement->fetch();
    admin_log_activity(
        $db,
        admin_actor_id($adminUser),
        'episode.created',
        'episode',
        (string) $episode['id'],
        'Added episode: ' . $episode['title'],
    );
    $db->commit();
} catch (PDOException $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'That episode number already exists for this season.'], 409);
    }
    error_log('Episode creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create episode.'], 500);
} catch (Throwable $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Episode creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create episode.'], 500);
}

json_response(['episode' => $episode], 201);
