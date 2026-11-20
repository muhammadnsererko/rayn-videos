<?php
declare(strict_types=1);

function admin_actor_id(object $user): int
{
    $id = filter_var($user->sub ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1],
    ]);
    if ($id === false) {
        json_response(['error' => 'Administrator access required.'], 403);
    }

    return $id;
}

function admin_log_activity(
    PDO $db,
    int $actorId,
    string $action,
    string $entityType,
    string $entityId,
    string $summary,
    array $details = [],
): void {
    $statement = $db->prepare(
        'INSERT INTO admin_activity (actor_user_id, action, entity_type, entity_id, summary, details) '
        . 'VALUES (:actor_user_id, :action, :entity_type, :entity_id, :summary, CAST(:details AS JSONB))'
    );
    $statement->execute([
        'actor_user_id' => $actorId,
        'action' => $action,
        'entity_type' => $entityType,
        'entity_id' => $entityId,
        'summary' => $summary,
        'details' => json_encode($details, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
    ]);
}

function admin_storage_reference_count(PDO $db, string $key): int
{
    $statement = $db->prepare(
        'SELECT COUNT(*) FROM ('
        . 'SELECT r2_key AS storage_key FROM movies WHERE r2_key = :movie_video '
        . 'UNION ALL SELECT poster_key FROM movies WHERE poster_key = :movie_poster '
        . 'UNION ALL SELECT backdrop_key FROM movies WHERE backdrop_key = :movie_backdrop '
        . 'UNION ALL SELECT poster_key FROM series WHERE poster_key = :series_poster '
        . 'UNION ALL SELECT backdrop_key FROM series WHERE backdrop_key = :series_backdrop '
        . 'UNION ALL SELECT r2_key FROM episode_video_versions WHERE r2_key = :episode_video'
        . ') AS storage_references WHERE storage_key = :lookup_key'
    );
    $statement->execute([
        'movie_video' => $key,
        'movie_poster' => $key,
        'movie_backdrop' => $key,
        'series_poster' => $key,
        'series_backdrop' => $key,
        'episode_video' => $key,
        'lookup_key' => $key,
    ]);

    return (int) $statement->fetchColumn();
}

final class AdminDeletionException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $httpStatus,
        public readonly ?int $jobId = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}

function admin_lock_storage_keys(PDO $db, array $keys): void
{
    $keys = array_values(array_unique(array_filter(
        $keys,
        static fn ($key): bool => is_string($key) && $key !== '',
    )));
    sort($keys, SORT_STRING);
    $statement = $db->prepare('SELECT pg_advisory_xact_lock(hashtextextended(:object_key, 0))');
    foreach ($keys as $key) {
        $statement->execute(['object_key' => $key]);
    }
}

function admin_assert_storage_keys_available(PDO $db, array $keys): void
{
    admin_lock_storage_keys($db, $keys);
    $statement = $db->prepare(
        'SELECT 1 FROM admin_deletion_objects AS objects '
        . 'JOIN admin_deletion_jobs AS jobs ON jobs.id = objects.job_id '
        . 'WHERE objects.object_key = :object_key AND objects.status IN (\'pending\', \'deleted\') '
        . 'AND jobs.status <> \'completed\' LIMIT 1'
    );
    foreach (array_unique($keys) as $key) {
        $statement->execute(['object_key' => $key]);
        if ($statement->fetchColumn()) {
            throw new AdminDeletionException(
                'This storage object is reserved for deletion and cannot be attached to new content.',
                409,
            );
        }
    }
}

