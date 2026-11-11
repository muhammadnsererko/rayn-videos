# RAYN STREAM API

PHP 8.1+ JSON API for RAYN STREAM. PostgreSQL is hosted by Supabase; video uploads go directly from the client to a private Cloudflare R2 bucket using short-lived presigned URLs.

## Setup

1. Install PHP 8.1+ with the `pdo_pgsql` extension and Composer.
2. Install PHP dependencies with `composer install`.
3. For a fresh database only, run [`database/schema.sql`](database/schema.sql) in the Supabase SQL Editor.
4. Copy `.env.example` to `.env` and set your Supabase PostgreSQL connection details and Cloudflare R2 credentials. Use the Supabase direct or session pooler connection details, including its assigned username and port. Keep `.env` private; it is ignored by Git.
5. Generate a JWT secret with `php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'` and put the result in `JWT_SECRET`.
6. Create a private R2 bucket and an R2 API token with object read/write access scoped to that bucket.
7. Promote an account to administrator from the Supabase SQL Editor after signing up: `UPDATE users SET role = 'admin' WHERE email = lower('admin@example.com');`
8. For password resets, apply [`database/add-password-reset-tokens.sql`](database/add-password-reset-tokens.sql) to an existing database (or use the updated schema for a new database), then configure the Resend variables below. Resend's free transactional tier requires a sending domain that you own and verify.
9. On an existing Supabase database, apply the [artwork and VJ migration](database/add-movie-artwork-and-vjs.sql) by following the ordered steps below before deploying updated application code.

### Existing Supabase Database Migration Order

1. Confirm the existing `users` and `movies` tables are present. Do not run `schema.sql` as a substitute for this migration; `CREATE TABLE IF NOT EXISTS` does not add fields to existing tables.
2. Run the entire [`database/add-movie-artwork-and-vjs.sql`](database/add-movie-artwork-and-vjs.sql) script in the Supabase SQL Editor. It is idempotent, creates the VJ table, and adds nullable artwork/VJ fields (including `backdrop_url` if absent) while retaining legacy URL columns. If it reports an error, resolve that before continuing.
3. Set `IMAGE_MAX_UPLOAD_BYTES` if changing its 5,000,000-byte default, and configure private-bucket CORS for the deployed frontend origin with PUT and the required Content-Type header.
4. Deploy the updated API and frontend only after the migration and storage configuration are ready.
5. In the admin form, use **Manage VJs** to add the active VJ names before registering new movies. The migration deliberately does not assign VJs to existing movies; their nullable association preserves legacy records.

For a fresh database, run [`database/schema.sql`](database/schema.sql) instead of the existing-database migration. Do not run or assume either migration has been applied by this code change.

For local development, export `.env` values into the PHP server process and serve the workspace root:

```sh
set -a
. ./.env
set +a
php -S 127.0.0.1:8000 -t .
```

Configure `CORS_ALLOWED_ORIGINS` as a comma-separated list of exact frontend origins. Browser requests with an unlisted origin are rejected; requests without an `Origin` header are not blocked by CORS.

## Render deployment

Deploy the repository root as a Docker web service. The Docker image uses PHP 8.3 with Apache and serves the existing routes beneath `/api/`. Set the Render health-check path to `/api/health.php`; it is a lightweight process liveness check and does not test the database.

Set these variables in the Render service environment:

