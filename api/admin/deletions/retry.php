<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';
require_once dirname(__DIR__) . '/common.php';

require_method('POST');
require_admin();
$jobId = admin_id_from_query('id');

try {
    admin_process_deletion_job(database(), $jobId);
} catch (AdminDeletionException $exception) {
    json_response([
        'error' => $exception->getMessage(),
        'deletion_job_id' => $exception->jobId ?? $jobId,
    ], $exception->httpStatus);
} catch (Throwable $exception) {
    error_log('Deletion retry failed for job ' . $jobId . ': ' . $exception->getMessage());
    json_response([
        'error' => 'Deletion retry could not complete. The saved job remains available.',
        'deletion_job_id' => $jobId,
    ], 503);
}

json_response(['message' => 'Deletion retry completed.', 'deletion_job_id' => $jobId]);
