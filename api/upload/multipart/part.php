<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$key = validated_upload_key($input['r2_key'] ?? null);
$uploadId = validated_multipart_upload_id($input['upload_id'] ?? null);
$partNumber = filter_var($input['part_number'] ?? null, FILTER_VALIDATE_INT);
if ($partNumber === false || $partNumber < 1 || $partNumber > 10_000) {
    json_response(['error' => 'part_number must be between 1 and 10000.'], 422);
}

try {
    $client = r2_client();
    $command = $client->getCommand('UploadPart', [
        'Bucket' => r2_bucket(),
        'Key' => $key,
        'UploadId' => $uploadId,
        'PartNumber' => $partNumber,
    ]);
    $request = $client->createPresignedRequest($command, '+15 minutes');
} catch (Throwable $exception) {
    error_log('Could not presign R2 multipart part: ' . $exception->getMessage());
    json_response(['error' => 'Could not prepare this upload part.'], 502);
}

json_response([
    'upload_url' => (string) $request->getUri(),
    'part_number' => $partNumber,
    'expires_in' => 900,
]);
