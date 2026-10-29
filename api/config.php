<?php
declare(strict_types=1);

use Aws\S3\S3Client;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function load_env_file(): void
{
    $envFile = dirname(__DIR__) . '/.env';
    if (!is_file($envFile)) {
        return;
    }

    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }

        [$key, $value] = array_pad(explode('=', $trimmed, 2), 2, '');
        $key = trim($key);
        $value = trim($value);

        if ($value !== '' && (($value[0] === '"' && $value[strlen($value) - 1] === '"') || ($value[0] === "'" && $value[strlen($value) - 1] === "'"))) {
            $value = substr($value, 1, -1);
        }

        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
        putenv($key . '=' . $value);
    }

    if (!getenv('DB_PASSWORD') && getenv('DB_PASS')) {
        putenv('DB_PASSWORD=' . getenv('DB_PASS'));
        $_ENV['DB_PASSWORD'] = getenv('DB_PASS');
        $_SERVER['DB_PASSWORD'] = getenv('DB_PASS');
    }

    if (!getenv('R2_BUCKET') && getenv('R2_BUCKET_NAME')) {
        putenv('R2_BUCKET=' . getenv('R2_BUCKET_NAME'));
        $_ENV['R2_BUCKET'] = getenv('R2_BUCKET_NAME');
        $_SERVER['R2_BUCKET'] = getenv('R2_BUCKET_NAME');
    }
}

load_env_file();

$autoloadPath = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_file($autoloadPath)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'API dependencies are not installed. Run composer install.']);
    exit;
}
require_once $autoloadPath;

function env_value(string $name): ?string
{
    $value = getenv($name);
    if ($value !== false) {
        return $value;
    }

    $value = $_ENV[$name] ?? $_SERVER[$name] ?? null;
    return is_string($value) ? $value : null;
}

$allowedOrigins = array_filter(array_map(
    'trim',
    explode(',', env_value('CORS_ALLOWED_ORIGINS') ?: 'http://localhost:5173')
));
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
} else {
    // Fallback permissive header for local development flexibility
    header('Access-Control-Allow-Origin: *');
}
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function json_response(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

set_exception_handler(static function (Throwable $exception): void {
    error_log('Unhandled API exception: ' . $exception->getMessage());
    json_response(['error' => 'An unexpected server error occurred.'], 500);
});

function require_method(string $method): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        header('Allow: ' . $method . ', OPTIONS');
        json_response(['error' => 'Method not allowed.'], 405);
    }
}

function request_json(): array
{
    try {
        $data = json_decode(file_get_contents('php://input') ?: '', false, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        json_response(['error' => 'Request body must be valid JSON.'], 400);
    }

    if (!$data instanceof stdClass) {
        json_response(['error' => 'Request body must be a JSON object.'], 400);
    }

    return (array) $data;
}

function required_env(string $name): string
{
    $value = env_value($name);
    if ($value === null || trim($value) === '') {
        error_log('Missing required environment variable: ' . $name);
        json_response(['error' => 'The API is not configured correctly.'], 500);
    }

    return $value;
}

function database(): PDO
{
    static $connection;
    if ($connection instanceof PDO) {
        return $connection;
    }

    $host = required_env('DB_HOST');
    $port = env_value('DB_PORT') ?: '5432';
    $name = required_env('DB_NAME');
    $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s;sslmode=require', $host, $port, $name);

    try {
        $password = env_value('DB_PASSWORD') ?? env_value('DB_PASS');
        if ($password === null || trim($password) === '') {
            required_env('DB_PASSWORD');
        }
        $connection = new PDO($dsn, required_env('DB_USER'), $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $exception) {
        error_log('Database connection failed: ' . $exception->getMessage());
        json_response(['error' => 'Could not connect to the database.'], 500);
    }

    return $connection;
}

function jwt_secret(): string
{
    $secret = required_env('JWT_SECRET');
    if (strlen($secret) < 32) {
        error_log('JWT_SECRET must contain at least 32 characters.');
        json_response(['error' => 'The API is not configured correctly.'], 500);
    }

    return $secret;
}

function issue_token(array $user): string
{
    $now = time();
    return JWT::encode([
        'iss' => env_value('JWT_ISSUER') ?: 'rayn-stream-api',
        'iat' => $now,
        'exp' => $now + 3600,
        'sub' => (string) $user['id'],
        'role' => $user['role'],
    ], jwt_secret(), 'HS256');
}

function authenticated_user(): object
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
        json_response(['error' => 'Authentication required.'], 401);
    }

    try {
        $claims = JWT::decode($matches[1], new Key(jwt_secret(), 'HS256'));
        if (($claims->iss ?? null) !== (env_value('JWT_ISSUER') ?: 'rayn-stream-api')) {
            json_response(['error' => 'Invalid or expired token.'], 401);
        }
    } catch (Throwable) {
        json_response(['error' => 'Invalid or expired token.'], 401);
    }

    return $claims;
}

function require_admin(): object
{
    $user = authenticated_user();
    if (($user->role ?? null) !== 'admin') {
        json_response(['error' => 'Administrator access required.'], 403);
    }

    return $user;
}

function r2_client(): S3Client
{
    return new S3Client([
        'version' => 'latest',
        'region' => 'auto',
        'endpoint' => 'https://' . required_env('R2_ACCOUNT_ID') . '.r2.cloudflarestorage.com',
        'credentials' => [
            'key' => required_env('R2_ACCESS_KEY_ID'),
            'secret' => required_env('R2_SECRET_ACCESS_KEY'),
        ],
    ]);
}

function r2_bucket(): string
{
    $bucket = env_value('R2_BUCKET') ?? env_value('R2_BUCKET_NAME');
    if ($bucket === null || trim($bucket) === '') {
        required_env('R2_BUCKET');
    }

    return $bucket;
}