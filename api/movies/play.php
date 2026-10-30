<?php
declare(strict_types=1);

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

require_once __DIR__ . '/../config.php';

header('Cache-Control: no-store');
require_method('GET');

$id = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
if ($id === false) {
    json_response(['error' => 'Movie id must be a positive integer.'], 422);
}

$statement = database()->prepare('SELECT id, title, tier, r2_key FROM movies WHERE id = :id');
$statement->bindValue('id', $id, PDO::PARAM_INT);
$statement->execute();
$movie = $statement->fetch();
if (!$movie) {
    json_response(['error' => 'Movie not found.'], 404);
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
        // Free films remain available when an optional token is invalid.
    }
}

if ($movie['tier'] === 'vip') {
    if ($claims === null) {
        json_response(['error' => 'Sign in to watch VIP films.'], 401);
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
        json_response(['error' => 'This film is for VIP members.'], 403);
    }
}

try {
    $client = r2_client();
    $command = $client->getCommand('GetObject', [
        'Bucket' => r2_bucket(),
        'Key' => $movie['r2_key'],
    ]);
    $request = $client->createPresignedRequest($command, '+6 hours');
} catch (Throwable $exception) {
    error_log('Could not create R2 playback URL: ' . $exception->getMessage());
    json_response(['error' => 'Could not prepare video playback.'], 502);
}

json_response([
    'url' => (string) $request->getUri(),
    'expires_in' => 21600,
]);
