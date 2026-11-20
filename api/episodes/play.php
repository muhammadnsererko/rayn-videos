<?php
declare(strict_types=1);

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

require_once dirname(__DIR__) . '/config.php';

header('Cache-Control: no-store');
require_method('GET');

$versionId = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
if ($versionId === false) {
    json_response(['error' => 'Episode video version id must be a positive integer.'], 422);
}

$statement = database()->prepare(
    'SELECT episode_video_versions.id, episodes.tier, episode_video_versions.r2_key '
    . 'FROM episode_video_versions '
    . 'JOIN episodes ON episodes.id = episode_video_versions.episode_id '
    . 'JOIN seasons ON seasons.id = episodes.season_id '
    . 'JOIN series ON series.id = seasons.series_id '
    . 'JOIN vjs ON vjs.id = episode_video_versions.vj_id '
    . 'WHERE episode_video_versions.id = :id '
    . 'AND episode_video_versions.is_current = TRUE AND vjs.is_active = TRUE '
    . 'AND episode_video_versions.deletion_pending = FALSE AND episodes.deletion_pending = FALSE '
    . 'AND seasons.deletion_pending = FALSE AND series.deletion_pending = FALSE'
);
$statement->bindValue('id', $versionId, PDO::PARAM_INT);
$statement->execute();
$version = $statement->fetch();
if (!$version) {
    json_response(['error' => 'Episode video version not found.'], 404);
}

$claims = null;
$authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $matches)) {
    try {
        $decodedClaims = JWT::decode($matches[1], new Key(jwt_secret(), 'HS256'));
        if (($decodedClaims->iss ?? null) === (env_value('JWT_ISSUER') ?: 'rayn-stream-api')) {
            $claims = $decodedClaims;
        }
    } catch (Throwable) {
        // Free episodes remain available when an optional token is invalid.
    }
}

if ($version['tier'] === 'vip') {
    if ($claims === null) {
        json_response(['error' => 'Sign in to watch VIP episodes.'], 401);
    }

    $role = null;
    $subject = filter_var($claims->sub ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1],
    ]);
    if ($subject !== false) {
        $userStatement = database()->prepare('SELECT role FROM users WHERE id = :id');
        $userStatement->bindValue('id', $subject, PDO::PARAM_INT);
        $userStatement->execute();
        $role = $userStatement->fetchColumn();
    }

    if (!in_array($role, ['vip', 'admin'], true)) {
        json_response(['error' => 'This episode is for VIP members.'], 403);
    }
}

try {
    $client = r2_client();
    $command = $client->getCommand('GetObject', [
        'Bucket' => r2_bucket(),
        'Key' => $version['r2_key'],
    ]);
    $request = $client->createPresignedRequest($command, '+6 hours');
} catch (Throwable $exception) {
    error_log('Could not create episode playback URL: ' . $exception->getMessage());
    json_response(['error' => 'Could not prepare episode playback.'], 502);
}

json_response([
    'url' => (string) $request->getUri(),
    'expires_in' => 21600,
]);
