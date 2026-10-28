<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$contentType = (string) ($input['content_type'] ?? '');
$extensions = [
    'video/mp4' => 'mp4',
    'video/webm' => 'webm',
    'video/quicktime' => 'mov',
];

if (!isset($extensions[$contentType])) {
    json_response(['error' => 'content_type must be video/mp4, video/webm, or video/quicktime.'], 422);
}

$key = 'uploads/' . bin2hex(random_bytes(16)) . '.' . $extensions[$contentType];
try {
    $client = r2_client();
    $command = $client->getCommand('PutObject', [
        'Bucket' => r2_bucket(),
        'Key' => $key,
        'ContentType' => $contentType,
    ]);
    $request = $client->createPresignedRequest($command, '+15 minutes');
} catch (Throwable $exception) {
    error_log('Could not create R2 upload URL: ' . $exception->getMessage());
    json_response(['error' => 'Could not prepare the video upload.'], 502);
}

json_response([
    'upload_url' => (string) $request->getUri(),
    'r2_key' => $key,
    'expires_in' => 900,
    'required_headers' => ['Content-Type' => $contentType],
]);