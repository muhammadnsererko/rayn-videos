<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$title = trim((string) ($input['title'] ?? ''));
$description = trim((string) ($input['description'] ?? ''));
$tier = strtolower(trim((string) ($input['tier'] ?? '')));
$declaredSize = filter_var($input['file_size_bytes'] ?? null, FILTER_VALIDATE_INT);
$maximumBytes = video_max_upload_bytes();
$releaseYear = filter_var($input['release_year'] ?? null, FILTER_VALIDATE_INT);
$durationMinutes = filter_var($input['duration_minutes'] ?? null, FILTER_VALIDATE_INT);
$posterUrl = trim((string) ($input['poster_url'] ?? ''));
$backdropUrl = trim((string) ($input['backdrop_url'] ?? ''));
$posterKey = validated_artwork_key($input['poster_key'] ?? null, 'poster');
$backdropKey = validated_artwork_key($input['backdrop_key'] ?? null, 'backdrop');
$vjId = filter_var($input['vj_id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
$r2Key = (string) ($input['r2_key'] ?? '');

if ($declaredSize === false || $declaredSize < 1) {
    json_response(['error' => 'file_size_bytes must be a positive integer.'], 422);
}
if ($declaredSize > $maximumBytes) {
    json_response(['error' => 'Declared video size exceeds the configured maximum size.'], 413);
}
if ($title === '' || strlen($title) > 255) {
    json_response(['error' => 'Title is required and must be at most 255 characters.'], 422);
}
if (strlen($description) > 10000) {
    json_response(['error' => 'Description must be at most 10000 characters.'], 422);
}
if (!in_array($tier, ['free', 'vip'], true)) {
    json_response(['error' => 'Tier must be free or vip.'], 422);
}
if ($releaseYear === false || $releaseYear < 1888 || $releaseYear > (int) date('Y') + 5) {
    json_response(['error' => 'A valid release_year is required.'], 422);
}
if ($durationMinutes === false || $durationMinutes < 1 || $durationMinutes > 1000) {
    json_response(['error' => 'duration_minutes must be between 1 and 1000.'], 422);
}
if ($vjId === false) {
    json_response(['error' => 'A valid vj_id is required.'], 422);
}
if ($posterUrl !== '' && (!filter_var($posterUrl, FILTER_VALIDATE_URL) || parse_url($posterUrl, PHP_URL_SCHEME) !== 'https')) {
    json_response(['error' => 'poster_url must be a valid HTTPS URL.'], 422);
}
if ($backdropUrl !== '' && (strlen($backdropUrl) > 2048 || !filter_var($backdropUrl, FILTER_VALIDATE_URL) || parse_url($backdropUrl, PHP_URL_SCHEME) !== 'https')) {
    json_response(['error' => 'backdrop_url must be a valid HTTPS URL no longer than 2048 characters.'], 422);
}
if (!preg_match('#^uploads/[a-f0-9]{32}\.(mp4|webm|mov)$#', $r2Key)) {
    json_response(['error' => 'r2_key must come from the upload presign endpoint.'], 422);
}

try {
    $client = r2_client();
    $object = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $r2Key]);
} catch (Throwable $exception) {
    error_log('R2 upload verification failed: ' . $exception->getMessage());
    json_response(['error' => 'The uploaded video could not be verified.'], 400);
}

$objectSize = filter_var($object['ContentLength'] ?? null, FILTER_VALIDATE_INT);
if ($objectSize === false || $objectSize < 1 || $objectSize > $maximumBytes) {
    try {
        $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $r2Key]);
    } catch (Throwable $deleteException) {
        error_log('Could not remove invalid uploaded video: ' . $deleteException->getMessage());
    }
    if ($objectSize !== false && $objectSize > $maximumBytes) {
        json_response(['error' => 'Uploaded video exceeds the configured maximum size.'], 413);
    }
    json_response(['error' => 'Uploaded video must be larger than zero bytes.'], 400);
}
if ($objectSize !== $declaredSize) {
    try {
        $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $r2Key]);
    } catch (Throwable $deleteException) {
        error_log('Could not remove invalid uploaded video: ' . $deleteException->getMessage());
    }
    json_response(['error' => 'Uploaded video size does not match file_size_bytes.'], 400);
}

$vjStatement = database()->prepare('SELECT id, name FROM vjs WHERE id = :id AND is_active = TRUE');
$vjStatement->execute(['id' => $vjId]);
$vj = $vjStatement->fetch();
if (!$vj) {
    json_response(['error' => 'vj_id must reference an active VJ.'], 422);
}