- `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` for Supabase PostgreSQL (`DB_PORT` is optional and defaults to `5432`; `DB_SSLMODE` defaults to `require`).
- `JWT_SECRET` and, optionally, `JWT_ISSUER`.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` for the private Cloudflare R2 bucket.
- `IMAGE_MAX_UPLOAD_BYTES` is optional and defaults to `5000000` bytes for each poster/backdrop.
- `CORS_ALLOWED_ORIGINS` as a comma-separated list of exact deployed frontend origins.
- `RESEND_API_KEY`, `MAIL_FROM_EMAIL` (an address at a domain verified with Resend), and `FRONTEND_URL` (the HTTPS frontend origin used in reset links). `MAIL_FROM_NAME` is optional.

Render supplies `PORT` at runtime; the container configures Apache to bind to it. Do not add secrets to the Docker build context or image. The Docker build only includes the Composer files, `api/`, and Docker configuration.

## Endpoints

All request and response bodies are JSON. Protected endpoints accept `Authorization: Bearer <token>`. Access tokens expire after one hour.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/signup.php` | Public | Create an account with `display_name`, `email`, and `password`; returns `token` and `user`. |
| POST | `/api/auth/login.php` | Public | Authenticate with `email` and `password`; returns `token` and `user`. |
| POST | `/api/auth/password-reset-request.php` | Public | Request a one-time password reset link; response does not disclose whether the email is registered. |
| POST | `/api/auth/password-reset-complete.php` | Public | Set a new password with the reset token and new password. |
| GET | `/api/movies.php?tier=all\|free\|vip` | Public | List movies and VJ names. Legacy image URLs remain available; private artwork keys are returned as expiring signed URLs. Storage keys are not included. |
| POST | `/api/upload/presign.php` | Admin | Without `file_size_bytes`, preserves the existing single-PUT response. With a size, selects single PUT or multipart and returns its mode and upload details. |
| POST | `/api/upload/artwork-presign.php` | Admin | Presign a private poster or backdrop PUT from `kind`, supported `content_type`, and `file_size_bytes`; object keys are generated by the API. |
| POST | `/api/upload/multipart/part.php` | Admin | Presign one `UploadPart` request using `r2_key`, `upload_id`, and `part_number`. |
| POST | `/api/upload/multipart/complete.php` | Admin | Complete multipart upload from ordered `{part_number, etag}` entries; verifies nonzero object size and configured maximum. |
| POST | `/api/upload/multipart/abort.php` | Admin | Abort an incomplete multipart upload using `r2_key` and `upload_id`. |
| POST | `/api/movies/create.php` | Admin | Register a movie after video upload with metadata, required active `vj_id`, the returned video `r2_key`, and optional validated `poster_key` / `backdrop_key`. Legacy `poster_url` / `backdrop_url` inputs remain supported. |
| GET/POST/PUT/DELETE | `/api/vjs.php` | Admin | List active VJs (or include inactive with `include_inactive=true`), add, rename, and deactivate VJs. Deactivation preserves movie credits. |

Single-PUT URLs expire after 15 minutes and retain the existing `Content-Type` header contract. Multipart part URLs also expire after 15 minutes. The browser uploads bytes directly to R2; movie bytes never pass through PHP. Both multipart completion and movie creation verify the R2 object. The bucket remains private.

### Poster, Backdrop, And VJ Management

Poster and landscape backdrop images are optional. The admin form uploads JPG, PNG, or WebP files (up to 5 MB by default) directly to the existing private R2 bucket using short-lived, admin-authorized presigned PUT URLs. The API generates separate `posters/` and `backdrops/` keys, verifies stored size and image content before movie registration, and the public catalog returns short-lived signed GET URLs. When an artwork URL expires, the frontend refreshes catalog data; it does not repeat the movie or image upload. Existing `poster_url` and `backdrop_url` values remain supported.

Set `IMAGE_MAX_UPLOAD_BYTES` on the API to change the artwork byte limit. Keep all R2 credentials backend-only. Configure the private bucket's CORS policy for the exact frontend origins with `AllowedMethods: ["PUT"]` and an allowed `Content-Type` header (or `["*"]`). Continue exposing `ETag` for the existing multipart video flow. Do not make the bucket public. An R2 lifecycle rule for old unregistered artwork objects is recommended because an administrator can abandon a form after uploading an image.

VJs are stored in PostgreSQL rather than a frontend list. Admins can add, rename, and deactivate names from the movie form. Movie records keep the VJ foreign key; deactivation hides a VJ from new uploads but does not erase historical credits. Existing movies keep a null VJ until an administrator explicitly assigns one.

## Notes

- Signup always creates a regular user; it cannot assign administrator privileges.
- Password reset links expire after one hour, are single-use, and are limited to one email per account per minute. Tokens are stored as SHA-256 hashes.
- Database credentials, JWT signing key, and R2 credentials are read from environment variables, never from request data.
- Run the PHP development server only for local development. In production, use a PHP-capable web server with HTTPS and environment variables supplied by the deployment platform.

## Video Encoding And Upload

Encoding runs on an admin workstation, not on Render or in the browser. Install FFmpeg and FFprobe first:

```sh
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS with Homebrew
brew install ffmpeg
```

Encode a source to a new MP4; the original is never overwritten:

```sh
python3 tools/video_pipeline/encode.py \
	--input movie.mkv \
	--output processed/movie.mp4 \
	--config tools/video_pipeline/profile.example.json
```

The initial profile caps dimensions at 1280x720 without upscaling, preserves aspect ratio, caps frame rate at 30 fps, and uses two-pass `libx264`, `yuv420p`, AAC at 96 kbps when audio exists, and `+faststart`. Video bitrate defaults to 610 kbps (the minimum profile is 600 kbps); edit the JSON profile or use CLI overrides to tune it. Pass logs and partial output are temporary and removed on success, failure, or interruption. Encoded files belong in ignored `processed/`, not Git.

