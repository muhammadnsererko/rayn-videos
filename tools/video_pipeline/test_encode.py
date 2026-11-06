import json
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import encode
from encode import estimated_size_bytes, load_profile, output_dimensions

ROOT = Path(__file__).resolve().parents[2]
ENCODER = ROOT / "tools" / "video_pipeline" / "encode.py"


class ProfileTests(unittest.TestCase):
    def test_scales_large_source_without_upscaling(self):
        self.assertEqual(output_dimensions(1920, 1080, 1280, 720), (1280, 720))
        self.assertEqual(output_dimensions(640, 360, 1280, 720), (640, 360))
        self.assertEqual(output_dimensions(639, 359, 1280, 720), (638, 358))

    def test_preserves_unusual_aspect_ratio_within_bounds(self):
        width, height = output_dimensions(2000, 800, 1280, 720)
        self.assertLessEqual(width, 1280)
        self.assertLessEqual(height, 720)
        self.assertAlmostEqual(width / height, 2.5, delta=0.01)

    def test_estimates_two_hour_profile_near_storage_budget(self):
        estimate = estimated_size_bytes(7200, 610, 96, True, 4.5)
        self.assertGreater(estimate, 650_000_000)
        self.assertLess(estimate, 667_000_000)

    def test_rejects_minimum_bitrate_above_target(self):
        with self.assertRaisesRegex(ValueError, "cannot exceed"):
            load_profile(None, {
                "video_bitrate_kbps": 600,
                "minimum_video_bitrate_kbps": 610,
            })


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class FfmpegIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory(prefix="rayn-video-tests-")
        cls.workdir = Path(cls.temporary_directory.name)
        cls.profile_path = cls.workdir / "test-profile.json"
        cls.profile_path.write_text(json.dumps({"preset": "ultrafast"}), encoding="utf-8")
        cls.sources = {
            "1080p": (1920, 1080, 24, True),
            "720p": (1280, 720, 30, True),
            "below_720p_silent": (640, 360, 24, False),
            "unusual_aspect": (1000, 400, 25, True),
        }
        for name, (width, height, frame_rate, has_audio) in cls.sources.items():
            cls.make_source(name, width, height, frame_rate, has_audio)

    @classmethod
    def tearDownClass(cls):
        cls.temporary_directory.cleanup()

    @classmethod
    def make_source(cls, name, width, height, frame_rate, has_audio):
        source = cls.workdir / f"{name}.mkv"
        command = [
            "ffmpeg", "-hide_banner", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={frame_rate}",
        ]
        if has_audio:
            command.extend(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
        command.extend(["-t", "1.2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
        if has_audio:
            command.extend(["-c:a", "aac"])
        command.append(str(source))
        subprocess.run(command, check=True, capture_output=True, text=True)
        return source

    def run_encoder(self, source_name, extra_args=None):
        output, result = self.invoke_encoder(source_name, extra_args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.is_file())
        return output, json.loads(result.stdout)

    def invoke_encoder(self, source_name, extra_args=None):
        output = self.workdir / f"encoded-{source_name}-{self.id().split('.')[-1]}.mp4"
        command = [
            sys.executable, str(ENCODER),
            "--input", str(self.workdir / f"{source_name}.mkv"),
            "--output", str(output),
            "--config", str(self.profile_path),
        ]
        if extra_args:
            command.extend(extra_args)
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        return output, result

    def probe_output(self, path):
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            check=True, capture_output=True, text=True,
        )
        return json.loads(result.stdout)

    def test_1080p_is_downscaled_and_transcoded(self):
        source = self.workdir / "1080p.mkv"
        original_size = source.stat().st_size
        output, report = self.run_encoder("1080p")
        metadata = self.probe_output(output)
        video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
        audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
        self.assertLessEqual(video["width"], 1280)
        self.assertLessEqual(video["height"], 720)
        self.assertEqual(video["width"] % 2, 0)
        self.assertEqual(video["height"] % 2, 0)
        self.assertEqual(video["codec_name"], "h264")
        self.assertEqual(video["pix_fmt"], "yuv420p")
        self.assertEqual(audio["codec_name"], "aac")
        self.assertEqual(source.stat().st_size, original_size)
        self.assertTrue(report["encoding"]["source_needs_resize"])

    def test_configured_encode_uses_two_pass_bitrates_and_faststart(self):
        source = self.workdir / "720p.mkv"
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        profile_path = self.workdir / "configured-profile.json"
        profile_path.write_text(json.dumps({
            "preset": "ultrafast",
            "video_bitrate_kbps": 420,
            "minimum_video_bitrate_kbps": 400,
            "audio_bitrate_kbps": 64,
        }), encoding="utf-8")
        output = self.workdir / "configured-profile-output.mp4"
        args = encode.build_parser().parse_args([
            "--input", str(source),
            "--output", str(output),
            "--config", str(profile_path),
        ])

        with patch.object(encode, "run_ffmpeg", wraps=encode.run_ffmpeg) as run_ffmpeg:
            report = encode.process_video(args)

        commands = [call.args[0] for call in run_ffmpeg.call_args_list]
        self.assertEqual(len(commands), 2)
        pass_values = [command[command.index("-pass") + 1] for command in commands]
        self.assertEqual(pass_values, ["1", "2"])
        for command in commands:
            self.assertEqual(command[command.index("-b:v") + 1], "420k")
        self.assertEqual(commands[1][commands[1].index("-b:a") + 1], "64k")
        self.assertEqual(commands[1][commands[1].index("-c:a") + 1], "aac")
        self.assertEqual(commands[1][commands[1].index("-movflags") + 1], "+faststart")

        metadata = self.probe_output(output)
        video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
        audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
        self.assertEqual(video["width"] % 2, 0)
        self.assertEqual(video["height"] % 2, 0)
        self.assertAlmostEqual(int(audio["bit_rate"]) / 1000, 64, delta=15)
        self.assertEqual(report["encoding"]["video_bitrate_kbps"], 420)
        self.assertEqual(report["encoding"]["audio_bitrate_kbps"], 64)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), source_hash)

    def test_oversized_overwrite_decodes_first_and_preserves_existing_output(self):
        source = self.workdir / "720p.mkv"
        output = self.workdir / "existing-valid-output.mp4"
        existing_contents = b"existing valid output must remain untouched"
        output.write_bytes(existing_contents)
        args = encode.build_parser().parse_args([
            "--input", str(source),
            "--output", str(output),
            "--config", str(self.profile_path),
            "--maximum-output-size-mb", "0.00001",
            "--overwrite",
        ])
        real_subprocess_run = subprocess.run
        commands = []

        def record_subprocess_run(command, *args, **kwargs):
            commands.append(command)
            return real_subprocess_run(command, *args, **kwargs)

        with patch.object(encode.subprocess, "run", side_effect=record_subprocess_run):
            with self.assertRaises(encode.SizeBudgetExceeded):
                encode.process_video(args)

        decode_index = next(
            index for index, command in enumerate(commands)
            if command[0] == args.ffmpeg and "-f" in command and "null" in command
        )
        self.assertGreater(decode_index, 0)
        self.assertEqual(output.read_bytes(), existing_contents)
        self.assertEqual(list(output.parent.glob(f".{output.stem}.*.partial.mp4")), [])

    def test_720p_within_size_limit_is_published(self):
        output, report = self.run_encoder("720p", ["--maximum-output-size-mb", "1"])
        video = next(stream for stream in self.probe_output(output)["streams"] if stream["codec_type"] == "video")
        self.assertLessEqual(video["width"], 1280)
        self.assertLessEqual(video["height"], 720)
        self.assertEqual(report["output"]["audio_codec"], "aac")
        self.assertTrue(report["size_budget"]["passed"])
        self.assertTrue(report["size_budget"]["output_fits_budget"])
        self.assertEqual(report["size_budget"]["actual_output_bytes"], output.stat().st_size)
        self.assertEqual(report["size_budget"]["maximum_bytes"], 1_000_000)

    def test_below_720p_is_not_upscaled(self):
        output, report = self.run_encoder("below_720p_silent")
        video = next(stream for stream in self.probe_output(output)["streams"] if stream["codec_type"] == "video")
        self.assertLessEqual(video["width"], 640)
        self.assertLessEqual(video["height"], 360)
        self.assertIsNone(report["output"]["audio_codec"])

    def test_unusual_aspect_ratio_is_preserved(self):
        output, _ = self.run_encoder("unusual_aspect")
        video = next(stream for stream in self.probe_output(output)["streams"] if stream["codec_type"] == "video")
        self.assertAlmostEqual(video["width"] / video["height"], 2.5, delta=0.02)

    def test_oversized_output_is_rejected_and_cleaned_without_touching_source(self):
        source = self.workdir / "720p.mkv"
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        output, result = self.invoke_encoder("720p", ["--maximum-output-size-mb", "0.00001"])

        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("SIZE_BUDGET_EXCEEDED", result.stderr)
        report = json.loads(result.stdout)
        self.assertGreater(report["size_budget"]["actual_output_bytes"], report["size_budget"]["maximum_bytes"])
        self.assertFalse(report["size_budget"]["passed"])
        self.assertFalse(report["size_budget"]["output_fits_budget"])
        self.assertEqual(report["encoding"]["video_bitrate_kbps"], 610)
        self.assertFalse(output.exists())
        self.assertEqual(list(output.parent.glob(f".{output.stem}.*.partial.mp4")), [])
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)


if __name__ == "__main__":
    unittest.main()
