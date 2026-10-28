<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
$input = request_json();
$displayName = trim((string) ($input['display_name'] ?? ''));
$email = strtolower(trim((string) ($input['email'] ?? '')));
$password = (string) ($input['password'] ?? '');

if ($displayName === '' || strlen($displayName) > 120) {
    json_response(['error' => 'Display name is required and must be at most 120 characters.'], 422);
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) {
    json_response(['error' => 'A valid email address is required.'], 422);
}
if (strlen($password) < 8 || strlen($password) > 4096) {
    json_response(['error' => 'Password must be between 8 and 4096 characters.'], 422);
}

try {
    $statement = database()->prepare(
        'INSERT INTO users (display_name, email, password_hash) '
        . 'VALUES (:display_name, :email, :password_hash) '
        . 'RETURNING id, display_name, email, role, created_at'
    );
    $statement->execute([
        'display_name' => $displayName,
        'email' => $email,
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $user = $statement->fetch();
} catch (PDOException $exception) {
    if ($exception->getCode() === '23505') {
        json_response(['error' => 'An account with that email already exists.'], 409);
    }
    error_log('Signup failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not create account.'], 500);
}

json_response(['token' => issue_token($user), 'user' => $user], 201);