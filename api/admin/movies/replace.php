<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';
require_once dirname(__DIR__) . '/common.php';

require_method('POST');
$user = require_admin();
$actorId = admin_actor_id($user);
$input = request_json();
$id = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
$size = filter_var($input['file_size_bytes'] ?? null, FILTER_VALIDATE_INT);
$key = validated_upload_key($input['r2_key'] ?? null);
$maximum = video_max_upload_bytes();
if ($id === false || $size === false || $size < 1) {
    json_response(['error' => 'A positive movie id and file_size_bytes are required.'], 422);
}
if ($size > $maximum) {
    json_response(['error' => 'Video exceeds the configured maximum upload size.'], 413);
}

$db = database();
$duplicate = $db->prepare(
    'SELECT 1 FROM movies WHERE r2_key = :movie_key '
    . 'UNION ALL SELECT 1 FROM episode_video_versions WHERE r2_key = :episode_key LIMIT 1'
);
$duplicate->execute(['movie_key' => $key, 'episode_key' => $key]);
if ($duplicate->fetchColumn()) {
    json_response(['error' => 'This video is already registered.'], 409);
}
try {
    $client = r2_client();
    $object = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $key]);
} catch (Throwable $exception) {
    error_log('Replacement video verification failed: ' . $exception->getMessage());
    json_response(['error' => 'The uploaded replacement could not be verified.'], 400);
}
$actualSize = filter_var($object['ContentLength'] ?? null, FILTER_VALIDATE_INT);
if ($actualSize === false || $actualSize !== $size || $actualSize < 1 || $actualSize > $maximum) {
    json_response(['error' => 'Uploaded video size does not match the declared size or exceeds the configured maximum.'], 400);
}

$db->beginTransaction();
$statement = $db->prepare('SELECT id, title, r2_key FROM movies WHERE id = :id FOR UPDATE');
$statement->execute(['id' => $id]);
$movie = $statement->fetch();
if (!$movie) {
    $db->rollBack();
    json_response(['error' => 'Movie not found.'], 404);
}
try {
    admin_lock_storage_keys($db, [$movie['r2_key'], $key]);
    admin_assert_storage_keys_available($db, [$key]);
    $registeredKey = $db->prepare(
        'SELECT 1 FROM movies WHERE r2_key = :movie_key '
        . 'UNION ALL SELECT 1 FROM episode_video_versions WHERE r2_key = :episode_key LIMIT 1'
    );
    $registeredKey->execute(['movie_key' => $key, 'episode_key' => $key]);
    if ($registeredKey->fetchColumn()) {
        $db->rollBack();
        json_response(['error' => 'This video is already registered.'], 409);
    }

    $update = $db->prepare('UPDATE movies SET r2_key = :r2_key WHERE id = :id AND deletion_pending = FALSE');
    $update->execute(['id' => $id, 'r2_key' => $key]);
    if ($update->rowCount() !== 1) {
        $db->rollBack();
        json_response(['error' => 'Movie not found.'], 404);
    }
    $cleanupJobId = null;
    if ($movie['r2_key'] !== $key) {
        $cleanupJobId = admin_enqueue_storage_cleanup($db, $actorId, $id, $movie['r2_key']);
    }
    admin_log_activity(
        $db,
        $actorId,
        'movie.video_replaced',
        'movie',
        (string) $id,
        'Replaced video for movie: ' . $movie['title'],
        ['previous_key' => $movie['r2_key'], 'replacement_key' => $key, 'cleanup_job_id' => $cleanupJobId],
    );
    $db->commit();
} catch (AdminDeletionException $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    json_response(['error' => $exception->getMessage()], $exception->httpStatus);
} catch (Throwable $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Movie video replacement registration failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not register the replacement video.'], 500);
}

$cleanupWarning = null;
if ($cleanupJobId !== null) {
    try {
        admin_process_deletion_job($db, $cleanupJobId);
    } catch (AdminDeletionException $exception) {
        $cleanupWarning = $exception->getMessage();
    } catch (Throwable $exception) {
        error_log('Could not remove replaced movie object ' . $movie['r2_key'] . ': ' . $exception->getMessage());
        $cleanupWarning = 'Replacement succeeded, but cleanup is incomplete. The saved cleanup job can be retried.';
    }
}

json_response([
    'message' => 'Movie video replaced.',
    'cleanup_warning' => $cleanupWarning,
    'cleanup_job_id' => $cleanupJobId,
]);
