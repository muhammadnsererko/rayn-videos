<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

header('Cache-Control: no-store');
require_method('POST');
$input = request_json();
$email = strtolower(trim((string) ($input['email'] ?? '')));
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) {
    json_response(['error' => 'Enter a valid email address.'], 422);
}

$apiKey = required_env('RESEND_API_KEY');
$senderEmail = required_env('MAIL_FROM_EMAIL');
$frontendUrl = required_env('FRONTEND_URL');
$parsedFrontendUrl = parse_url($frontendUrl);
$frontendScheme = is_array($parsedFrontendUrl) ? ($parsedFrontendUrl['scheme'] ?? null) : null;
$frontendHost = is_array($parsedFrontendUrl) ? strtolower($parsedFrontendUrl['host'] ?? '') : '';
$isSecureFrontend = $frontendScheme === 'https';
$isLocalFrontend = $frontendScheme === 'http' && in_array($frontendHost, ['localhost', '127.0.0.1'], true);
if (
    !is_array($parsedFrontendUrl)
    || (!$isSecureFrontend && !$isLocalFrontend)
    || $frontendHost === ''
    || !in_array($parsedFrontendUrl['path'] ?? '', ['', '/'], true)
    || isset($parsedFrontendUrl['query'])
    || isset($parsedFrontendUrl['fragment'])
    || isset($parsedFrontendUrl['user'])
    || isset($parsedFrontendUrl['pass'])
) {
    error_log('FRONTEND_URL must be an HTTPS origin (or local HTTP origin) without credentials, path, query, or fragment components.');
    json_response(['error' => 'The API is not configured correctly.'], 500);
}
if (!filter_var($senderEmail, FILTER_VALIDATE_EMAIL)) {
    error_log('MAIL_FROM_EMAIL must be a valid email address.');
    json_response(['error' => 'The API is not configured correctly.'], 500);
}

$genericResponse = ['message' => 'If an account exists for that email, a reset link will be sent.'];
$userStatement = database()->prepare('SELECT id, email FROM users WHERE email = :email');
$userStatement->execute(['email' => $email]);
$user = $userStatement->fetch();
if (!$user) {
    json_response($genericResponse);
}

$token = bin2hex(random_bytes(32));
$tokenHash = hash('sha256', $token);
$tokenStatement = database()->prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) '
    . "VALUES (:user_id, :token_hash, NOW() + INTERVAL '1 hour') "
    . 'ON CONFLICT (user_id) DO UPDATE SET '
    . 'token_hash = EXCLUDED.token_hash, created_at = NOW(), '
    . 'expires_at = EXCLUDED.expires_at, used_at = NULL '
    . "WHERE password_reset_tokens.created_at <= NOW() - INTERVAL '1 minute' "
    . 'OR password_reset_tokens.expires_at <= NOW() '
    . 'RETURNING user_id'
);
$tokenStatement->execute([
    'user_id' => $user['id'],
    'token_hash' => $tokenHash,
]);
if (!$tokenStatement->fetchColumn()) {
    json_response($genericResponse);
}

$resetUrl = rtrim($frontendUrl, '/') . '/#reset_token=' . rawurlencode($token);
$senderName = env_value('MAIL_FROM_NAME') ?: 'RAYN STREAM';
$payload = json_encode([
    'from' => $senderName . ' <' . $senderEmail . '>',
    'to' => [$user['email']],
    'subject' => 'Reset your RAYN STREAM password',
    'text' => "Use this link within one hour to reset your password:\n\n" . $resetUrl,
    'html' => '<p>Use this link within one hour to reset your password:</p>'
        . '<p><a href="' . htmlspecialchars($resetUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">Reset password</a></p>',
], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

$context = stream_context_create([
    'http' => [
        'method' => 'POST',
        'header' => "accept: application/json\r\n"
            . "authorization: Bearer {$apiKey}\r\n"
            . "content-type: application/json\r\n",
        'content' => $payload,
        'timeout' => 10,
        'ignore_errors' => true,
    ],
]);
$response = @file_get_contents('https://api.resend.com/emails', false, $context);
$statusLine = $http_response_header[0] ?? '';
if ($response === false || !preg_match('/\s2\d{2}\s/', $statusLine)) {
    error_log('Resend password-reset email delivery failed.');
}

json_response($genericResponse);
