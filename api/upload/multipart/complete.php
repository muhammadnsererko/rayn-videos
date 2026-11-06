<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$key = validated_upload_key($input['r2_key'] ?? null);
$uploadId = validated_multipart_upload_id($input['upload_id'] ?? null);
$expectedSizeInput = $input['expected_size_bytes'] ?? null;
$expectedSize = is_int($expectedSizeInput) || is_string($expectedSizeInput)
    ? filter_var($expectedSizeInput, FILTER_VALIDATE_INT)
    : false;
$maximumBytes = video_max_upload_bytes();
if ($expectedSize === false || $expectedSize < 1) {
    json_response(['error' => 'expected_size_bytes must be a positive integer.'], 422);
}
if ($expectedSize > $maximumBytes) {
    json_response(['error' => 'Declared video size exceeds the configured maximum size.'], 413);
}
$parts = $input['parts'] ?? null;
if (!is_array($parts) || !array_is_list($parts) || count($parts) < 1 || count($parts) > 10_000) {
    json_response(['error' => 'parts must be a non-empty array of uploaded parts.'], 422);
}

$completeParts = [];
foreach ($parts as $index => $part) {
    if ($part instanceof stdClass) {
        $part = (array) $part;
    }
    if (!is_array($part)) {
        json_response(['error' => 'Each part must include part_number and etag.'], 422);
    }

    $partNumber = filter_var($part['part_number'] ?? null, FILTER_VALIDATE_INT);
    $etag = $part['etag'] ?? null;
    if ($partNumber === false || $partNumber !== $index + 1 || !is_string($etag) || $etag === '' || strlen($etag) > 256 || preg_match('/[\\r\\n\\x00]/', $etag)) {
        json_response(['error' => 'Parts must be consecutively numbered and include a valid ETag.'], 422);
    }

    $completeParts[] = ['PartNumber' => $partNumber, 'ETag' => $etag];
}

$client = r2_client();
try {
    $client->completeMultipartUpload([
        'Bucket' => r2_bucket(),
        'Key' => $key,
        'UploadId' => $uploadId,
        'MultipartUpload' => ['Parts' => $completeParts],
    ]);
} catch (Throwable $exception) {
    $errorCode = $exception instanceof \Aws\Exception\AwsException
        ? $exception->getAwsErrorCode()
        : null;
    if ($errorCode !== 'NoSuchUpload') {
        error_log('Could not complete R2 multipart upload: ' . $exception->getMessage());
        json_response(['error' => 'Could not complete the video upload. Retry the completion request.'], 502);
    }
}

try {
    $object = $client->headObject(['Bucket' => r2_bucket(), 'Key' => $key]);
} catch (Throwable $exception) {
    error_log('Completed R2 object verification failed: ' . $exception->getMessage());
    json_response(['error' => 'Could not verify the completed video. Retry the completion request.'], 502);
}

$objectSize = filter_var($object['ContentLength'] ?? null, FILTER_VALIDATE_INT);
if ($objectSize === false || $objectSize < 1 || $objectSize > $maximumBytes || $objectSize !== $expectedSize) {
    try {
        $client->deleteObject(['Bucket' => r2_bucket(), 'Key' => $key]);
    } catch (Throwable $exception) {
        error_log('Could not remove invalid R2 object: ' . $exception->getMessage());
    }
    if ($objectSize !== false && $objectSize > $maximumBytes) {
        json_response(['error' => 'Completed video exceeds the configured maximum size.'], 413);
    }
    if ($objectSize !== false && $objectSize > 0) {
        json_response(['error' => 'Completed video size does not match expected_size_bytes.'], 400);
    }
    json_response(['error' => 'Completed video must be larger than zero bytes.'], 400);
}

json_response(['completed' => true, 'r2_key' => $key, 'size_bytes' => $objectSize]);