The utility prints a JSON report containing source/output codecs, dimensions, duration, frame rate, file sizes, compression percentage, and size-budget estimates. It warns if the configured bitrate is estimated to exceed the size budget or if the minimum configured profile cannot fit. After encoding and decode validation, it checks the actual output size; an oversized result prints a report with `passed: false`, exits with status 2, and is not published to the requested output path. Encoding/validation failures use a separate status and message. It never silently lowers bitrate. The encoder profile's size budget is separate from the 1,000,000,000-byte upload maximum. Around 667 MB for two hours allows only about 741 kbps total before container overhead; the example 610 kbps video plus 96 kbps audio and 4.5% overhead is close to that encoding budget. This is aggressive for many 720p sources; review every result visually and raise the bitrate or budget when quality is inadequate. The tool reports the conflict instead of promising both outcomes.

In the admin interface, select the processed `.mp4`, enter metadata, and publish. Files above the 1,000,000,000-byte maximum are rejected before upload; the API enforces the same limit on the declared size and the actual R2 object. Files below the configured multipart threshold use the existing direct single-PUT flow. Larger files use parallel direct-to-R2 multipart parts with bounded retries; the API presigns each part, the browser reads its `ETag`, and the API completes and checks the object before the catalog registration request. Cancellation aborts the multipart session. Registration repeats the size check before inserting a movie row.

### Upload Configuration

Set these Render environment variables (safe defaults are also in `.env.example`):

| Variable | Default | Meaning |
| --- | ---: | --- |
| `VIDEO_MAX_UPLOAD_BYTES` | `1000000000` | Maximum declared and completed movie object size (1,000,000,000 bytes). |
| `IMAGE_MAX_UPLOAD_BYTES` | `5000000` | Maximum size in bytes for each poster or backdrop image. |
| `R2_MULTIPART_THRESHOLD_BYTES` | `67108864` | At or above this size, an MP4 uses multipart upload. |
| `R2_MULTIPART_PART_SIZE_BYTES` | `16777216` | Part size; minimum is 5 MiB, and the final part may be smaller. |

For local disposable PostgreSQL tests only, `DB_SSLMODE=disable` may be used if the local server does not offer TLS. Keep `require` for Supabase/production. `R2_ENDPOINT` and `R2_PATH_STYLE_ENDPOINT` are optional local S3-compatible test overrides; leave them unset for Cloudflare R2.

Keep the existing `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` variables backend-only. The R2 token needs object read/write/delete permissions for the private bucket. The API needs read permission for `HeadObject`, write permission for multipart operations, and delete permission to remove a completed object that fails size verification.

Configure the R2 bucket CORS policy for the exact deployed frontend origins. Browser part PUTs need `AllowedMethods: ["PUT"]`, `AllowedHeaders` including `content-type` (or `*`), and `ExposeHeaders: ["ETag"]`; expose `ETag` so the client can send the part list to the completion API. Set `MaxAgeSeconds` to a reasonable cache duration. Do not make the bucket public. Add an R2 lifecycle rule to abort incomplete multipart uploads after one day so browser closures or lost initiation responses do not retain billable parts indefinitely.

### Troubleshooting

- `FFmpeg executable not found`: install FFmpeg/FFprobe or set `FFMPEG` and `FFPROBE` to their executable paths.
- Output above the configured limit: the JSON report includes actual bytes, maximum bytes, and `passed: false`; the command exits with status 2 and does not publish the oversized temporary file. Review the estimate and visual quality, then adjust the profile bitrate or storage budget explicitly. The encoder does not lower quality automatically.
- Part upload fails or completion reports a missing ETag: check R2 CORS origins, `PUT`, allowed `Content-Type`, exposed `ETag`, and network access. The client retries each failed part up to three times with a fresh URL.
- A multipart upload remains incomplete after cancellation or a lost browser session: use the API abort action when the upload id is available and rely on the one-day bucket lifecycle rule as a backstop.
- R2 object verification fails: confirm the bucket name, R2 token permissions, and that multipart completion finished before submitting movie metadata.
- A movie row is not created: the admin endpoint requires a current admin JWT, a valid unique R2 key, valid metadata, and a completed non-empty object within `VIDEO_MAX_UPLOAD_BYTES`.

### Tests

Run the media/profile tests, fake-R2 API tests, frontend multipart tests, PHP syntax checks, and frontend production build with:

```sh
python3 -m unittest discover -s tools/video_pipeline -p 'test_*.py' -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
cd frontend && npm test && npm run build
cd .. && find api -name '*.php' -print0 | xargs -0 -n1 php -l
```

The successful movie-registration API test is opt-in and uses only a disposable PostgreSQL database set through `RAYN_TEST_DB_HOST`, `RAYN_TEST_DB_PORT`, `RAYN_TEST_DB_NAME`, `RAYN_TEST_DB_USER`, and `RAYN_TEST_DB_PASSWORD`; set `RAYN_TEST_DB_SSLMODE=disable` only for a local database without TLS. The test applies the existing schema only to that database. No test points at Supabase automatically.