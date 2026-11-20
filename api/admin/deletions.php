<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/common.php';

require_method('GET');
require_admin();
header('Cache-Control: no-store');

$statement = database()->query(
    'SELECT jobs.id, jobs.operation, jobs.entity_type, jobs.entity_id, jobs.status, jobs.attempt_count, '
    . 'jobs.created_at, jobs.updated_at, COUNT(objects.id) AS object_count, '
    . 'COUNT(objects.id) FILTER (WHERE objects.status = \'deleted\') AS deleted_object_count, '
    . 'COUNT(objects.id) FILTER (WHERE objects.status = \'shared\') AS shared_object_count '
    . 'FROM admin_deletion_jobs AS jobs '
    . 'LEFT JOIN admin_deletion_objects AS objects ON objects.job_id = jobs.id '
    . 'WHERE jobs.status <> \'completed\' '
    . 'GROUP BY jobs.id ORDER BY jobs.updated_at DESC, jobs.id DESC'
);

json_response(['deletion_jobs' => $statement->fetchAll()]);