function admin_deletion_target(PDO $db, string $entityType, int $id): ?array
{
    $sql = match ($entityType) {
        'movie' => 'SELECT id, title AS label, r2_key, poster_key, backdrop_key, deletion_pending FROM movies WHERE id = :id FOR UPDATE',
        'series' => 'SELECT id, title AS label, poster_key, backdrop_key, deletion_pending FROM series WHERE id = :id FOR UPDATE',
        'season' => 'SELECT id, series_id, season_number, deletion_pending FROM seasons WHERE id = :id FOR UPDATE',
        'episode' => 'SELECT id, title AS label, deletion_pending FROM episodes WHERE id = :id FOR UPDATE',
        'episode_version' => 'SELECT id, episode_id, r2_key, deletion_pending FROM episode_video_versions WHERE id = :id FOR UPDATE',
        default => throw new LogicException('Unsupported deletion entity type.'),
    };
    $statement = $db->prepare($sql);
    $statement->execute(['id' => $id]);
    $record = $statement->fetch();
    if (!$record) {
        return null;
    }

    $blocker = match ($entityType) {
        'series' => ['sql' => 'SELECT 1 FROM seasons WHERE series_id = :id LIMIT 1', 'message' => 'Delete this series’ seasons first.'],
        'season' => ['sql' => 'SELECT 1 FROM episodes WHERE season_id = :id LIMIT 1', 'message' => 'Delete this season’s episodes first.'],
        'episode' => ['sql' => 'SELECT 1 FROM episode_video_versions WHERE episode_id = :id LIMIT 1', 'message' => 'Delete this episode’s video versions first.'],
        default => null,
    };
    if ($blocker !== null) {
        $statement = $db->prepare($blocker['sql']);
        $statement->execute(['id' => $id]);
        if ($statement->fetchColumn()) {
            throw new AdminDeletionException($blocker['message'], 409);
        }
    }

    $keys = match ($entityType) {
        'movie' => array_values(array_filter([$record['r2_key'], $record['poster_key'], $record['backdrop_key']])),
        'series' => array_values(array_filter([$record['poster_key'], $record['backdrop_key']])),
        'episode_version' => [$record['r2_key']],
        default => [],
    };

    return [
        'record' => $record,
        'keys' => $keys,
        'table' => match ($entityType) {
            'movie' => 'movies',
            'series' => 'series',
            'season' => 'seasons',
            'episode' => 'episodes',
            'episode_version' => 'episode_video_versions',
        },
        'label' => $record['label'] ?? ($entityType === 'season'
            ? 'Season ' . $record['season_number']
            : 'Episode video version ' . $record['id']),
    ];
}

function admin_prepare_deletion(PDO $db, int $actorId, string $entityType, int $id): int
{
    $db->beginTransaction();
    try {
        $target = admin_deletion_target($db, $entityType, $id);
        if ($target === null) {
            throw new AdminDeletionException(ucfirst(str_replace('_', ' ', $entityType)) . ' not found.', 404);
        }

        if (in_array($target['record']['deletion_pending'], [true, 1, '1', 't', 'true'], true)) {
            $activeJob = $db->prepare(
                'SELECT id FROM admin_deletion_jobs WHERE entity_type = :entity_type '
                . 'AND entity_id = :entity_id AND operation = \'delete_records\' '
                . 'AND status <> \'completed\' ORDER BY id DESC LIMIT 1'
            );
            $activeJob->execute(['entity_type' => $entityType, 'entity_id' => (string) $id]);
            $jobId = $activeJob->fetchColumn();
            if ($jobId === false) {
                throw new AdminDeletionException('This record is already marked for deletion.', 409);
            }
            $db->commit();
            return (int) $jobId;
        }

        admin_lock_storage_keys($db, $target['keys']);
        $occurrences = array_count_values($target['keys']);
        $insertJob = $db->prepare(
            'INSERT INTO admin_deletion_jobs '
            . '(actor_user_id, operation, entity_type, entity_id, target_record_ids) '
            . 'VALUES (:actor_user_id, \'delete_records\', :entity_type, :entity_id, CAST(:target_ids AS JSONB)) '
            . 'RETURNING id'
        );
        $insertJob->execute([
            'actor_user_id' => $actorId,
            'entity_type' => $entityType,
            'entity_id' => (string) $id,
            'target_ids' => json_encode([$id], JSON_THROW_ON_ERROR),
        ]);
        $jobId = (int) $insertJob->fetchColumn();
        $insertObject = $db->prepare(
            'INSERT INTO admin_deletion_objects (job_id, object_key, status, target_reference_count) '
            . 'VALUES (:job_id, :object_key, :status, :target_reference_count)'
        );
        foreach ($occurrences as $key => $targetCount) {
            $referenceCount = admin_storage_reference_count($db, $key);
            $insertObject->execute([
                'job_id' => $jobId,
                'object_key' => $key,
                'status' => $referenceCount > $targetCount ? 'shared' : 'pending',
                'target_reference_count' => $targetCount,
            ]);
        }

        $mark = $db->prepare('UPDATE ' . $target['table'] . ' SET deletion_pending = TRUE WHERE id = :id AND deletion_pending = FALSE');
        $mark->execute(['id' => $id]);
        if ($mark->rowCount() !== 1) {
            throw new AdminDeletionException('The content record could not be marked for deletion.', 409);
        }
        admin_log_activity(
            $db,
            $actorId,
            $entityType . '.deletion_queued',
            $entityType,
            (string) $id,
            'Queued deletion: ' . $target['label'],
            ['deletion_job_id' => $jobId],
        );
        $db->commit();

        return $jobId;
    } catch (Throwable $exception) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        if ($exception instanceof AdminDeletionException) {
            throw $exception;
        }
        throw new AdminDeletionException('Could not safely queue this deletion.', 503, null, $exception);
    }
}

