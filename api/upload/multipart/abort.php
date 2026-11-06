<?php
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/config.php';

require_method('POST');
require_admin();
$input = request_json();
$key = validated_upload_key($input['r2_key'] ?? null);
$uploadId = validated_multipart_upload_id($input['upload_id'] ?? null);

try {
    r2_client()->abortMultipartUpload([
        'Bucket' => r2_bucket(),
        'Key' => $key,
        'UploadId' => $uploadId,
    ]);
} catch (Throwable $exception) {
    $errorCode = method_exists($exception, 'getAwsErrorCode') ? $exception->getAwsErrorCode() : null;
    if (!in_array($errorCode, ['NoSuchUpload', 'NoSuchKey', 'NotFound'], true)) {
        error_log('Could not abort R2 multipart upload: ' . $exception->getMessage());
        json_response(['error' => 'Could not abort the video upload.'], 502);
    }
}

json_response(['aborted' => true]);
