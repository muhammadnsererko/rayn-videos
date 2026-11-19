<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$episodeId = filter_var($input['episode_id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$vjId = filter_var($input['vj_id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$fileSize = filter_var($input['file_size_bytes'] ?? null, FILTER_VALIDATE_INT);
$key = validated_upload_key($input['r2_key'] ?? null);
$maximumBytes = video_max_upload_bytes();

if ($episodeId === false || $vjId === false) {
    json_response(['error' => 'Positive episode_id and vj_id values are required.'], 422);
}
if ($fileSize === false || $fileSize < 1) {
    json_response(['error' => 'file_size_bytes must be a positive integer.'], 422);
}
if ($fileSize > $maximumBytes) {
    json_response(['error' => 'Declared video size exceeds the configured maximum size.'], 413);
}

$episodeStatement = database()->prepare('SELECT id FROM episodes WHERE id = :id');
$episodeStatement->execute(['id' => $episodeId]);
if (!$episodeStatement->fetchColumn()) {
    json_response(['error' => 'Episode not found.'], 404);
}
$vjStatement = database()->prepare('SELECT id FROM vjs WHERE id = :id AND is_active = TRUE');
$vjStatement->execute(['id' => $vjId]);
if (!$vjStatement->fetchColumn()) {
    json_response(['error' => 'vj_id must reference an active VJ.'], 422);
}

$existingKey = database()->prepare(
    'SELECT r2_key FROM movies WHERE r2_key = :movie_key'
);
$existingKey->execute(['movie_key' => $key]);
if ($existingKey->fetchColumn() !== false) {
    json_response(['error' => 'This video is already registered.'], 409);
}
$existingVersionKey = database()->prepare(
    'SELECT id FROM episode_video_versions WHERE r2_key = :r2_key'
);
$existingVersionKey->execute(['r2_key' => $key]);
$keyBelongsToVersion = $existingVersionKey->fetchColumn() !== false;

try {
    $client = r2_client();
    $object = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $key]);
} catch (Throwable $exception) {
    error_log('Episode video upload verification failed: ' . $exception->getMessage());
    json_response(['error' => 'The uploaded video could not be verified.'], 400);
}

$objectSize = filter_var($object['ContentLength'] ?? null, FILTER_VALIDATE_INT);
if ($objectSize === false || $objectSize < 1 || $objectSize > $maximumBytes || $objectSize !== $fileSize) {
    if (!$keyBelongsToVersion) {
        try {
            $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $key]);
        } catch (Throwable $deleteException) {
            error_log('Could not remove invalid episode video upload: ' . $deleteException->getMessage());
        }
    }
    if ($objectSize !== false && $objectSize > $maximumBytes) {
        json_response(['error' => 'Uploaded video exceeds the configured maximum size.'], 413);
    }
    if ($objectSize !== false && $objectSize > 0) {
        json_response(['error' => 'Uploaded video size does not match file_size_bytes.'], 400);
    }
    json_response(['error' => 'Uploaded video must be larger than zero bytes.'], 400);
}

$db = database();
try {
    $db->beginTransaction();

    $episodeLock = $db->prepare('SELECT id FROM episodes WHERE id = :id FOR UPDATE');
    $episodeLock->execute(['id' => $episodeId]);
    if (!$episodeLock->fetchColumn()) {
        $db->rollBack();
        json_response(['error' => 'Episode not found.'], 404);
    }

    $vjLock = $db->prepare('SELECT id, name FROM vjs WHERE id = :id AND is_active = TRUE FOR SHARE');
    $vjLock->execute(['id' => $vjId]);
    $lockedVj = $vjLock->fetch();
    if (!$lockedVj) {
        $db->rollBack();
        json_response(['error' => 'vj_id must reference an active VJ.'], 422);
    }

    $retire = $db->prepare(
        'UPDATE episode_video_versions SET is_current = FALSE '
        . 'WHERE episode_id = :episode_id AND vj_id = :vj_id AND is_current = TRUE'
    );
    $retire->execute(['episode_id' => $episodeId, 'vj_id' => $vjId]);

    $insert = $db->prepare(
        'INSERT INTO episode_video_versions (episode_id, vj_id, r2_key, is_current) '
        . 'VALUES (:episode_id, :vj_id, :r2_key, TRUE) '
        . 'RETURNING id, episode_id, vj_id, is_current, created_at'
    );
    $insert->execute(['episode_id' => $episodeId, 'vj_id' => $vjId, 'r2_key' => $key]);
    $version = $insert->fetch();
    $version['vj_name'] = $lockedVj['name'];
    $db->commit();
} catch (PDOException $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'This video is already registered as a version.'], 409);
    }
    error_log('Episode video version registration failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not register episode video version.'], 500);
} catch (Throwable $exception) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Episode video version registration failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not register episode video version.'], 500);
}

json_response(['version' => $version], 201);