function admin_enqueue_storage_cleanup(PDO $db, int $actorId, int $movieId, string $key): int
{
    admin_lock_storage_keys($db, [$key]);
    $statement = $db->prepare(
        'INSERT INTO admin_deletion_jobs '
        . '(actor_user_id, operation, entity_type, entity_id, target_record_ids) '
        . 'VALUES (:actor_user_id, \'cleanup_only\', \'movie_video_replacement\', :entity_id, CAST(:target_ids AS JSONB)) '
        . 'RETURNING id'
    );
    $statement->execute([
        'actor_user_id' => $actorId,
        'entity_id' => (string) $movieId,
        'target_ids' => json_encode([$movieId], JSON_THROW_ON_ERROR),
    ]);
    $jobId = (int) $statement->fetchColumn();
    $insertObject = $db->prepare(
        'INSERT INTO admin_deletion_objects (job_id, object_key, status, target_reference_count) '
        . 'VALUES (:job_id, :object_key, :status, 0)'
    );
    $insertObject->execute([
        'job_id' => $jobId,
        'object_key' => $key,
        'status' => admin_storage_reference_count($db, $key) === 0 ? 'pending' : 'shared',
    ]);

    return $jobId;
}

function admin_record_deletion_failure(PDO $db, int $jobId, string $status, string $message): void
{
    try {
        $statement = $db->prepare(
            'UPDATE admin_deletion_jobs SET status = :status, last_error = :last_error, updated_at = NOW() WHERE id = :id'
        );
        $statement->execute(['id' => $jobId, 'status' => $status, 'last_error' => $message]);
    } catch (Throwable $exception) {
        error_log('Could not persist deletion job failure for job ' . $jobId . ': ' . $exception->getMessage());
    }
}

