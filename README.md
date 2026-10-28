# RAYN STREAM API

PHP 8.1+ JSON API for RAYN STREAM. PostgreSQL is hosted by Supabase; video uploads go directly from the client to a private Cloudflare R2 bucket using short-lived presigned URLs.

## Setup

1. Install PHP 8.1+ with the `pdo_pgsql` extension and Composer.
2. Install PHP dependencies with `composer install`.
3. In the Supabase SQL Editor, run [`database/schema.sql`](database/schema.sql).
4. Copy `.env.example` to `.env` and set your Supabase PostgreSQL connection details and Cloudflare R2 credentials. Use the Supabase direct or session pooler connection details, including its assigned username and port. Keep `.env` private; it is ignored by Git.
5. Generate a JWT secret with `php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'` and put the result in `JWT_SECRET`.
6. Create a private R2 bucket and an R2 API token with object read/write access scoped to that bucket.
7. Promote an account to administrator from the Supabase SQL Editor after signing up: `UPDATE users SET role = 'admin' WHERE email = lower('admin@example.com');`

For local development, export `.env` values into the PHP server process and serve the workspace root:

```sh
set -a
. ./.env
set +a
php -S 127.0.0.1:8000 -t .
```

Configure `CORS_ALLOWED_ORIGINS` as a comma-separated list of exact frontend origins. The default allows Vite at `http://localhost:5173`.

## Endpoints

All request and response bodies are JSON. Protected endpoints accept `Authorization: Bearer <token>`. Access tokens expire after one hour.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/signup.php` | Public | Create an account with `display_name`, `email`, and `password`; returns `token` and `user`. |
| POST | `/api/auth/login.php` | Public | Authenticate with `email` and `password`; returns `token` and `user`. |
| GET | `/api/movies.php?tier=all\|free\|vip` | Public | List movies. The `r2_key` is never included in list responses. |
| POST | `/api/upload/presign.php` | Admin | Create a video upload URL with `content_type` (`video/mp4`, `video/webm`, or `video/quicktime`). Returns `upload_url`, `r2_key`, and the required `Content-Type` header. |
| POST | `/api/movies/create.php` | Admin | Save metadata after the upload, with `title`, `description`, `tier`, `release_year`, `duration_minutes`, `poster_url` (optional), and the returned `r2_key`. |

The client uploads the video with a `PUT` to `upload_url`, using the returned `Content-Type` header. The URL expires after 15 minutes. Movie creation verifies that the R2 object exists before saving metadata. Keep the bucket private; these endpoints do not expose playback URLs.

## Notes

- Signup always creates a regular user; it cannot assign administrator privileges.
- Database credentials, JWT signing key, and R2 credentials are read from environment variables, never from request data.
- Run the PHP development server only for local development. In production, use a PHP-capable web server with HTTPS and environment variables supplied by the deployment platform.