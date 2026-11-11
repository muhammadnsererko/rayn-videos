import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
PHP = shutil.which("php8.3") or shutil.which("php")
PART_SIZE = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = 1_000_000_000
TEST_SECRET = "rayn-test-secret-only-not-a-real-credential"


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def encode_segment(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def admin_token(role="admin", subject="1"):
    now = int(time.time())
    header = encode_segment(b'{"alg":"HS256","typ":"JWT"}')
    payload = encode_segment(json.dumps({
        "iss": "rayn-stream-api",
        "iat": now,
        "exp": now + 3600,
        "sub": str(subject),
        "role": role,
    }, separators=(",", ":")).encode())
    signed = f"{header}.{payload}".encode()
    signature = hmac.new(TEST_SECRET.encode(), signed, hashlib.sha256).digest()
    return f"{header}.{payload}.{encode_segment(signature)}"


class FakeR2Handler(BaseHTTPRequestHandler):
    sessions = {}
    objects = {}
    content_types = {}
    head_size_overrides = {}
    complete_response_failures = set()
    head_failures = set()

    def log_message(self, _format, *_args):
        return

    def bucket_key(self):
        segments = self.path.split("?", 1)[0].split("/", 2)
        return segments[1], unquote(segments[2]) if len(segments) > 2 else ""

    def send_body(self, status, body=b"", content_type="application/xml", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        bucket, key = self.bucket_key()
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        if "uploads" in query:
            upload_id = uuid.uuid4().hex
            self.sessions[upload_id] = {"bucket": bucket, "key": key, "parts": {}}
            body = (
                "<InitiateMultipartUploadResult>"
                f"<Bucket>{bucket}</Bucket><Key>{key}</Key><UploadId>{upload_id}</UploadId>"
                "</InitiateMultipartUploadResult>"
            ).encode()
            self.send_body(200, body)
            return

        upload_ids = query.get("uploadId", [])
        if not upload_ids:
            self.send_body(400, b"<Error><Code>InvalidRequest</Code></Error>")
            return
        upload_id = upload_ids[0]
        session = self.sessions.get(upload_id)
        if not session or session["key"] != key:
            self.send_body(404, b"<Error><Code>NoSuchUpload</Code></Error>")
            return

        length = int(self.headers.get("Content-Length", "0"))
        request_xml = ElementTree.fromstring(self.rfile.read(length))
        supplied = []
        for child in request_xml:
            name = child.tag.rsplit("}", 1)[-1]
            if name == "Part":
                values = {item.tag.rsplit("}", 1)[-1]: item.text for item in child}
                supplied.append((int(values["PartNumber"]), values["ETag"]))
        actual = []
        for part_number, etag in supplied:
            part = session["parts"].get(part_number)
            if not part or part["etag"] != etag:
                self.send_body(400, b"<Error><Code>InvalidPart</Code></Error>")
                return
            actual.append(part["data"])
        self.objects[(bucket, key)] = b"".join(actual)
        del self.sessions[upload_id]
        object_id = (bucket, key)
        if object_id in self.complete_response_failures:
            self.complete_response_failures.remove(object_id)
            self.send_body(500, b"<Error><Code>InternalError</Code></Error>")
            return
        body = (
            "<CompleteMultipartUploadResult>"
            f"<Location>http://127.0.0.1/{bucket}/{key}</Location>"
            f"<Bucket>{bucket}</Bucket><Key>{key}</Key><ETag>\"complete\"</ETag>"
            "</CompleteMultipartUploadResult>"
        ).encode()
        self.send_body(200, body)

    def do_GET(self):
        bucket, key = self.bucket_key()
        object_id = (bucket, key)
        data = self.objects.get(object_id)
        if data is None:
            self.send_body(404, b"<Error><Code>NoSuchKey</Code></Error>")
            return
        self.send_body(200, data, self.content_types.get(object_id, "application/octet-stream"))

    def do_PUT(self):
        bucket, key = self.bucket_key()
        query = parse_qs(urlparse(self.path).query)
        upload_id = query.get("uploadId", [""])[0]
        length = int(self.headers.get("Content-Length", "0"))
        if not upload_id:
            data = self.rfile.read(length)
            self.objects[(bucket, key)] = data
            self.content_types[(bucket, key)] = self.headers.get("Content-Type", "")
            etag = '"' + hashlib.md5(data).hexdigest() + '"'
            self.send_body(200, headers={"ETag": etag})
            return

        part_number = int(query.get("partNumber", ["0"])[0])
        session = self.sessions.get(upload_id)
        if not session or session["key"] != key or part_number < 1:
            self.send_body(404, b"<Error><Code>NoSuchUpload</Code></Error>")
            return
        data = self.rfile.read(length)
        etag = '"' + hashlib.md5(data).hexdigest() + '"'
        session["parts"][part_number] = {"data": data, "etag": etag}
        self.send_body(200, headers={"ETag": etag})

    def do_HEAD(self):
        bucket, key = self.bucket_key()
        object_id = (bucket, key)
        if object_id in self.head_failures:
            self.send_body(503, b"<Error><Code>ServiceUnavailable</Code></Error>")
            return
        data = self.objects.get((bucket, key))
        if data is None:
            self.send_body(404, b"")
            return
        content_length = self.head_size_overrides.get((bucket, key), len(data))
        self.send_response(200)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Content-Type", self.content_types.get(object_id, "video/mp4"))
        self.send_header("ETag", '"complete"')
        self.end_headers()

    def do_DELETE(self):
        bucket, key = self.bucket_key()
        query = parse_qs(urlparse(self.path).query)
        upload_id = query.get("uploadId", [""])[0]
        if upload_id:
            self.sessions.pop(upload_id, None)
        else:
            self.objects.pop((bucket, key), None)
            self.content_types.pop((bucket, key), None)
            self.head_size_overrides.pop((bucket, key), None)
        self.send_body(204, b"")


@unittest.skipUnless(PHP, "PHP CLI is required")
class MultipartApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake_r2 = ThreadingHTTPServer(("127.0.0.1", 0), FakeR2Handler)
        cls.fake_r2_port = cls.fake_r2.server_address[1]
        cls.fake_r2_thread = threading.Thread(target=cls.fake_r2.serve_forever, daemon=True)
        cls.fake_r2_thread.start()
        FakeR2Handler.sessions = {}
        FakeR2Handler.objects = {}
        FakeR2Handler.content_types = {}
        FakeR2Handler.head_size_overrides = {}
        FakeR2Handler.complete_response_failures = set()
        FakeR2Handler.head_failures = set()

        cls.api_port = unused_port()
        environment = os.environ.copy()
        environment.update({
            "JWT_SECRET": TEST_SECRET,
            "JWT_ISSUER": "rayn-stream-api",
            "R2_ACCOUNT_ID": "test-account",
            "R2_ACCESS_KEY_ID": "test-access",
            "R2_SECRET_ACCESS_KEY": "test-secret",
            "R2_BUCKET": "rayn-test",
            "R2_ENDPOINT": f"http://127.0.0.1:{cls.fake_r2_port}",
            "R2_PATH_STYLE_ENDPOINT": "true",
            "R2_MULTIPART_THRESHOLD_BYTES": str(PART_SIZE),
            "R2_MULTIPART_PART_SIZE_BYTES": str(PART_SIZE),
            "VIDEO_MAX_UPLOAD_BYTES": str(MAX_UPLOAD_BYTES),
        })
        test_database = {
            "DB_HOST": os.environ.get("RAYN_TEST_DB_HOST"),
            "DB_PORT": os.environ.get("RAYN_TEST_DB_PORT", "5432"),
            "DB_NAME": os.environ.get("RAYN_TEST_DB_NAME"),
            "DB_USER": os.environ.get("RAYN_TEST_DB_USER"),
            "DB_PASSWORD": os.environ.get("RAYN_TEST_DB_PASSWORD"),
        }
        cls.database_enabled = all(test_database.values())
        if cls.database_enabled:
            environment.update(test_database, DB_SSLMODE=os.environ.get("RAYN_TEST_DB_SSLMODE", "require"))
            database_setup = subprocess.run([
                PHP, "-r",
                'require "api/config.php"; $db = database(); $db->exec(file_get_contents("database/schema.sql")); '
                '$db->exec(file_get_contents("database/add-movie-artwork-and-vjs.sql")); '
                '$db->exec("INSERT INTO users (display_name, email, password_hash, role) VALUES '
                '(\'Rayn Test User\', \'rayn-user@example.invalid\', \'test-only\', \'user\'), '
                '(\'Rayn Test VIP\', \'rayn-vip@example.invalid\', \'test-only\', \'vip\') '
                ', (\'Rayn Test Admin\', \'rayn-admin@example.invalid\', \'test-only\', \'admin\') '
                'ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role"); '
                '$ids = []; foreach ([\'rayn-user@example.invalid\', \'rayn-vip@example.invalid\', \'rayn-admin@example.invalid\'] as $email) '
                '{$query = $db->prepare("SELECT id FROM users WHERE email = ?"); $query->execute([$email]); $ids[] = (int) $query->fetchColumn();} '
                '$db->exec("INSERT INTO vjs (name) VALUES (\'Rayn Test VJ\') ON CONFLICT DO NOTHING"); '
                '$vjId = (int) $db->query("SELECT id FROM vjs WHERE LOWER(name) = LOWER(\'Rayn Test VJ\')")->fetchColumn(); '
                'echo json_encode([\'users\' => $ids, \'vj\' => $vjId]);',
            ], cwd=ROOT, env=environment, check=True, capture_output=True, text=True, timeout=30)
            database_ids = json.loads(database_setup.stdout)
            cls.test_user_ids = database_ids["users"]
            cls.test_vj_id = database_ids["vj"]
        cls.php_server = subprocess.Popen(
            [PHP, "-S", f"127.0.0.1:{cls.api_port}", "-t", str(ROOT)],
            cwd=ROOT, env=environment, stdout=subprocess.DEVNULL,
        )
        cls.api_url = f"http://127.0.0.1:{cls.api_port}/api"
        cls.token = admin_token()
        for _ in range(100):
            if cls.php_server.poll() is not None:
                raise RuntimeError("PHP integration server exited before tests started.")
            try:
                cls.call_api("/upload/multipart/abort.php", {"r2_key": "invalid", "upload_id": "invalid"})
            except HTTPError as error:
                if error.code == 422:
                    error.close()
                    break
                error.close()
            except OSError:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("PHP integration server did not start.")

    @classmethod
    def tearDownClass(cls):
        cls.php_server.terminate()
        try:
            cls.php_server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.php_server.kill()
            cls.php_server.wait()
        cls.fake_r2.shutdown()
        cls.fake_r2.server_close()

    @classmethod
    def call_api(cls, path, payload, token=None):
        request = Request(
            cls.api_url + path,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {token or cls.token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())

    @classmethod
    def call_method_api(cls, path, method, payload, token=None):
        request = Request(
            cls.api_url + path,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {token or cls.token}", "Content-Type": "application/json"},
            method=method,
        )
        with urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())

    @classmethod
    def get_api(cls, path, token=None):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(cls.api_url + path, headers=headers, method="GET")
        with urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())

    def assert_api_error(self, path, payload, expected_status, token=None):
        with self.assertRaises(HTTPError) as raised:
            self.call_api(path, payload, token=token)
        self.assertEqual(raised.exception.code, expected_status)
        raised.exception.read()
        raised.exception.close()
        return raised.exception

    def assert_get_api_error(self, path, expected_status, token=None):
        with self.assertRaises(HTTPError) as raised:
            self.get_api(path, token)
        self.assertEqual(raised.exception.code, expected_status)
        raised.exception.read()
        raised.exception.close()
        return raised.exception

    def test_multipart_upload_complete_and_object_head_verification(self):
        file_size = PART_SIZE + 17
        status, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": file_size,
        })
        self.assertEqual(status, 201)
        self.assertEqual(upload["mode"], "multipart")
        self.assertEqual(upload["part_size_bytes"], PART_SIZE)

        complete_parts = []
        for part_number, body in ((1, b"a" * PART_SIZE), (2, b"b" * 17)):
            _, signed = self.call_api("/upload/multipart/part.php", {
                "r2_key": upload["r2_key"],
                "upload_id": upload["upload_id"],
                "part_number": part_number,
            })
            request = Request(
                signed["upload_url"], data=body,
                headers={"Content-Type": "application/octet-stream"}, method="PUT",
            )
            with urlopen(request, timeout=15) as response:
                etag = response.headers["ETag"]
            complete_parts.append({"part_number": part_number, "etag": etag})

        status, completed = self.call_api("/upload/multipart/complete.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": complete_parts,
            "expected_size_bytes": file_size,
        })
        self.assertEqual(status, 200)
        self.assertEqual(completed["size_bytes"], file_size)
        self.assertTrue(completed["completed"])

    def test_completion_retry_succeeds_when_r2_lost_the_completed_response(self):
        body = b"c" * (PART_SIZE + 17)
        file_size = len(body)
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": file_size,
        })
        _, signed = self.call_api("/upload/multipart/part.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "part_number": 1,
        })
        request = Request(
            signed["upload_url"], data=body,
            headers={"Content-Type": "application/octet-stream"}, method="PUT",
        )
        with urlopen(request, timeout=15) as response:
            parts = [{"part_number": 1, "etag": response.headers["ETag"]}]

        object_id = ("rayn-test", upload["r2_key"])
        FakeR2Handler.complete_response_failures.add(object_id)
        complete_request = {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": parts,
            "expected_size_bytes": len(body),
        }
        status, completed = self.call_api("/upload/multipart/complete.php", complete_request)
        self.assertEqual(status, 200)
        self.assertEqual(completed["size_bytes"], len(body))
        self.assertIn(object_id, FakeR2Handler.objects)

        status, completed = self.call_api("/upload/multipart/complete.php", complete_request)
        self.assertEqual(status, 200)
        self.assertEqual(completed["size_bytes"], len(body))
        self.assertTrue(completed["completed"])

    def test_head_failure_after_completion_does_not_delete_object(self):
        body = b"h" * (PART_SIZE + 17)
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(body),
        })
        _, signed = self.call_api("/upload/multipart/part.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "part_number": 1,
        })
        request = Request(
            signed["upload_url"], data=body,
            headers={"Content-Type": "application/octet-stream"}, method="PUT",
        )
        with urlopen(request, timeout=15) as response:
            parts = [{"part_number": 1, "etag": response.headers["ETag"]}]

        object_id = ("rayn-test", upload["r2_key"])
        FakeR2Handler.head_failures.add(object_id)
        complete_request = {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": parts,
            "expected_size_bytes": len(body),
        }
        self.assert_api_error("/upload/multipart/complete.php", complete_request, 502)
        self.assertIn(object_id, FakeR2Handler.objects)

        FakeR2Handler.head_failures.remove(object_id)
        status, completed = self.call_api("/upload/multipart/complete.php", complete_request)
        self.assertEqual(status, 200)
        self.assertEqual(completed["size_bytes"], len(body))

    def test_completion_deletes_object_with_mismatched_actual_size(self):
        body = b"actual size differs"
        expected_size = PART_SIZE + 1
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": expected_size,
        })
        _, signed = self.call_api("/upload/multipart/part.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "part_number": 1,
        })
        request = Request(
            signed["upload_url"], data=body,
            headers={"Content-Type": "application/octet-stream"}, method="PUT",
        )
        with urlopen(request, timeout=15) as response:
            parts = [{"part_number": 1, "etag": response.headers["ETag"]}]

        object_id = ("rayn-test", upload["r2_key"])
        self.assert_api_error("/upload/multipart/complete.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": parts,
            "expected_size_bytes": expected_size,
        }, 400)
        self.assertNotIn(object_id, FakeR2Handler.objects)

    def test_completion_rejects_missing_or_invalid_expected_size_before_r2(self):
        payload = {
            "r2_key": "uploads/" + "a" * 32 + ".mp4",
            "upload_id": "unavailable-upload-id",
            "parts": [{"part_number": 1, "etag": '"valid-etag"'}],
        }
        self.assert_api_error("/upload/multipart/complete.php", payload, 422)
        for expected_size in (None, "", "not-a-size", True, 1.5, 0, -1):
            with self.subTest(expected_size=expected_size):
                self.assert_api_error("/upload/multipart/complete.php", {
                    **payload, "expected_size_bytes": expected_size,
                }, 422)
        self.assert_api_error("/upload/multipart/complete.php", {
            **payload, "expected_size_bytes": MAX_UPLOAD_BYTES + 1,
        }, 413)

    def test_unrelated_completion_error_is_not_treated_as_success(self):
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": PART_SIZE + 1,
        })
        _, signed = self.call_api("/upload/multipart/part.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "part_number": 1,
        })
        request = Request(
            signed["upload_url"], data=b"part",
            headers={"Content-Type": "application/octet-stream"}, method="PUT",
        )
        with urlopen(request, timeout=15) as response:
            etag = response.headers["ETag"]
        upload_object = ("rayn-test", upload["r2_key"])
        FakeR2Handler.objects[upload_object] = b"already-present"

        self.assert_api_error("/upload/multipart/complete.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": [{"part_number": 1, "etag": '"invalid-etag"'}],
            "expected_size_bytes": len(b"already-present"),
        }, 502)
        self.assertEqual(FakeR2Handler.objects[upload_object], b"already-present")

    def test_declared_small_single_put_presign_path_remains_usable(self):
        payload = b"small-mp4-test"
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        self.assertEqual(upload["mode"], "single")
        self.assertIn("upload_url", upload)
        self.assertIn("r2_key", upload)
        self.assertIn("Content-Type", upload["required_headers"])
        request = Request(
            upload["upload_url"], data=payload,
            headers=upload["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15) as response:
            self.assertEqual(response.status, 200)
        self.assertIn(("rayn-test", upload["r2_key"]), FakeR2Handler.objects)

    def test_abort_removes_incomplete_multipart_session(self):
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": PART_SIZE + 1,
        })
        self.assertIn(upload["upload_id"], FakeR2Handler.sessions)
        _, signed = self.call_api("/upload/multipart/part.php", {
            "r2_key": upload["r2_key"], "upload_id": upload["upload_id"], "part_number": 1,
        })
        request = Request(
            signed["upload_url"], data=b"interrupted-part",
            headers={"Content-Type": "application/octet-stream"}, method="PUT",
        )
        with urlopen(request, timeout=15):
            pass
        status, response = self.call_api("/upload/multipart/abort.php", {
            "r2_key": upload["r2_key"], "upload_id": upload["upload_id"],
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["aborted"])
        self.assertNotIn(upload["upload_id"], FakeR2Handler.sessions)

    def test_user_role_cannot_initialize_multipart_upload(self):
        self.assert_api_error("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": PART_SIZE + 1,
        }, 403, token=admin_token("user"))

    def test_artwork_presign_validates_admin_kind_type_and_size(self):
        self.assert_api_error("/upload/artwork-presign.php", {
            "kind": "poster", "content_type": "image/png", "file_size_bytes": 1,
        }, 403, token=admin_token("user"))
        self.assert_get_api_error("/vjs.php", 401)
        self.assert_api_error("/vjs.php", {"name": "Unauthorized VJ"}, 403, token=admin_token("user"))

        for payload in (
            {"kind": "unknown", "content_type": "image/png", "file_size_bytes": 1},
            {"kind": "poster", "content_type": "image/gif", "file_size_bytes": 1},
            {"kind": "poster", "content_type": "image/png", "file_size_bytes": 0},
            {"kind": "poster", "content_type": "image/png", "file_size_bytes": "10"},
        ):
            with self.subTest(payload=payload):
                self.assert_api_error("/upload/artwork-presign.php", payload, 422)

        self.assert_api_error("/movies/create.php", {
            "title": "Invalid artwork key test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": 1,
            "file_size_bytes": 1,
            "poster_key": "../uploads/not-generated.png",
            "r2_key": "uploads/" + "a" * 32 + ".mp4",
        }, 422)
        self.assert_api_error("/upload/artwork-presign.php", {
            "kind": "poster", "content_type": "image/png", "file_size_bytes": 5_000_001,
        }, 413)

        for kind, prefix in (("poster", "posters/"), ("backdrop", "backdrops/")):
            status, upload = self.call_api("/upload/artwork-presign.php", {
                "kind": kind, "content_type": "image/png", "file_size_bytes": 1,
            })
            self.assertEqual(status, 201)
            self.assertTrue(upload["artwork_key"].startswith(prefix))
            self.assertIn("Content-Type", upload["required_headers"])

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_vj_management_keeps_deactivated_history_and_prevents_duplicates(self):
        run_id = uuid.uuid4().hex[:8]
        original_name = f"Test VJ Lifecycle {run_id}"
        renamed_name = f"Renamed Test VJ {run_id}"
        status, created = self.call_method_api("/vjs.php", "POST", {"name": original_name})
        self.assertEqual(status, 201)
        vj_id = created["vj"]["id"]

        payload = b"vj-history-test-movie"
        _, video = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(video["upload_url"], data=payload, headers=video["required_headers"], method="PUT")
        with urlopen(request, timeout=15):
            pass
        _, movie = self.call_api("/movies/create.php", {
            "title": f"VJ historical credit test {run_id}",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": vj_id,
            "file_size_bytes": len(payload),
            "r2_key": video["r2_key"],
        })

        self.assert_api_error("/vjs.php", {"name": f" {original_name.lower()} "}, 409)
        status, renamed = self.call_method_api("/vjs.php", "PUT", {
            "id": vj_id, "name": renamed_name,
        })
        self.assertEqual(status, 200)
        self.assertEqual(renamed["vj"]["name"], renamed_name)

        status, deactivated = self.call_method_api("/vjs.php", "DELETE", {"id": vj_id})
        self.assertEqual(status, 200)
        self.assertFalse(deactivated["vj"]["is_active"])
        _, active_list = self.get_api("/vjs.php", token=self.token)
        self.assertNotIn(vj_id, [vj["id"] for vj in active_list["vjs"]])
        _, full_list = self.get_api("/vjs.php?include_inactive=true", token=self.token)
        self.assertIn(vj_id, [vj["id"] for vj in full_list["vjs"]])
        _, catalog = self.get_api("/movies.php", token=self.token)
        historical_movie = next(item for item in catalog["movies"] if item["id"] == movie["movie"]["id"])
        self.assertEqual(historical_movie["vj_name"], renamed_name)

    def upload_artwork(self, kind, payload, content_type="image/png"):
        _, upload = self.call_api("/upload/artwork-presign.php", {
            "kind": kind,
            "content_type": content_type,
            "file_size_bytes": len(payload),
        })
        request = Request(
            upload["upload_url"], data=payload,
            headers=upload["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15):
            pass
        return upload["artwork_key"]

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_movie_registration_verifies_private_artwork_and_catalog_signs_it(self):
        payload = b"private-test-movie"
        _, video = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(
            video["upload_url"], data=payload,
            headers=video["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15):
            pass

        image_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        )
        poster_key = self.upload_artwork("poster", image_bytes)
        backdrop_key = self.upload_artwork("backdrop", image_bytes)
        status, created = self.call_api("/movies/create.php", {
            "title": "Artwork and VJ integration test",
            "description": "Disposable test record.",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "poster_key": poster_key,
            "backdrop_key": backdrop_key,
            "file_size_bytes": len(payload),
            "r2_key": video["r2_key"],
        })
        self.assertEqual(status, 201)
        self.assertEqual(created["movie"]["vj_name"], "Rayn Test VJ")
        self.assertTrue(created["movie"]["poster_signed"])
        self.assertTrue(created["movie"]["backdrop_signed"])
        self.assertTrue(created["movie"]["poster_url"].startswith("http://127.0.0.1:"))
        self.assertNotIn("poster_key", created["movie"])
        self.assertNotIn("backdrop_key", created["movie"])

        _, catalog = self.get_api("/movies.php", token=self.token)
        registered = next(movie for movie in catalog["movies"] if movie["id"] == created["movie"]["id"])
        self.assertEqual(registered["vj_name"], "Rayn Test VJ")
        self.assertTrue(registered["poster_signed"])
        self.assertTrue(registered["backdrop_signed"])
        self.assertNotIn("poster_key", registered)
        self.assertNotIn("backdrop_key", registered)

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_movie_registration_rejects_invalid_image_bytes_and_cleans_object(self):
        video_payload = b"private-test-movie"
        _, video = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(video_payload),
        })
        video_request = Request(
            video["upload_url"], data=video_payload,
            headers=video["required_headers"], method="PUT",
        )
        with urlopen(video_request, timeout=15):
            pass
        invalid_key = self.upload_artwork("poster", b"not an image")

        self.assert_api_error("/movies/create.php", {
            "title": "Invalid artwork test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "poster_key": invalid_key,
            "file_size_bytes": len(video_payload),
            "r2_key": video["r2_key"],
        }, 400)
        self.assertNotIn(("rayn-test", invalid_key), FakeR2Handler.objects)

        valid_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        )
        oversized_key = self.upload_artwork("poster", valid_png)
        oversized_object = ("rayn-test", oversized_key)
        FakeR2Handler.head_size_overrides[oversized_object] = 5_000_001
        self.assert_api_error("/movies/create.php", {
            "title": "Oversized artwork test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "poster_key": oversized_key,
            "file_size_bytes": len(video_payload),
            "r2_key": video["r2_key"],
        }, 413)
        self.assertNotIn(oversized_object, FakeR2Handler.objects)
        self.assertNotIn(oversized_object, FakeR2Handler.head_size_overrides)

        missing_key = f"posters/{uuid.uuid4().hex}.png"
        self.assert_api_error("/movies/create.php", {
            "title": "Missing artwork object test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "poster_key": missing_key,
            "file_size_bytes": len(video_payload),
            "r2_key": video["r2_key"],
        }, 400)

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_movie_registration_rejects_invalid_vj_and_preserves_legacy_artwork_urls(self):
        payload = b"legacy-url-test-movie"
        _, video = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(video["upload_url"], data=payload, headers=video["required_headers"], method="PUT")
        with urlopen(request, timeout=15):
            pass

        base_payload = {
            "title": "Legacy artwork URL test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "file_size_bytes": len(payload),
            "r2_key": video["r2_key"],
        }
        self.assert_api_error("/movies/create.php", {
            **base_payload, "vj_id": 999_999,
        }, 422)

        status, created = self.call_api("/movies/create.php", {
            **base_payload,
            "vj_id": self.test_vj_id,
            "poster_url": "https://images.example.invalid/legacy-poster.jpg",
            "backdrop_url": "https://images.example.invalid/legacy-backdrop.jpg",
        })
        self.assertEqual(status, 201)
        _, catalog = self.get_api("/movies.php", token=self.token)
        movie = next(item for item in catalog["movies"] if item["id"] == created["movie"]["id"])
        self.assertEqual(movie["poster_url"], "https://images.example.invalid/legacy-poster.jpg")
        self.assertEqual(movie["backdrop_url"], "https://images.example.invalid/legacy-backdrop.jpg")
        self.assertEqual(movie["vj_name"], "Rayn Test VJ")

    def test_create_rejects_missing_r2_object_before_database_registration(self):
        self.assert_api_error("/movies/create.php", {
            "title": "Missing object test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": 1,
            "file_size_bytes": 1,
            "r2_key": "uploads/" + "a" * 32 + ".mp4",
        }, 400)

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_completed_upload_is_registered_in_movie_catalog(self):
        payload = b"processed-mp4-test"
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(
            upload["upload_url"], data=payload,
            headers=upload["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15):
            pass

        status, response = self.call_api("/movies/create.php", {
            "title": "Multipart integration test",
            "description": "Disposable integration test record.",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "file_size_bytes": len(payload),
            "r2_key": upload["r2_key"],
        })
        self.assertEqual(status, 201)
        self.assertEqual(response["movie"]["title"], "Multipart integration test")
        self.assertNotIn("r2_key", response["movie"])
        playback_status, playback = self.get_api(
            f"/movies/play.php?id={response['movie']['id']}", admin_token("user", self.test_user_ids[0])
        )
        self.assertEqual(playback_status, 200)
        self.assertTrue(playback["url"].startswith("http://127.0.0.1:"))

    @unittest.skipUnless(os.environ.get("RAYN_TEST_DB_HOST"), "Set RAYN_TEST_DB_* to use a disposable PostgreSQL test database")
    def test_playback_retains_free_and_vip_role_authorization(self):
        payload = b"private-test-movie"
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(
            upload["upload_url"], data=payload,
            headers=upload["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15):
            pass
        _, created = self.call_api("/movies/create.php", {
            "title": "VIP playback integration test",
            "description": "Disposable VIP access test.",
            "tier": "vip",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": self.test_vj_id,
            "file_size_bytes": len(payload),
            "r2_key": upload["r2_key"],
        })
        movie_id = created["movie"]["id"]
        path = f"/movies/play.php?id={movie_id}"

        self.assert_get_api_error(path, 401)
        for token, expected_status in (
            (admin_token("user", self.test_user_ids[0]), 403),
            (admin_token("vip", self.test_user_ids[1]), 200),
            (admin_token("admin", self.test_user_ids[2]), 200),
        ):
            if expected_status == 200:
                status, playback = self.get_api(path, token)
                self.assertEqual(status, 200)
                self.assertTrue(playback["url"].startswith("http://127.0.0.1:"))
            else:
                self.assert_get_api_error(path, expected_status, token)

    def test_presign_accepts_889mb_and_950mb_and_rejects_over_1gb(self):
        for file_size in (889_000_000, 950_000_000):
            with self.subTest(file_size=file_size):
                status, upload = self.call_api("/upload/presign.php", {
                    "content_type": "video/mp4", "file_size_bytes": file_size,
                })
                self.assertEqual(status, 201)
                self.assertEqual(upload["mode"], "multipart")
                self.assertEqual(upload["part_size_bytes"], PART_SIZE)
                _, signed = self.call_api("/upload/multipart/part.php", {
                    "r2_key": upload["r2_key"],
                    "upload_id": upload["upload_id"],
                    "part_number": 1,
                })
                request = Request(
                    signed["upload_url"], data=b"test-part",
                    headers={"Content-Type": "application/octet-stream"}, method="PUT",
                )
                with urlopen(request, timeout=15) as response:
                    parts = [{"part_number": 1, "etag": response.headers["ETag"]}]
                object_id = ("rayn-test", upload["r2_key"])
                FakeR2Handler.head_size_overrides[object_id] = file_size
                status, completed = self.call_api("/upload/multipart/complete.php", {
                    "r2_key": upload["r2_key"],
                    "upload_id": upload["upload_id"],
                    "parts": parts,
                    "expected_size_bytes": file_size,
                })
                self.assertEqual(status, 200)
                self.assertEqual(completed["size_bytes"], file_size)
                FakeR2Handler.objects.pop(object_id, None)
                FakeR2Handler.head_size_overrides.pop(object_id, None)
                _, aborted = self.call_api("/upload/multipart/abort.php", {
                    "r2_key": upload["r2_key"], "upload_id": upload["upload_id"],
                })
                self.assertTrue(aborted["aborted"])

        self.assert_api_error("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": MAX_UPLOAD_BYTES + 1,
        }, 413)

    def test_presign_rejects_missing_or_invalid_declared_file_size(self):
        self.assert_api_error("/upload/presign.php", {"content_type": "video/mp4"}, 422)
        for file_size in (None, "", "not-a-size", "12", True, 1.5, 0, -1):
            with self.subTest(file_size=file_size):
                self.assert_api_error("/upload/presign.php", {
                    "content_type": "video/mp4", "file_size_bytes": file_size,
                }, 422)

    def test_completed_object_over_maximum_is_deleted(self):
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": PART_SIZE + 17,
        })
        parts = []
        for part_number, body in ((1, b"a" * PART_SIZE), (2, b"b" * 17)):
            _, signed = self.call_api("/upload/multipart/part.php", {
                "r2_key": upload["r2_key"], "upload_id": upload["upload_id"],
                "part_number": part_number,
            })
            request = Request(
                signed["upload_url"], data=body,
                headers={"Content-Type": "application/octet-stream"}, method="PUT",
            )
            with urlopen(request, timeout=15) as response:
                parts.append({"part_number": part_number, "etag": response.headers["ETag"]})

        FakeR2Handler.head_size_overrides[("rayn-test", upload["r2_key"])] = MAX_UPLOAD_BYTES + 1
        self.assert_api_error("/upload/multipart/complete.php", {
            "r2_key": upload["r2_key"],
            "upload_id": upload["upload_id"],
            "parts": parts,
            "expected_size_bytes": PART_SIZE + 17,
        }, 413)
        self.assertNotIn(("rayn-test", upload["r2_key"]), FakeR2Handler.objects)

    def test_registration_rejects_and_deletes_actual_object_over_maximum(self):
        payload = b"small payload despite oversized actual object metadata"
        _, upload = self.call_api("/upload/presign.php", {
            "content_type": "video/mp4", "file_size_bytes": len(payload),
        })
        request = Request(
            upload["upload_url"], data=payload,
            headers=upload["required_headers"], method="PUT",
        )
        with urlopen(request, timeout=15):
            pass
        object_id = ("rayn-test", upload["r2_key"])
        FakeR2Handler.head_size_overrides[object_id] = MAX_UPLOAD_BYTES + 1

        self.assert_api_error("/movies/create.php", {
            "title": "Oversized actual object test",
            "description": "",
            "tier": "free",
            "release_year": 2026,
            "duration_minutes": 1,
            "vj_id": 1,
            "file_size_bytes": len(payload),
            "r2_key": upload["r2_key"],
        }, 413)
        self.assertNotIn(object_id, FakeR2Handler.objects)
        self.assertNotIn(object_id, FakeR2Handler.head_size_overrides)


if __name__ == "__main__":
    unittest.main()
