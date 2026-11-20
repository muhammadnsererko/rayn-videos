<?php
declare(strict_types=1);

function series_catalogue(?int $seriesId = null): array
{
    $sql = 'SELECT series.id AS series_id, series.title AS series_title, series.description AS series_description, '
        . 'series.poster_url, series.backdrop_url, series.poster_key, series.backdrop_key, series.created_at AS series_created_at, '
        . 'seasons.id AS season_id, seasons.season_number, seasons.release_year, '
        . 'episodes.id AS episode_id, episodes.episode_number, episodes.title AS episode_title, '
        . 'episodes.description AS episode_description, episodes.duration_minutes, episodes.tier, '
        . 'episode_video_versions.id AS version_id, episode_video_versions.vj_id, vjs.name AS vj_name '
        . 'FROM series '
        . 'LEFT JOIN seasons ON seasons.series_id = series.id AND seasons.deletion_pending = FALSE '
        . 'LEFT JOIN episodes ON episodes.season_id = seasons.id AND episodes.deletion_pending = FALSE '
        . 'LEFT JOIN episode_video_versions ON episode_video_versions.episode_id = episodes.id '
        . 'AND episode_video_versions.is_current = TRUE AND episode_video_versions.deletion_pending = FALSE '
        . 'LEFT JOIN vjs ON vjs.id = episode_video_versions.vj_id AND vjs.is_active = TRUE';
    $sql .= ' WHERE series.deletion_pending = FALSE';
    if ($seriesId !== null) {
        $sql .= ' AND series.id = :series_id';
    }
    $sql .= ' ORDER BY LOWER(series.title), series.id, seasons.season_number, seasons.id, '
        . 'episodes.episode_number, episodes.id, LOWER(vjs.name), vjs.id';

    $statement = database()->prepare($sql);
    if ($seriesId !== null) {
        $statement->bindValue('series_id', $seriesId, PDO::PARAM_INT);
    }
    $statement->execute();

    $series = [];
    foreach ($statement->fetchAll() as $row) {
        $seriesKey = (string) $row['series_id'];
        if (!isset($series[$seriesKey])) {
            $series[$seriesKey] = [
                'id' => $row['series_id'],
                'title' => $row['series_title'],
                'description' => $row['series_description'],
                'poster_url' => $row['poster_url'],
                'backdrop_url' => $row['backdrop_url'],
                'poster_key' => $row['poster_key'],
                'backdrop_key' => $row['backdrop_key'],
                'created_at' => $row['series_created_at'],
                'seasons' => [],
            ];
        }

        if ($row['season_id'] === null) {
            continue;
        }

        $seasonKey = (string) $row['season_id'];
        if (!isset($series[$seriesKey]['seasons'][$seasonKey])) {
            $series[$seriesKey]['seasons'][$seasonKey] = [
                'id' => $row['season_id'],
                'season_number' => $row['season_number'],
                'release_year' => $row['release_year'],
                'episodes' => [],
            ];
        }

        if ($row['episode_id'] === null) {
            continue;
        }

        $episodeKey = (string) $row['episode_id'];
        if (!isset($series[$seriesKey]['seasons'][$seasonKey]['episodes'][$episodeKey])) {
            $series[$seriesKey]['seasons'][$seasonKey]['episodes'][$episodeKey] = [
                'id' => $row['episode_id'],
                'episode_number' => $row['episode_number'],
                'title' => $row['episode_title'],
                'description' => $row['episode_description'],
                'duration_minutes' => $row['duration_minutes'],
                'tier' => $row['tier'],
                'available' => false,
                'versions' => [],
            ];
        }

        if ($row['version_id'] === null || $row['vj_name'] === null) {
            continue;
        }

        $episode = &$series[$seriesKey]['seasons'][$seasonKey]['episodes'][$episodeKey];
        $episode['available'] = true;
        $episode['versions'][] = [
            'id' => $row['version_id'],
            'vj_id' => $row['vj_id'],
            'vj_name' => $row['vj_name'],
        ];
        unset($episode);
    }

    $hasPrivateArtwork = false;
    foreach ($series as $item) {
        if ($item['poster_key'] !== null || $item['backdrop_key'] !== null) {
            $hasPrivateArtwork = true;
            break;
        }
    }

    if ($hasPrivateArtwork) {
        try {
            $client = r2_client();
            foreach ($series as &$item) {
                if ($item['poster_key'] !== null) {
                    $item['poster_url'] = signed_artwork_url($client, $item['poster_key']);
                }
                if ($item['backdrop_key'] !== null) {
                    $item['backdrop_url'] = signed_artwork_url($client, $item['backdrop_key']);
                }
            }
            unset($item);
        } catch (Throwable $exception) {
            error_log('Could not create signed series artwork URLs: ' . $exception->getMessage());
            json_response(['error' => 'Could not prepare series artwork.'], 502);
        }
    }

    foreach ($series as &$item) {
        unset($item['poster_key'], $item['backdrop_key']);
        $item['seasons'] = array_values($item['seasons']);
        foreach ($item['seasons'] as &$season) {
            $season['episodes'] = array_values($season['episodes']);
        }
        unset($season);
    }
    unset($item);

    return array_values($series);
}
