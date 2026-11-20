<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/common.php';

require_method('GET');
require_admin();
header('Cache-Control: no-store');

$counts = database()->query(
    'SELECT (SELECT COUNT(*) FROM movies WHERE deletion_pending = FALSE) AS movies, '
    . '(SELECT COUNT(*) FROM series WHERE deletion_pending = FALSE) AS series, '
    . '(SELECT COUNT(*) FROM episodes WHERE deletion_pending = FALSE) AS episodes'
)->fetch();
$activity = database()->query(
    'SELECT admin_activity.id, admin_activity.action, admin_activity.entity_type, '
    . 'admin_activity.entity_id, admin_activity.summary, admin_activity.created_at, '
    . 'users.display_name AS actor_name '
    . 'FROM admin_activity JOIN users ON users.id = admin_activity.actor_user_id '
    . 'ORDER BY admin_activity.created_at DESC, admin_activity.id DESC LIMIT 12'
)->fetchAll();

json_response([
    'counts' => [
        'movies' => (int) $counts['movies'],
        'series' => (int) $counts['series'],
        'episodes' => (int) $counts['episodes'],
    ],
    'activity' => $activity,
]);
