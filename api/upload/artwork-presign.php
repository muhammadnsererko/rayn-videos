<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$kind = $input['kind'] ?? null;
$contentType = $input['content_type'] ?? null;
$fileSize = $input['file_size_bytes'] ?? null;

if (!in_array($kind, ['poster', 'backdrop'], true)) {
    json_response(['error' => 'kind must be poster or backdrop.'], 422);
}

$extensions = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
];
if (!is_string($contentType) || !isset($extensions[$contentType])) {
    json_response(['error' => 'content_type must be image/jpeg, image/png, or image/webp.'], 422);
}
if (!is_int($fileSize) || $fileSize < 1) {
    json_response(['error' => 'file_size_bytes must be a positive integer.'], 422);
}
if ($fileSize > image_max_upload_bytes()) {
    json_response(['error' => 'Artwork exceeds the configured maximum upload size.'], 413);
}

$prefix = $kind === 'poster' ? 'posters/' : 'backdrops/';
$key = $prefix . bin2hex(random_bytes(16)) . '.' . $extensions[$contentType];

try {
    $client = r2_client();
    $command = $client->getCommand('PutObject', [
        'Bucket' => r2_bucket(),
        'Key' => $key,
        'ContentType' => $contentType,
    ]);
    $request = $client->createPresignedRequest($command, '+15 minutes');
} catch (Throwable $exception) {
    error_log('Could not create R2 artwork upload URL: ' . $exception->getMessage());
    json_response(['error' => 'Could not prepare the artwork upload.'], 502);
}

json_response([
    'upload_url' => (string) $request->getUri(),
    'artwork_key' => $key,
    'expires_in' => 900,
    'required_headers' => ['Content-Type' => $contentType],
], 201);
