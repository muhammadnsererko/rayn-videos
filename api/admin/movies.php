<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/common.php';

$user = require_admin();
$db = database();
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'PUT', 'DELETE'], true)) {
    header('Allow: GET, PUT, DELETE, OPTIONS');
    json_response(['error' => 'Method not allowed.'], 405);
}
header('Cache-Control: no-store');

if ($method === 'GET') {
    $id = isset($_GET['id']) ? admin_id_from_query() : null;
    $sql = 'SELECT movies.id, movies.title, movies.description, movies.tier, movies.release_year, '
        . 'movies.duration_minutes, movies.poster_url, movies.backdrop_url, movies.poster_key, '
        . 'movies.backdrop_key, movies.r2_key, movies.vj_id, vjs.name AS vj_name, movies.created_at '
        . 'FROM movies LEFT JOIN vjs ON vjs.id = movies.vj_id';
    $sql .= ' WHERE movies.deletion_pending = FALSE';
    if ($id !== null) {
        $sql .= ' AND movies.id = :id';
    }
    $sql .= ' ORDER BY movies.created_at DESC, movies.id DESC';
    $statement = $db->prepare($sql);
    if ($id !== null) {
        $statement->bindValue('id', $id, PDO::PARAM_INT);
    }
    $statement->execute();
    $movies = $statement->fetchAll();
    if ($id !== null && $movies === []) {
        json_response(['error' => 'Movie not found.'], 404);
    }

    $hasArtwork = count(array_filter($movies, static fn (array $movie): bool => $movie['poster_key'] !== null || $movie['backdrop_key'] !== null)) > 0;
    if ($hasArtwork) {
        try {
            $client = r2_client();
            foreach ($movies as &$movie) {
                admin_signed_artwork($movie, $client);
            }
            unset($movie);
        } catch (Throwable $exception) {
            error_log('Could not sign admin movie artwork: ' . $exception->getMessage());
            json_response(['error' => 'Could not prepare movie artwork.'], 502);
        }
    } else {
        foreach ($movies as &$movie) {
            unset($movie['poster_key'], $movie['backdrop_key']);
        }
        unset($movie);
    }
    foreach ($movies as &$movie) {
        unset($movie['r2_key']);
    }
    unset($movie);

    json_response($id === null ? ['movies' => $movies] : ['movie' => $movies[0]]);
}

$id = admin_id_from_query();
$actorId = admin_actor_id($user);
if ($method === 'PUT') {
    $input = request_json();
    $title = trim(is_string($input['title'] ?? null) ? $input['title'] : '');
    $description = $input['description'] ?? null;
    $tier = $input['tier'] ?? null;
    $year = filter_var($input['release_year'] ?? null, FILTER_VALIDATE_INT);
    $duration = filter_var($input['duration_minutes'] ?? null, FILTER_VALIDATE_INT);
    $vjId = filter_var($input['vj_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($title === '' || strlen($title) > 255 || !is_string($description) || strlen($description) > 10000
        || !in_array($tier, ['free', 'vip'], true) || $year === false || $year < 1888 || $year > (int) date('Y') + 5
        || $duration === false || $duration < 1 || $duration > 1000 || $vjId === false) {
        json_response(['error' => 'Movie metadata is invalid. Check the title, description, tier, year, runtime, and VJ.'], 422);
    }
    $vj = $db->prepare('SELECT id FROM vjs WHERE id = :id');
    $vj->execute(['id' => $vjId]);
    if (!$vj->fetchColumn()) {
        json_response(['error' => 'The selected VJ was not found.'], 422);
    }
    $statement = $db->prepare(
        'UPDATE movies SET title = :title, description = :description, tier = :tier, '
        . 'release_year = :release_year, duration_minutes = :duration_minutes, vj_id = :vj_id '
        . 'WHERE id = :id AND deletion_pending = FALSE RETURNING id'
    );
    $statement->execute([
        'id' => $id,
        'title' => $title,
        'description' => $description,
        'tier' => $tier,
        'release_year' => $year,
        'duration_minutes' => $duration,
        'vj_id' => $vjId,
    ]);
    if (!$statement->fetchColumn()) {
        json_response(['error' => 'Movie not found.'], 404);
    }
    admin_log_activity($db, $actorId, 'movie.updated', 'movie', (string) $id, 'Updated movie: ' . $title);
    json_response(['message' => 'Movie updated.']);
}

admin_delete_endpoint($db, $actorId, 'movie', $id);
