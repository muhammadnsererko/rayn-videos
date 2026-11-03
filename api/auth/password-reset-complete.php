<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

header('Cache-Control: no-store');
require_method('POST');
$input = request_json();
$token = (string) ($input['token'] ?? '');
$password = (string) ($input['password'] ?? '');

if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
    json_response(['error' => 'This password reset link is invalid or has expired.'], 400);
}
if (strlen($password) < 8 || strlen($password) > 4096) {
    json_response(['error' => 'Password must be between 8 and 4096 characters.'], 422);
}

$connection = database();
$connection->beginTransaction();
try {
    $tokenStatement = $connection->prepare(
        'SELECT user_id FROM password_reset_tokens '
        . 'WHERE token_hash = :token_hash AND expires_at > NOW() AND used_at IS NULL '
        . 'FOR UPDATE'
    );
    $tokenStatement->execute(['token_hash' => hash('sha256', $token)]);
    $userId = $tokenStatement->fetchColumn();
    if ($userId === false) {
        $connection->rollBack();
        json_response(['error' => 'This password reset link is invalid or has expired.'], 400);
    }

    $userStatement = $connection->prepare('UPDATE users SET password_hash = :password_hash WHERE id = :id');
    $userStatement->execute([
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
        'id' => $userId,
    ]);
    $consumeStatement = $connection->prepare(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = :user_id'
    );
    $consumeStatement->execute(['user_id' => $userId]);
    $connection->commit();
} catch (Throwable $exception) {
    if ($connection->inTransaction()) {
        $connection->rollBack();
    }
    error_log('Password reset completion failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not reset the password. Please try again.'], 500);
}

json_response(['message' => 'Your password has been reset. You can now sign in.']);
