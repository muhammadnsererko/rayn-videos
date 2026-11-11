<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

require_method('GET');
header('Cache-Control: no-store');
$tier = strtolower(trim((string) ($_GET['tier'] ?? 'all')));
if (!in_array($tier, ['all', 'free', 'vip'], true)) {
    json_response(['error' => 'Tier must be all, free, or vip.'], 422);
}

$sql = 'SELECT movies.id, movies.title, movies.description, movies.tier, movies.release_year, '
    . 'movies.duration_minutes, movies.poster_url, movies.backdrop_url, movies.poster_key, '
    . 'movies.backdrop_key, vjs.name AS vj_name, movies.created_at '
    . 'FROM movies LEFT JOIN vjs ON vjs.id = movies.vj_id';
if ($tier !== 'all') {
    $sql .= ' WHERE movies.tier = :tier';
}
$sql .= ' ORDER BY movies.created_at DESC, movies.id DESC';

$statement = database()->prepare($sql);
if ($tier !== 'all') {
    $statement->bindValue('tier', $tier);
}
$statement->execute();

$movies = $statement->fetchAll();
$hasPrivateArtwork = false;
foreach ($movies as $movie) {
    if ($movie['poster_key'] !== null || $movie['backdrop_key'] !== null) {
        $hasPrivateArtwork = true;
        break;
    }
}

if ($hasPrivateArtwork) {
    try {
        $client = r2_client();
        foreach ($movies as &$movie) {
            if ($movie['poster_key'] !== null) {
                $movie['poster_url'] = signed_artwork_url($client, $movie['poster_key']);
                $movie['poster_signed'] = true;
            }
            if ($movie['backdrop_key'] !== null) {
                $movie['backdrop_url'] = signed_artwork_url($client, $movie['backdrop_key']);
                $movie['backdrop_signed'] = true;
            }
            unset($movie['poster_key'], $movie['backdrop_key']);
        }
        unset($movie);
    } catch (Throwable $exception) {
        error_log('Could not create signed movie artwork URLs: ' . $exception->getMessage());
        json_response(['error' => 'Could not prepare movie artwork.'], 502);
    }
} else {
    foreach ($movies as &$movie) {
        unset($movie['poster_key'], $movie['backdrop_key']);
    }
    unset($movie);
}

json_response(['movies' => $movies]);