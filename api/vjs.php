<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

require_admin();
$method = $_SERVER['REQUEST_METHOD'] ?? '';

function vj_response(array $vj): array
{
    $vj['is_active'] = in_array($vj['is_active'], [true, 1, '1', 't', 'true'], true);
    return $vj;
}

if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true)) {
    header('Allow: GET, POST, PUT, DELETE, OPTIONS');
    json_response(['error' => 'Method not allowed.'], 405);
}

if ($method === 'GET') {
    $includeInactive = ($_GET['include_inactive'] ?? '') === 'true';
    $sql = 'SELECT id, name, is_active, created_at, updated_at FROM vjs';
    if (!$includeInactive) {
        $sql .= ' WHERE is_active = TRUE';
    }
    $sql .= ' ORDER BY LOWER(name), id';
    $statement = database()->query($sql);
    json_response(['vjs' => array_map('vj_response', $statement->fetchAll())]);
}

$input = request_json();
if ($method === 'POST') {
    $name = trim(is_string($input['name'] ?? null) ? $input['name'] : '');
    if ($name === '' || !preg_match('//u', $name) || preg_match_all('/./us', $name, $matches) > 120) {
        json_response(['error' => 'VJ name is required and must be at most 120 characters.'], 422);
    }

    try {
        $statement = database()->prepare(
            'INSERT INTO vjs (name) VALUES (:name) '
            . 'RETURNING id, name, is_active, created_at, updated_at'
        );
        $statement->execute(['name' => $name]);
    } catch (PDOException $exception) {
        if ($exception->getCode() === '23505') {
            json_response(['error' => 'A VJ with that name already exists.'], 409);
        }
        error_log('VJ creation failed: ' . $exception->getMessage());
        json_response(['error' => 'Could not create VJ.'], 500);
    }

    json_response(['vj' => vj_response($statement->fetch())], 201);
}

$id = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1],
]);
if ($id === false) {
    json_response(['error' => 'A positive VJ id is required.'], 422);
}

if ($method === 'PUT') {
    $name = trim(is_string($input['name'] ?? null) ? $input['name'] : '');
    if ($name === '' || !preg_match('//u', $name) || preg_match_all('/./us', $name, $matches) > 120) {
        json_response(['error' => 'VJ name is required and must be at most 120 characters.'], 422);
    }

    try {
        $statement = database()->prepare(
            'UPDATE vjs SET name = :name, updated_at = NOW() WHERE id = :id '
            . 'RETURNING id, name, is_active, created_at, updated_at'
        );
        $statement->execute(['id' => $id, 'name' => $name]);
    } catch (PDOException $exception) {
        if ($exception->getCode() === '23505') {
            json_response(['error' => 'A VJ with that name already exists.'], 409);
        }
        error_log('VJ update failed: ' . $exception->getMessage());
        json_response(['error' => 'Could not update VJ.'], 500);
    }
    $vj = $statement->fetch();
    if (!$vj) {
        json_response(['error' => 'VJ not found.'], 404);
    }

    json_response(['vj' => vj_response($vj)]);
}

if ($method === 'DELETE') {
    $statement = database()->prepare(
        'UPDATE vjs SET is_active = FALSE, updated_at = NOW() WHERE id = :id '
        . 'RETURNING id, name, is_active, created_at, updated_at'
    );
    $statement->execute(['id' => $id]);
    $vj = $statement->fetch();
    if (!$vj) {
        json_response(['error' => 'VJ not found.'], 404);
    }

    json_response(['vj' => vj_response($vj)]);
}
