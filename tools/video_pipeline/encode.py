#!/usr/bin/env python3
"""Encode a source video to Rayn's two-pass H.264/AAC MP4 profile."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

DEFAULT_PROFILE: dict[str, Any] = {
    "target_width": 1280,
    "target_height": 720,
    "video_bitrate_kbps": 610,
    "minimum_video_bitrate_kbps": 600,
    "audio_bitrate_kbps": 96,
    "maximum_frame_rate": 30,
    "maximum_output_size_mb": 667,
    "overhead_allowance_percent": 4.5,
    "preset": "medium",
}


def parse_frame_rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "N/A"}:
        return None
    try:
        rate = float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None
    return rate if math.isfinite(rate) and rate > 0 else None


def parse_bitrate_kbps(value: Any) -> float | None:
    try:
        bitrate = float(value) / 1000
    except (TypeError, ValueError):
        return None
    return bitrate if math.isfinite(bitrate) and bitrate > 0 else None


def output_dimensions(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    scale = min(1.0, max_width / width, max_height / height)
    out_width = max(2, int(width * scale) // 2 * 2)
    out_height = max(2, int(height * scale) // 2 * 2)
    return min(out_width, max_width), min(out_height, max_height)


def estimated_size_bytes(
    duration_seconds: float,
    video_bitrate_kbps: float,
    audio_bitrate_kbps: float,
    has_audio: bool,
    overhead_allowance_percent: float,
) -> int:
    total_kbps = video_bitrate_kbps + (audio_bitrate_kbps if has_audio else 0)
    return math.ceil(duration_seconds * total_kbps * 1000 / 8 * (1 + overhead_allowance_percent / 100))


def load_profile(path: Path | None, overrides: dict[str, Any]) -> dict[str, Any]:
    profile = DEFAULT_PROFILE.copy()
    if path:
        try:
            configured = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Could not read profile {path}: {error}") from error
        if not isinstance(configured, dict):
            raise ValueError("Profile JSON must be an object.")
        unknown = set(configured) - set(DEFAULT_PROFILE)
        if unknown:
            raise ValueError(f"Unknown profile option(s): {', '.join(sorted(unknown))}")
        profile.update(configured)
    profile.update({key: value for key, value in overrides.items() if value is not None})

    integer_keys = (
        "target_width", "target_height", "video_bitrate_kbps",
        "minimum_video_bitrate_kbps", "audio_bitrate_kbps", "maximum_frame_rate",
    )
    for key in integer_keys:
        if not isinstance(profile[key], int) or profile[key] <= 0:
            raise ValueError(f"{key} must be a positive integer.")
    for key in ("maximum_output_size_mb", "overhead_allowance_percent"):
        if not isinstance(profile[key], (int, float)) or profile[key] <= 0:
            raise ValueError(f"{key} must be a positive number.")
    if profile["minimum_video_bitrate_kbps"] > profile["video_bitrate_kbps"]:
        raise ValueError("minimum_video_bitrate_kbps cannot exceed video_bitrate_kbps.")
    if not isinstance(profile["preset"], str) or not profile["preset"].strip():
        raise ValueError("preset must be a non-empty FFmpeg libx264 preset.")
    return profile


@dataclass(frozen=True)
class MediaInfo:
    path: str
    size_bytes: int
    duration_seconds: float
    width: int
    height: int
    video_codec: str
    pixel_format: str | None
    frame_rate: float | None
    audio_codec: str | None
    container: str
    video_stream_count: int
    audio_stream_count: int
    video_bitrate_kbps: float | None
    audio_bitrate_kbps: float | None


class SizeBudgetExceeded(RuntimeError):
    def __init__(self, report: dict[str, Any]):
        self.report = report
        actual = report["size_budget"]["actual_output_bytes"]
        maximum = report["size_budget"]["maximum_bytes"]
        super().__init__(f"Output size budget exceeded: {actual} bytes produced; maximum is {maximum} bytes.")


def probe_media(path: Path, ffprobe: str) -> MediaInfo:
    if not path.is_file():
        raise ValueError(f"Input file does not exist: {path}")

    command = [
        ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"FFprobe failed for {path}: {result.stderr.strip()}")
    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("FFprobe returned invalid JSON.") from error

    streams = metadata.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    video = video_streams[0] if video_streams else None
    if not video:
        raise ValueError("Input has no video stream.")
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    audio = audio_streams[0] if audio_streams else None
    duration = metadata.get("format", {}).get("duration") or video.get("duration")
    try:
        duration_seconds = float(duration)
    except (TypeError, ValueError) as error:
        raise ValueError("Could not determine input duration.") from error
    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ValueError("Could not determine input video dimensions.")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("Input duration must be greater than zero.")

    return MediaInfo(
        path=str(path),
        size_bytes=path.stat().st_size,
        duration_seconds=duration_seconds,
        width=width,
        height=height,
        video_codec=str(video.get("codec_name", "unknown")),
        pixel_format=video.get("pix_fmt"),
        frame_rate=parse_frame_rate(video.get("avg_frame_rate") or video.get("r_frame_rate")),
        audio_codec=str(audio.get("codec_name")) if audio else None,
        container=str(metadata.get("format", {}).get("format_name", "unknown")),
        video_stream_count=len(video_streams),
        audio_stream_count=len(audio_streams),
        video_bitrate_kbps=parse_bitrate_kbps(video.get("bit_rate")),
        audio_bitrate_kbps=parse_bitrate_kbps(audio.get("bit_rate")) if audio else None,
    )


def tail_file(path: Path, lines: int = 20) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def run_ffmpeg(command: list[str], log_path: Path, duration: float, label: str) -> None:
    with log_path.open("w", encoding="utf-8") as error_log:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=error_log, text=True, bufsize=1
        )
        last_percent = -5
        try:
            assert process.stdout is not None
            for line in process.stdout:
                key, separator, value = line.strip().partition("=")
                if not separator or key != "out_time_ms":
                    continue
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    continue
                percent = min(100, int(seconds / duration * 100))
                if percent >= last_percent + 5:
                    print(f"{label}: {percent}%", file=sys.stderr)
                    last_percent = percent
            return_code = process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise

    if return_code:
        details = tail_file(log_path)
        raise RuntimeError(f"FFmpeg {label} failed (exit {return_code}).\n{details}")


def validate_output(
    source: MediaInfo,
    output: MediaInfo,
    profile: dict[str, Any],
    output_streams: list[dict[str, Any]],
) -> None:
    video_streams = [stream for stream in output_streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in output_streams if stream.get("codec_type") == "audio"]
    if len(video_streams) != 1:
        raise RuntimeError("Output must contain exactly one video stream.")
    if output.video_codec != "h264" or output.pixel_format != "yuv420p":
        raise RuntimeError("Output video must be H.264 with yuv420p pixel format.")
    if output.width > profile["target_width"] or output.height > profile["target_height"]:
        raise RuntimeError("Output exceeds the configured maximum dimensions.")
    normal_orientation = output.width <= source.width and output.height <= source.height
    rotated_orientation = output.width <= source.height and output.height <= source.width
    if not (normal_orientation or rotated_orientation):
        raise RuntimeError("Output appears to upscale the source video.")
    if source.audio_codec and (len(audio_streams) != 1 or output.audio_codec != "aac"):
        raise RuntimeError("Output must contain exactly one AAC audio stream for this source.")
    if not source.audio_codec and audio_streams:
        raise RuntimeError("Output unexpectedly contains audio for a silent source.")
    if "mp4" not in output.container:
        raise RuntimeError("Output container is not MP4.")
    if abs(output.duration_seconds - source.duration_seconds) > max(1.0, source.duration_seconds * 0.02):
        raise RuntimeError("Output duration differs from the source by more than the allowed tolerance.")
    if output.frame_rate and output.frame_rate > profile["maximum_frame_rate"] + 0.1:
        raise RuntimeError("Output frame rate exceeds the configured maximum.")


def process_video(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if input_path == output_path:
        raise ValueError("Input and output paths must be different; the source is never overwritten.")
    if output_path.suffix.lower() != ".mp4":
        raise ValueError("Output path must use the .mp4 extension.")
    if output_path.exists() and not args.overwrite:
        raise FileExistsError(f"Output already exists: {output_path} (pass --overwrite to replace it).")

    profile = load_profile(args.config, {
        "target_width": args.target_width,
        "target_height": args.target_height,
        "video_bitrate_kbps": args.video_bitrate_kbps,
        "minimum_video_bitrate_kbps": args.minimum_video_bitrate_kbps,
        "audio_bitrate_kbps": args.audio_bitrate_kbps,
        "maximum_frame_rate": args.maximum_frame_rate,
        "maximum_output_size_mb": args.maximum_output_size_mb,
    })
    source = probe_media(input_path, args.ffprobe)
    out_width, out_height = output_dimensions(
        source.width, source.height, profile["target_width"], profile["target_height"]
    )
    needs_resize = out_width != source.width or out_height != source.height
    needs_fps_cap = bool(source.frame_rate and source.frame_rate > profile["maximum_frame_rate"])
    has_audio = source.audio_codec is not None
    needs_transcoding = any((
        source.video_codec != "h264",
        source.pixel_format != "yuv420p",
        "mp4" not in source.container,
        needs_resize,
        needs_fps_cap,
        source.video_stream_count != 1,
        source.audio_stream_count > 1,
        has_audio and source.audio_codec != "aac",
        has_audio and source.audio_bitrate_kbps is None,
        has_audio and source.audio_bitrate_kbps is not None
        and abs(source.audio_bitrate_kbps - profile["audio_bitrate_kbps"]) > 2,
        source.video_bitrate_kbps is None,
        source.video_bitrate_kbps is not None
        and abs(source.video_bitrate_kbps - profile["video_bitrate_kbps"]) > 10,
    ))
    max_output_bytes = int(profile["maximum_output_size_mb"] * 1_000_000)
    overhead = profile["overhead_allowance_percent"]
    target_estimate = estimated_size_bytes(
        source.duration_seconds,
        profile["video_bitrate_kbps"],
        profile["audio_bitrate_kbps"],
        has_audio,
        overhead,
    )
    minimum_estimate = estimated_size_bytes(
        source.duration_seconds,
        profile["minimum_video_bitrate_kbps"],
        profile["audio_bitrate_kbps"],
        has_audio,
        overhead,
    )
    size_objective_feasible = minimum_estimate <= max_output_bytes
    if not size_objective_feasible:
        print(
            "WARNING: The configured size limit is below the estimated size at the minimum video bitrate. "
            "Encoding will not reduce quality automatically.",
            file=sys.stderr,
        )
    elif target_estimate > max_output_bytes:
        print(
            "WARNING: The target bitrate profile is estimated to exceed the output-size limit; "
            "the configured bitrate will be preserved.",
            file=sys.stderr,
        )

    filter_parts = [
        f"scale=w='min({profile['target_width']},iw)':h='min({profile['target_height']},ih)':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    ]
    if needs_fps_cap:
        filter_parts.append(f"fps={profile['maximum_frame_rate']}")
    video_filter = ",".join(filter_parts)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}.", suffix=".partial.mp4", dir=output_path.parent
    )
    os.close(file_descriptor)
    temporary_output = Path(temporary_name)
    temporary_output.unlink()

    try:
        with tempfile.TemporaryDirectory(prefix="rayn-ffmpeg-pass-") as temporary_directory:
            pass_log = Path(temporary_directory) / "rayn-pass"
            common = [
                args.ffmpeg, "-hide_banner", "-nostats", "-v", "error", "-y", "-i", str(input_path),
                "-map", "0:v:0", "-vf", video_filter, "-c:v", "libx264",
                "-preset", profile["preset"], "-b:v", f"{profile['video_bitrate_kbps']}k",
                "-pix_fmt", "yuv420p", "-passlogfile", str(pass_log),
            ]
            if needs_fps_cap:
                common.extend(["-fps_mode", "cfr"])

            first_pass = common + [
                "-pass", "1", "-an", "-sn", "-dn", "-map_metadata", "-1",
                "-map_chapters", "-1", "-progress", "pipe:1", "-f", "null", os.devnull,
            ]
            run_ffmpeg(first_pass, Path(temporary_directory) / "pass1.stderr", source.duration_seconds, "Pass 1/2")

            second_pass = common + ["-pass", "2", "-map", "0:a:0?", "-c:a", "aac"]
            if has_audio:
                second_pass.extend(["-b:a", f"{profile['audio_bitrate_kbps']}k"])
            second_pass.extend([
                "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
                "-movflags", "+faststart", "-progress", "pipe:1", str(temporary_output),
            ])
            run_ffmpeg(second_pass, Path(temporary_directory) / "pass2.stderr", source.duration_seconds, "Pass 2/2")

        probe_command = [
            args.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(temporary_output)
        ]
        probe_result = subprocess.run(probe_command, capture_output=True, text=True, check=False)
        if probe_result.returncode:
            raise RuntimeError(f"FFprobe could not validate the encoded output: {probe_result.stderr.strip()}")
        output_metadata = json.loads(probe_result.stdout)
        output_info = probe_media(temporary_output, args.ffprobe)
        validate_output(source, output_info, profile, output_metadata.get("streams", []))

        print("Validating full video/audio decode…", file=sys.stderr)
        decode = subprocess.run(
            [args.ffmpeg, "-hide_banner", "-v", "error", "-i", str(temporary_output), "-f", "null", os.devnull],
            capture_output=True, text=True, check=False,
        )
        if decode.returncode:
            raise RuntimeError(f"Full decode validation failed: {decode.stderr.strip()}")

        output_size = temporary_output.stat().st_size
        output_fits_budget = output_size <= max_output_bytes
        compression_percent = (source.size_bytes - output_size) / source.size_bytes * 100 if source.size_bytes else 0.0
        report = {
            "input": asdict(source),
            "output": {
                "path": str(output_path),
                "size_bytes": output_size,
                "duration_seconds": output_info.duration_seconds,
                "width": output_info.width,
                "height": output_info.height,
                "video_codec": output_info.video_codec,
                "audio_codec": output_info.audio_codec,
                "pixel_format": output_info.pixel_format,
                "frame_rate": output_info.frame_rate,
                "container": output_info.container,
            },
            "encoding": {
                **profile,
                "source_needs_resize": needs_resize,
                "source_needs_frame_rate_cap": needs_fps_cap,
                "source_needs_transcoding": needs_transcoding,
                "video_filter": video_filter,
                "pass_count": 2,
            },
            "size_budget": {
                "maximum_bytes": max_output_bytes,
                "actual_output_bytes": output_size,
                "passed": output_fits_budget,
                "estimated_target_bytes": target_estimate,
                "estimated_minimum_profile_bytes": minimum_estimate,
                "minimum_profile_fits_budget": size_objective_feasible,
                "output_fits_budget": output_fits_budget,
                "quality_note": "Configured bitrate was preserved; inspect the result visually for source-specific quality.",
            },
            "compression_percent": round(compression_percent, 2),
        }
        if not output_fits_budget:
            raise SizeBudgetExceeded(report)
        if output_path.exists() and not args.overwrite:
            raise FileExistsError(f"Output appeared while encoding: {output_path}")
        os.replace(temporary_output, output_path)
    except BaseException:
        temporary_output.unlink(missing_ok=True)
        raise

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Encode and validate a Rayn H.264/AAC MP4 movie.")
    parser.add_argument("--input", required=True, help="Original source video; never modified.")
    parser.add_argument("--output", required=True, help="New .mp4 output path.")
    parser.add_argument("--config", type=Path, help="Optional JSON profile configuration.")
    parser.add_argument("--target-width", type=int)
    parser.add_argument("--target-height", type=int)
    parser.add_argument("--video-bitrate-kbps", type=int)
    parser.add_argument("--minimum-video-bitrate-kbps", type=int)
    parser.add_argument("--audio-bitrate-kbps", type=int)
    parser.add_argument("--maximum-frame-rate", type=int)
    parser.add_argument("--maximum-output-size-mb", type=float)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("FFPROBE", "ffprobe"))
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output, never the input.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    def interrupt_handler(signal_number: int, _frame: Any) -> None:
        signal_name = signal.Signals(signal_number).name
        raise KeyboardInterrupt(f"Received {signal_name}.")

    signal.signal(signal.SIGINT, interrupt_handler)
    signal.signal(signal.SIGTERM, interrupt_handler)
    try:
        if not shutil.which(args.ffmpeg) and not Path(args.ffmpeg).is_file():
            raise FileNotFoundError(f"FFmpeg executable not found: {args.ffmpeg}")
        if not shutil.which(args.ffprobe) and not Path(args.ffprobe).is_file():
            raise FileNotFoundError(f"FFprobe executable not found: {args.ffprobe}")
        report = process_video(args)
    except SizeBudgetExceeded as error:
        print(json.dumps(error.report, indent=2))
        print(f"SIZE_BUDGET_EXCEEDED: {error}", file=sys.stderr)
        return 2
    except RuntimeError as error:
        print(f"ENCODING_OR_VALIDATION_FAILED: {error}", file=sys.stderr)
        return 1
    except (FileNotFoundError, FileExistsError, ValueError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt as error:
        print(f"ERROR: {error or 'Encoding interrupted.'}", file=sys.stderr)
        return 130
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
