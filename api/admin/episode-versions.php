<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/common.php';

require_method('DELETE');
$user = require_admin();
$id = admin_id_from_query();
$actorId = admin_actor_id($user);
$db = database();
admin_delete_endpoint($db, $actorId, 'episode_version', $id);
