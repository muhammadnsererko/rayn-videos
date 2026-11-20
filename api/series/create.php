<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once dirname(__DIR__) . '/admin/common.php';

require_method('POST');
$adminUser = require_admin();
$input = request_json();

$title = trim(is_string($input['title'] ?? null) ? $input['title'] : '');
$descriptionInput = $input['description'] ?? '';
if (!is_string($descriptionInput)) {
    json_response(['error' => 'description must be a string.'], 422);
}
$description = trim($descriptionInput);
foreach (['poster_url', 'backdrop_url'] as $urlField) {
    if (($input[$urlField] ?? null) !== null && !is_string($input[$urlField])) {
        json_response(['error' => $urlField . ' must be a string or null.'], 422);
    }
}
$posterUrl = trim($input['poster_url'] ?? '');
$backdropUrl = trim($input['backdrop_url'] ?? '');
$posterKey = validated_artwork_key($input['poster_key'] ?? null, 'poster');
$backdropKey = validated_artwork_key($input['backdrop_key'] ?? null, 'backdrop');

if ($title === '' || strlen($title) > 255) {
    json_response(['error' => 'Title is required and must be at most 255 characters.'], 422);
}
if (strlen($description) > 10000) {
    json_response(['error' => 'Description must be at most 10000 characters.'], 422);
}
foreach (['poster' => $posterUrl, 'backdrop' => $backdropUrl] as $kind => $url) {
    if ($url !== '' && (strlen($url) > 2048 || !filter_var($url, FILTER_VALIDATE_URL) || parse_url($url, PHP_URL_SCHEME) !== 'https')) {
        json_response(['error' => $kind . '_url must be a valid HTTPS URL no longer than 2048 characters.'], 422);
    }
}

$client = null;
$signedArtwork = [];
$artworkKeys = array_filter([
    'poster' => $posterKey,
    'backdrop' => $backdropKey,
], static fn (?string $key): bool => $key !== null);
if ($artworkKeys !== []) {
    try {
        $client = r2_client();
    } catch (Throwable $exception) {
        error_log('Could not initialize R2 for series artwork verification: ' . $exception->getMessage());
        json_response(['error' => 'Could not verify series artwork.'], 502);
    }

    foreach ($artworkKeys as $kind => $key) {
        try {
            $object = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $key]);
            $size = filter_var($object['ContentLength'] ?? null, FILTER_VALIDATE_INT);
            if ($size === false || $size < 1 || $size > image_max_upload_bytes()) {
                try {
                    $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $key]);
                } catch (Throwable $deleteException) {
                    error_log('Could not remove invalid series artwork: ' . $deleteException->getMessage());
                }
                json_response(['error' => 'Uploaded ' . $kind . ' has an invalid size.'], $size !== false && $size > image_max_upload_bytes() ? 413 : 400);
            }

            $object = $client->getObject(['Bucket' => r2_bucket(), 'Key' => $key]);
            $bytes = (string) $object['Body'];
            $imageInfo = @getimagesizefromstring($bytes);
            $extension = strtolower(pathinfo($key, PATHINFO_EXTENSION));
            $expectedMimeTypes = ['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'];
            if (strlen($bytes) !== $size || $imageInfo === false
                || !isset($expectedMimeTypes[$extension])
                || ($imageInfo['mime'] ?? null) !== $expectedMimeTypes[$extension]) {
                try {
                    $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $key]);
                } catch (Throwable $deleteException) {
                    error_log('Could not remove invalid series artwork: ' . $deleteException->getMessage());
                }
                json_response(['error' => 'Uploaded ' . $kind . ' is not a valid supported image.'], 400);
            }
            $signedArtwork[$kind] = signed_artwork_url($client, $key);
        } catch (Throwable $exception) {
            error_log('Could not verify series artwork: ' . $exception->getMessage());
            json_response(['error' => 'Could not verify uploaded ' . $kind . '.'], 502);
        }
    }
}

try {
    $db = database();
    $db->beginTransaction();
    admin_assert_storage_keys_available($db, array_filter([$posterKey, $backdropKey]));
    $statement = $db->prepare(
        'INSERT INTO series (title, description, poster_url, backdrop_url, poster_key, backdrop_key) '
        . 'VALUES (:title, :description, :poster_url, :backdrop_url, :poster_key, :backdrop_key) '
        . 'RETURNING id, title, description, poster_url, backdrop_url, created_at, updated_at'
    );
    $statement->execute([
        'title' => $title,
        'description' => $description,
        'poster_url' => $signedArtwork['poster'] ?? ($posterUrl !== '' ? $posterUrl : null),
        'backdrop_url' => $signedArtwork['backdrop'] ?? ($backdropUrl !== '' ? $backdropUrl : null),
        'poster_key' => $posterKey,
        'backdrop_key' => $backdropKey,
    ]);
    $series = $statement->fetch();
    admin_log_activity(
        $db,
        admin_actor_id($adminUser),
        'series.created',
        'series',
        (string) $series['id'],
        'Added series: ' . $series['title'],
    );
    $db->commit();
} catch (AdminDeletionException $exception) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    json_response(['error' => $exception->getMessage()], $exception->httpStatus);
} catch (PDOException $exception) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Series creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create series.'], 500);
} catch (Throwable $exception) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    error_log('Series creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create series.'], 500);
}

json_response(['series' => $series], 201);
