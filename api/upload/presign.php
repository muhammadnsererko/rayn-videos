<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$contentType = (string) ($input['content_type'] ?? '');
$fileSize = $input['file_size_bytes'] ?? null;
if (!array_key_exists('file_size_bytes', $input) || !is_int($fileSize) || $fileSize < 1) {
    json_response(['error' => 'file_size_bytes must be a positive integer.'], 422);
}
$maximumBytes = video_max_upload_bytes();
if ($fileSize > $maximumBytes) {
    json_response(['error' => 'Video exceeds the configured maximum upload size.'], 413);
}

$extensions = [
    'video/mp4' => 'mp4',
    'video/webm' => 'webm',
    'video/quicktime' => 'mov',
];

if (!isset($extensions[$contentType])) {
    json_response(['error' => 'content_type must be video/mp4, video/webm, or video/quicktime.'], 422);
}
if ($fileSize >= r2_multipart_threshold_bytes() && $contentType !== 'video/mp4') {
    json_response(['error' => 'Large multipart uploads must be processed MP4 files.'], 415);
}

$key = 'uploads/' . bin2hex(random_bytes(16)) . '.' . $extensions[$contentType];
try {
    $client = r2_client();
    if ($fileSize >= r2_multipart_threshold_bytes()) {
        $partSize = r2_multipart_part_size_bytes();
        if ((int) ceil($fileSize / $partSize) > 10_000) {
            json_response(['error' => 'Upload would exceed the S3 multipart part limit.'], 413);
        }

        $result = $client->createMultipartUpload([
            'Bucket' => r2_bucket(),
            'Key' => $key,
            'ContentType' => $contentType,
        ]);
        $uploadId = $result['UploadId'] ?? null;
        if (!is_string($uploadId) || $uploadId === '') {
            throw new RuntimeException('R2 did not return a multipart upload id.');
        }

        json_response([
            'mode' => 'multipart',
            'r2_key' => $key,
            'upload_id' => $uploadId,
            'part_size_bytes' => $partSize,
            'expires_in' => 900,
        ], 201);
    }

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
    'mode' => 'single',
    'upload_url' => (string) $request->getUri(),
    'r2_key' => $key,
    'expires_in' => 900,
    'required_headers' => ['Content-Type' => $contentType],
]);