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
    $statement = $db->prepare(
        'SELECT id, title, description, poster_url, backdrop_url, poster_key, backdrop_key, created_at, updated_at '
        . 'FROM series WHERE deletion_pending = FALSE' . ($id === null ? ' ORDER BY LOWER(title), id' : ' AND id = :id')
    );
    if ($id !== null) {
        $statement->bindValue('id', $id, PDO::PARAM_INT);
    }
    $statement->execute();
    $series = $statement->fetchAll();
    if ($id !== null && $series === []) {
        json_response(['error' => 'Series not found.'], 404);
    }
    $hasArtwork = count(array_filter($series, static fn (array $item): bool => $item['poster_key'] !== null || $item['backdrop_key'] !== null)) > 0;
    if ($hasArtwork) {
        try {
            $client = r2_client();
            foreach ($series as &$item) {
                admin_signed_artwork($item, $client);
            }
            unset($item);
        } catch (Throwable $exception) {
            error_log('Could not sign admin series artwork: ' . $exception->getMessage());
            json_response(['error' => 'Could not prepare series artwork.'], 502);
        }
    } else {
        foreach ($series as &$item) {
            unset($item['poster_key'], $item['backdrop_key']);
        }
        unset($item);
    }

    $seasonsStatement = $db->prepare(
        'SELECT id, series_id, season_number, release_year, created_at FROM seasons WHERE deletion_pending = FALSE '
        . ($id === null ? 'ORDER BY series_id, season_number, id' : 'AND series_id = :series_id ORDER BY season_number, id')
    );
    if ($id !== null) {
        $seasonsStatement->bindValue('series_id', $id, PDO::PARAM_INT);
    }
    $seasonsStatement->execute();
    $seasonRows = $seasonsStatement->fetchAll();
    $episodesStatement = $db->prepare(
        'SELECT episodes.id, episodes.season_id, episodes.episode_number, episodes.title, episodes.description, '
        . 'episodes.duration_minutes, episodes.tier, episodes.created_at '
        . 'FROM episodes JOIN seasons ON seasons.id = episodes.season_id '
        . 'WHERE episodes.deletion_pending = FALSE AND seasons.deletion_pending = FALSE '
        . ($id === null ? 'ORDER BY seasons.series_id, episodes.episode_number, episodes.id' : 'AND seasons.series_id = :series_id ORDER BY episodes.episode_number, episodes.id')
    );
    if ($id !== null) {
        $episodesStatement->bindValue('series_id', $id, PDO::PARAM_INT);
    }
    $episodesStatement->execute();
    $episodeRows = $episodesStatement->fetchAll();
    $versionsStatement = $db->prepare(
        'SELECT episode_video_versions.id, episode_video_versions.episode_id, episode_video_versions.vj_id, '
        . 'episode_video_versions.is_current, episode_video_versions.created_at, vjs.name AS vj_name '
        . 'FROM episode_video_versions JOIN episodes ON episodes.id = episode_video_versions.episode_id '
        . 'JOIN seasons ON seasons.id = episodes.season_id '
        . 'JOIN vjs ON vjs.id = episode_video_versions.vj_id '
        . 'WHERE episode_video_versions.deletion_pending = FALSE AND episodes.deletion_pending = FALSE AND seasons.deletion_pending = FALSE '
        . ($id === null ? 'ORDER BY seasons.series_id, episodes.id, episode_video_versions.created_at DESC' : 'AND seasons.series_id = :series_id ORDER BY episodes.id, episode_video_versions.created_at DESC')
    );
    if ($id !== null) {
        $versionsStatement->bindValue('series_id', $id, PDO::PARAM_INT);
    }
    $versionsStatement->execute();

    $seriesById = [];
    foreach ($series as $index => $item) {
        $series[$index]['seasons'] = [];
        $seriesById[(string) $item['id']] = $index;
    }
    $seasonsById = [];
    foreach ($seasonRows as $season) {
        $seriesIndex = $seriesById[(string) $season['series_id']] ?? null;
        if ($seriesIndex === null) {
            continue;
        }
        $season['episodes'] = [];
        $seasonsById[(string) $season['id']] = [$seriesIndex, count($series[$seriesIndex]['seasons'])];
        $series[$seriesIndex]['seasons'][] = $season;
    }
    $episodesById = [];
    foreach ($episodeRows as $episode) {
        $location = $seasonsById[(string) $episode['season_id']] ?? null;
        if ($location === null) {
            continue;
        }
        [$seriesIndex, $seasonIndex] = $location;
        $episode['versions'] = [];
        $episodesById[(string) $episode['id']] = [$seriesIndex, $seasonIndex, count($series[$seriesIndex]['seasons'][$seasonIndex]['episodes'])];
        $series[$seriesIndex]['seasons'][$seasonIndex]['episodes'][] = $episode;
    }
    foreach ($versionsStatement->fetchAll() as $version) {
        $location = $episodesById[(string) $version['episode_id']] ?? null;
        if ($location === null) {
            continue;
        }
        [$seriesIndex, $seasonIndex, $episodeIndex] = $location;
        $version['is_current'] = in_array($version['is_current'], [true, 1, '1', 't', 'true'], true);
        $series[$seriesIndex]['seasons'][$seasonIndex]['episodes'][$episodeIndex]['versions'][] = $version;
    }

    json_response($id === null ? ['series' => $series] : ['series' => $series[0]]);
}

$actorId = admin_actor_id($user);
if ($method === 'PUT') {
    $id = admin_id_from_query();
    $input = request_json();
    $title = trim(is_string($input['title'] ?? null) ? $input['title'] : '');
    $description = $input['description'] ?? null;
    if ($title === '' || strlen($title) > 255 || !is_string($description) || strlen($description) > 10000) {
        json_response(['error' => 'Series title and description are invalid.'], 422);
    }
    $statement = $db->prepare('UPDATE series SET title = :title, description = :description, updated_at = NOW() WHERE id = :id AND deletion_pending = FALSE RETURNING id');
    $statement->execute(['id' => $id, 'title' => $title, 'description' => $description]);
    if (!$statement->fetchColumn()) {
        json_response(['error' => 'Series not found.'], 404);
    }
    admin_log_activity($db, $actorId, 'series.updated', 'series', (string) $id, 'Updated series: ' . $title);
    json_response(['message' => 'Series updated.']);
}

$id = admin_id_from_query();
admin_delete_endpoint($db, $actorId, 'series', $id);
