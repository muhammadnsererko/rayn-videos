<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$title = trim((string) ($input['title'] ?? ''));
$description = trim((string) ($input['description'] ?? ''));
$tier = strtolower(trim((string) ($input['tier'] ?? '')));
$releaseYear = filter_var($input['release_year'] ?? null, FILTER_VALIDATE_INT);
$durationMinutes = filter_var($input['duration_minutes'] ?? null, FILTER_VALIDATE_INT);
$posterUrl = trim((string) ($input['poster_url'] ?? ''));
$r2Key = (string) ($input['r2_key'] ?? '');

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
if ($posterUrl !== '' && (!filter_var($posterUrl, FILTER_VALIDATE_URL) || parse_url($posterUrl, PHP_URL_SCHEME) !== 'https')) {
    json_response(['error' => 'poster_url must be a valid HTTPS URL.'], 422);
}
if (!preg_match('#^uploads/[a-f0-9]{32}\.(mp4|webm|mov)$#', $r2Key)) {
    json_response(['error' => 'r2_key must come from the upload presign endpoint.'], 422);
}

try {
    r2_client()->headObject(['Bucket' => r2_bucket(), 'Key' => $r2Key]);
} catch (Throwable $exception) {
    error_log('R2 upload verification failed: ' . $exception->getMessage());
    json_response(['error' => 'The uploaded video could not be verified.'], 400);
}

try {
    $statement = database()->prepare(
        'INSERT INTO movies (title, description, tier, release_year, duration_minutes, poster_url, r2_key) '
        . 'VALUES (:title, :description, :tier, :release_year, :duration_minutes, :poster_url, :r2_key) '
        . 'RETURNING id, title, description, tier, release_year, duration_minutes, poster_url, created_at'
    );
    $statement->execute([
        'title' => $title,
        'description' => $description,
        'tier' => $tier,
        'release_year' => $releaseYear,
        'duration_minutes' => $durationMinutes,
        'poster_url' => $posterUrl !== '' ? $posterUrl : null,
        'r2_key' => $r2Key,
    ]);
} catch (PDOException $exception) {
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'This video has already been added.'], 409);
    }
    error_log('Movie creation failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create movie.'], 500);
}

json_response(['movie' => $statement->fetch()], 201);