function admin_process_deletion_job(PDO $db, int $jobId): void
{
    $lockName = 'admin-deletion-job-' . $jobId;
    $lock = $db->prepare('SELECT pg_try_advisory_lock(hashtextextended(:lock_name, 0))');
    $lock->execute(['lock_name' => $lockName]);
    if (!$lock->fetchColumn()) {
        throw new AdminDeletionException('This deletion job is already being processed.', 409, $jobId);
    }

    try {
        $attempt = $db->prepare(
            'UPDATE admin_deletion_jobs SET status = \'processing\', attempt_count = attempt_count + 1, '
            . 'last_error = NULL, updated_at = NOW() WHERE id = :id AND status <> \'completed\' RETURNING operation'
        );
        $attempt->execute(['id' => $jobId]);
        $operation = $attempt->fetchColumn();
        if ($operation === false) {
            $exists = $db->prepare('SELECT 1 FROM admin_deletion_jobs WHERE id = :id AND status = \'completed\'');
            $exists->execute(['id' => $jobId]);
            if ($exists->fetchColumn()) {
                return;
            }
            throw new AdminDeletionException('Deletion job not found.', 404);
        }

        $objects = $db->prepare(
            'SELECT id, object_key, status, target_reference_count FROM admin_deletion_objects '
            . 'WHERE job_id = :job_id ORDER BY id'
        );
        $objects->execute(['job_id' => $jobId]);
        foreach ($objects->fetchAll() as $object) {
            $storageError = null;
            try {
                $db->beginTransaction();
                admin_lock_storage_keys($db, [$object['object_key']]);
                $lockObject = $db->prepare('SELECT status, target_reference_count FROM admin_deletion_objects WHERE id = :id FOR UPDATE');
                $lockObject->execute(['id' => $object['id']]);
                $locked = $lockObject->fetch();
                if (!$locked || $locked['status'] === 'deleted') {
                    $db->commit();
                    continue;
                }

                $referenceCount = admin_storage_reference_count($db, $object['object_key']);
                if ($referenceCount > (int) $locked['target_reference_count']) {
                    if ($locked['status'] !== 'shared') {
                        $shared = $db->prepare(
                            'UPDATE admin_deletion_objects SET status = \'shared\', last_error = NULL, updated_at = NOW() WHERE id = :id'
                        );
                        $shared->execute(['id' => $object['id']]);
                    }
                    $db->commit();
                    continue;
                }

                try {
                    r2_client()->deleteObject(['Bucket' => r2_bucket(), 'Key' => $object['object_key']]);
                } catch (Throwable $exception) {
                    $storageError = $exception;
                }
                if ($storageError === null) {
                    $saved = $db->prepare(
                        'UPDATE admin_deletion_objects SET status = \'deleted\', last_error = NULL, updated_at = NOW() WHERE id = :id'
                    );
                    $saved->execute(['id' => $object['id']]);
                } else {
                    $saved = $db->prepare(
                        'UPDATE admin_deletion_objects SET last_error = :last_error, updated_at = NOW() WHERE id = :id'
                    );
                    $saved->execute([
                        'id' => $object['id'],
                        'last_error' => $storageError->getMessage(),
                    ]);
                    $failed = $db->prepare(
                        'UPDATE admin_deletion_jobs SET status = \'cleanup_failed\', last_error = :last_error, updated_at = NOW() WHERE id = :id'
                    );
                    $failed->execute(['id' => $jobId, 'last_error' => $storageError->getMessage()]);
                }
                $db->commit();
            } catch (Throwable $exception) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }
                error_log('Deletion object processing failed for job ' . $jobId . ': ' . $exception->getMessage());
                admin_record_deletion_failure($db, $jobId, 'cleanup_failed', $exception->getMessage());
                throw new AdminDeletionException(
                    'Storage cleanup is incomplete. This deletion is saved and can be retried.',
                    503,
                    $jobId,
                    $exception,
                );
            }

            if ($storageError !== null) {
                error_log('R2 cleanup failed for deletion job ' . $jobId . ': ' . $storageError->getMessage());
                throw new AdminDeletionException(
                    'Storage cleanup is incomplete. This deletion is saved and can be retried.',
                    502,
                    $jobId,
                    $storageError,
                );
            }
        }

        if ($operation === 'cleanup_only') {
            $shared = $db->prepare(
                'SELECT 1 FROM admin_deletion_objects WHERE job_id = :job_id AND status = \'shared\' LIMIT 1'
            );
            $shared->execute(['job_id' => $jobId]);
            if ($shared->fetchColumn()) {
                admin_record_deletion_failure($db, $jobId, 'cleanup_failed', 'Storage object still has active database references.');
                throw new AdminDeletionException(
                    'The old video is still referenced by another record. Cleanup remains queued for retry.',
                    409,
                    $jobId,
                );
            }
        }

        $sharedReferenceChanged = false;
        try {
            $db->beginTransaction();
            $job = $db->prepare('SELECT actor_user_id, operation, entity_type, entity_id, target_record_ids FROM admin_deletion_jobs WHERE id = :id FOR UPDATE');
            $job->execute(['id' => $jobId]);
            $deletion = $job->fetch();
            if (!$deletion) {
                throw new RuntimeException('Deletion job disappeared before finalization.');
            }
            $jobObjects = $db->prepare(
                'SELECT id, object_key, status, target_reference_count FROM admin_deletion_objects '
                . 'WHERE job_id = :job_id ORDER BY object_key'
            );
            $jobObjects->execute(['job_id' => $jobId]);
            $finalizationObjects = $jobObjects->fetchAll();
            admin_lock_storage_keys(
                $db,
                array_column($finalizationObjects, 'object_key'),
            );
            foreach ($finalizationObjects as $finalizationObject) {
                if ($finalizationObject['status'] !== 'shared') {
                    continue;
                }
                if (admin_storage_reference_count($db, $finalizationObject['object_key'])
                    <= (int) $finalizationObject['target_reference_count']) {
                    $defer = $db->prepare(
                        'UPDATE admin_deletion_objects SET status = \'pending\', updated_at = NOW() WHERE id = :id'
                    );
                    $defer->execute(['id' => $finalizationObject['id']]);
                    $db->prepare(
                        'UPDATE admin_deletion_jobs SET status = \'cleanup_failed\', '
                        . 'last_error = \'Storage references changed during cleanup; retry required.\', updated_at = NOW() '
                        . 'WHERE id = :id'
                    )->execute(['id' => $jobId]);
                    $sharedReferenceChanged = true;
                    break;
                }
            }
            if ($sharedReferenceChanged) {
                $db->commit();
            } else {
                if ($deletion['operation'] === 'delete_records') {
                    $targets = json_decode($deletion['target_record_ids'], true, 512, JSON_THROW_ON_ERROR);
                    $table = match ($deletion['entity_type']) {
                        'movie' => 'movies',
                        'series' => 'series',
                        'season' => 'seasons',
                        'episode' => 'episodes',
                        'episode_version' => 'episode_video_versions',
                        default => throw new LogicException('Unsupported deletion job entity type.'),
                    };
                    foreach ($targets as $targetId) {
                        $delete = $db->prepare('DELETE FROM ' . $table . ' WHERE id = :id AND deletion_pending = TRUE');
                        $delete->execute(['id' => $targetId]);
                        if ($delete->rowCount() !== 1) {
                            throw new RuntimeException('A marked content record could not be finalized.');
                        }
                    }
                }

                admin_log_activity(
                    $db,
                    (int) $deletion['actor_user_id'],
                    $deletion['entity_type'] . '.deletion_completed',
                    $deletion['entity_type'],
                    $deletion['entity_id'],
                    'Completed deletion job ' . $jobId,
                    ['deletion_job_id' => $jobId],
                );
                $complete = $db->prepare(
                    'UPDATE admin_deletion_jobs SET status = \'completed\', last_error = NULL, updated_at = NOW(), completed_at = NOW() WHERE id = :id'
                );
                $complete->execute(['id' => $jobId]);
                $db->commit();
            }
        } catch (Throwable $exception) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            error_log('Deletion job finalization failed for job ' . $jobId . ': ' . $exception->getMessage());
            admin_record_deletion_failure($db, $jobId, 'finalization_failed', $exception->getMessage());
            throw new AdminDeletionException(
                'Storage cleanup completed, but the database finalization failed. This deletion is saved and can be retried.',
                503,
                $jobId,
                $exception,
            );
        }
        if ($sharedReferenceChanged) {
            throw new AdminDeletionException(
                'Storage references changed during deletion. Cleanup remains queued and can be retried.',
                409,
                $jobId,
            );
        }
    } finally {
        $unlock = $db->prepare('SELECT pg_advisory_unlock(hashtextextended(:lock_name, 0))');
        $unlock->execute(['lock_name' => $lockName]);
    }
}