$posterSignedUrl = null;
$backdropSignedUrl = null;
$artworkKeys = array_filter([
    'poster' => $posterKey,
    'backdrop' => $backdropKey,
], static fn (?string $key): bool => $key !== null);
if ($artworkKeys !== []) {
    $maximumImageBytes = image_max_upload_bytes();
    $deleteInvalidArtwork = static function (string $key) use ($client): void {
        try {
            $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $key]);
        } catch (Throwable $deleteException) {
            error_log('Could not remove invalid uploaded artwork: ' . $deleteException->getMessage());
        }
    };

    foreach ($artworkKeys as $kind => $key) {
        try {
            $artworkObject = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $key]);
        } catch (Throwable $exception) {
            error_log('R2 artwork verification failed: ' . $exception->getMessage());
            if ($exception instanceof Aws\Exception\AwsException
                && in_array($exception->getAwsErrorCode(), ['NoSuchKey', 'NotFound'], true)) {
                json_response(['error' => 'The uploaded ' . $kind . ' could not be found.'], 400);
            }
            json_response(['error' => 'The uploaded ' . $kind . ' could not be verified.'], 502);
        }

        $artworkSize = filter_var($artworkObject['ContentLength'] ?? null, FILTER_VALIDATE_INT);
        if ($artworkSize === false || $artworkSize < 1 || $artworkSize > $maximumImageBytes) {
            $deleteInvalidArtwork($key);
            if ($artworkSize !== false && $artworkSize > $maximumImageBytes) {
                json_response(['error' => 'Uploaded ' . $kind . ' exceeds the configured maximum size.'], 413);
            }
            json_response(['error' => 'Uploaded ' . $kind . ' must be larger than zero bytes.'], 400);
        }

        try {
            $artworkObject = $client->getObject(['Bucket' => r2_bucket(), 'Key' => $key]);
            $artworkBytes = (string) $artworkObject['Body'];
        } catch (Throwable $exception) {
            error_log('Could not inspect uploaded R2 artwork: ' . $exception->getMessage());
            json_response(['error' => 'The uploaded ' . $kind . ' could not be verified.'], 502);
        }

        $imageInfo = @getimagesizefromstring($artworkBytes);
        $expectedMimeTypes = [
            'jpg' => 'image/jpeg',
            'png' => 'image/png',
            'webp' => 'image/webp',
        ];
        $extension = strtolower(pathinfo($key, PATHINFO_EXTENSION));
        if (strlen($artworkBytes) !== $artworkSize
            || $imageInfo === false
            || !isset($expectedMimeTypes[$extension])
            || ($imageInfo['mime'] ?? null) !== $expectedMimeTypes[$extension]) {
            $deleteInvalidArtwork($key);
            json_response(['error' => 'Uploaded ' . $kind . ' is not a valid supported image.'], 400);
        }

        try {
            if ($kind === 'poster') {
                $posterSignedUrl = signed_artwork_url($client, $key);
            } else {
                $backdropSignedUrl = signed_artwork_url($client, $key);
            }
        } catch (Throwable $exception) {
            error_log('Could not create signed R2 artwork URL: ' . $exception->getMessage());
            json_response(['error' => 'Could not prepare the uploaded artwork.'], 502);
        }
    }
}

try {
    $statement = database()->prepare(
        'INSERT INTO movies (title, description, tier, release_year, duration_minutes, poster_url, backdrop_url, '
        . 'poster_key, backdrop_key, vj_id, r2_key) '
        . 'VALUES (:title, :description, :tier, :release_year, :duration_minutes, :poster_url, :backdrop_url, '
        . ':poster_key, :backdrop_key, :vj_id, :r2_key) '
        . 'RETURNING id, title, description, tier, release_year, duration_minutes, poster_url, backdrop_url, vj_id, created_at'
    );
    $statement->execute([
        'title' => $title,
        'description' => $description,
        'tier' => $tier,
        'release_year' => $releaseYear,
        'duration_minutes' => $durationMinutes,
        'poster_url' => $posterUrl !== '' ? $posterUrl : null,
        'backdrop_url' => $backdropUrl !== '' ? $backdropUrl : null,
        'poster_key' => $posterKey,
        'backdrop_key' => $backdropKey,
        'vj_id' => $vjId,
        'r2_key' => $r2Key,
    ]);
} catch (PDOException $exception) {
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'This video has already been added.'], 409);
    }
    error_log('Movie creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create movie.'], 500);
}

$movie = $statement->fetch();
$movie['vj_name'] = $vj['name'];
if ($posterSignedUrl !== null) {
    $movie['poster_url'] = $posterSignedUrl;
    $movie['poster_signed'] = true;
}
if ($backdropSignedUrl !== null) {
    $movie['backdrop_url'] = $backdropSignedUrl;
    $movie['backdrop_signed'] = true;
}

json_response(['movie' => $movie], 201);