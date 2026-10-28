<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
$input = request_json();
$email = strtolower(trim((string) ($input['email'] ?? '')));
$password = (string) ($input['password'] ?? '');

if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $password === '') {
    json_response(['error' => 'Email or password is incorrect.'], 401);
}

$statement = database()->prepare(
    'SELECT id, display_name, email, password_hash, role, created_at FROM users WHERE email = :email'
);
$statement->execute(['email' => $email]);
$user = $statement->fetch();

if (!$user || !password_verify($password, $user['password_hash'])) {
    json_response(['error' => 'Email or password is incorrect.'], 401);
}

unset($user['password_hash']);
json_response(['token' => issue_token($user), 'user' => $user]);