function admin_delete_endpoint(PDO $db, int $actorId, string $entityType, int $id): never
{
    $jobId = null;
    try {
        $jobId = admin_prepare_deletion($db, $actorId, $entityType, $id);
        admin_process_deletion_job($db, $jobId);
    } catch (AdminDeletionException $exception) {
        json_response([
            'error' => $exception->getMessage(),
            'deletion_job_id' => $exception->jobId ?? $jobId,
        ], $exception->httpStatus);
    } catch (Throwable $exception) {
        error_log('Deletion endpoint failed: ' . $exception->getMessage());
        json_response([
            'error' => 'Deletion could not be completed. The saved job can be retried.',
            'deletion_job_id' => $jobId,
        ], 503);
    }

    json_response(['message' => 'Content deletion completed.']);
}

function admin_id_from_query(string $name = 'id'): int
{
    $id = filter_var($_GET[$name] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1],
    ]);
    if ($id === false) {
        json_response(['error' => $name . ' must be a positive integer.'], 422);
    }

    return $id;
}

function admin_signed_artwork(array &$record, Aws\S3\S3Client $client): void
{
    foreach (['poster', 'backdrop'] as $kind) {
        $keyField = $kind . '_key';
        if (!empty($record[$keyField])) {
            $record[$kind . '_url'] = signed_artwork_url($client, $record[$keyField]);
        }
        unset($record[$keyField]);
    }
}
