<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

require_method('GET');
$tier = strtolower(trim((string) ($_GET['tier'] ?? 'all')));
if (!in_array($tier, ['all', 'free', 'vip'], true)) {
    json_response(['error' => 'Tier must be all, free, or vip.'], 422);
}

$sql = 'SELECT id, title, description, tier, release_year, duration_minutes, poster_url, created_at FROM movies';
if ($tier !== 'all') {
    $sql .= ' WHERE tier = :tier';
}
$sql .= ' ORDER BY created_at DESC, id DESC';

$statement = database()->prepare($sql);
if ($tier !== 'all') {
    $statement->bindValue('tier', $tier);
}
$statement->execute();

json_response(['movies' => $statement->fetchAll()]);