#!/usr/bin/env python
"""audio2text - transcribe audio files (mp3, ogg, wav, flac, m4a, ...) to .txt or .md.

Runs fully offline on CPU using faster-whisper. The first run downloads the
chosen Whisper model (~75 MB for "tiny", ~150 MB for "base", ~480 MB for
"small") into the Hugging Face cache; later runs need no network.

Examples:
    python audio2text.py interview.mp3
    python audio2text.py lecture.ogg --format md --timestamps
    python audio2text.py ./recordings --out ./transcripts --model small
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable, Sequence

AUDIO_EXTENSIONS = {
    ".mp3", ".ogg", ".oga", ".opus", ".wav", ".flac", ".m4a", ".aac",
    ".wma", ".webm", ".mp4", ".mkv", ".mov", ".aiff", ".aif", ".amr", ".3gp",
}
FORMATS = ("txt", "md")
MODELS = ("tiny", "base", "small", "medium", "large-v3", "turbo")


class UnsupportedFileError(ValueError):
    """Raised when an explicitly named input is not a recognised audio file."""


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    source: Path
    language: str
    language_probability: float
    duration: float
    model: str
    segments: list[Segment]
    created: datetime


# ----------------------------------------------------------------- helpers

def fmt_time(seconds: float) -> str:
    """Format seconds as MM:SS, or H:MM:SS once past an hour."""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def find_audio_files(inputs: Iterable[Path]) -> list[Path]:
    """Expand files and directories into a sorted list of audio files."""
    found: list[Path] = []
    for p in inputs:
        p = Path(p)
        if not p.exists():
            raise FileNotFoundError(str(p))
        if p.is_dir():
            found.extend(
                f for f in sorted(p.rglob("*"))
                if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS
            )
        elif p.suffix.lower() in AUDIO_EXTENSIONS:
            found.append(p)
        else:
            raise UnsupportedFileError(
                f"{p}: unsupported extension '{p.suffix}'. "
                f"Supported: {', '.join(sorted(AUDIO_EXTENSIONS))}"
            )
    return found


def output_path(source: Path, fmt: str, out_dir: Path | None) -> Path:
    target_dir = Path(out_dir) if out_dir else source.parent
    return target_dir / f"{source.stem}.{fmt}"


# --------------------------------------------------------------- rendering

def _plain_text(segments: Sequence[Segment]) -> str:
    return " ".join(s.text.strip() for s in segments if s.text.strip())


def render_txt(t: Transcript, timestamps: bool) -> str:
    if not timestamps:
        return _plain_text(t.segments) + "\n"
    lines = [f"[{fmt_time(s.start)}] {s.text.strip()}" for s in t.segments if s.text.strip()]
    return "\n".join(lines) + "\n"


def render_md(t: Transcript, timestamps: bool) -> str:
    head = [
        f"# {t.source.stem}",
        "",
        f"- **Source:** {t.source.name}",
        f"- **Duration:** {fmt_time(t.duration)}",
        f"- **Language:** {t.language} ({t.language_probability:.0%} confidence)",
        f"- **Model:** {t.model}",
        f"- **Transcribed:** {t.created:%Y-%m-%d %H:%M}",
        "",
        "## Transcript",
        "",
    ]
    if timestamps:
        body = "  \n".join(
            f"**[{fmt_time(s.start)}]** {s.text.strip()}"
            for s in t.segments if s.text.strip()
        )
    else:
        body = _plain_text(t.segments)
    return "\n".join(head) + "\n" + body + "\n"


def render(t: Transcript, fmt: str, timestamps: bool) -> str:
    if fmt == "txt":
        return render_txt(t, timestamps)
    if fmt == "md":
        return render_md(t, timestamps)
    raise ValueError(f"unknown format {fmt!r}")


# ------------------------------------------------------------ transcribing

def load_model(name: str, device: str, compute_type: str):
    """Import lazily so the CLI stays usable (and testable) without the model."""
    from faster_whisper import WhisperModel
    return WhisperModel(name, device=device, compute_type=compute_type)


def transcribe_file(
    model,
    path: Path,
    model_name: str,
    language: str | None,
    on_segment: Callable[[Segment, float], None] | None = None,
    prompt: str | None = None,
) -> Transcript:
    """Transcribe one file. `on_segment(segment, total_duration)` fires as each
    segment is decoded, which lets callers report live progress. `prompt` is a
    short text of names and terms that biases the model's spelling."""
    segments_iter, info = model.transcribe(
        str(path),
        language=language,
        beam_size=5,
        vad_filter=True,
        initial_prompt=prompt or None,
    )
    duration = float(info.duration)
    segments: list[Segment] = []
    for s in segments_iter:
        seg = Segment(float(s.start), float(s.end), s.text)
        segments.append(seg)
        if on_segment:
            on_segment(seg, duration)
    return Transcript(
        source=path,
        language=info.language,
        language_probability=float(info.language_probability),
        duration=duration,
        model=model_name,
        segments=segments,
        created=datetime.now(),
    )


# ------------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="audio2text",
        description="Transcribe audio files to .txt or .md using Whisper (offline).",
    )
    p.add_argument("inputs", nargs="+", type=Path, help="audio file(s) or folder(s)")
    p.add_argument("-f", "--format", choices=FORMATS, default="txt", help="output format (default: txt)")
    p.add_argument("-o", "--out", type=Path, default=None, help="output folder (default: next to each audio file)")
    p.add_argument("-t", "--timestamps", action="store_true", help="prefix each line with its start time")
    p.add_argument("-m", "--model", default="base", help=f"Whisper model size, one of {', '.join(MODELS)} (default: base)")
    p.add_argument("-l", "--language", default=None, help="language code such as en, es, fr (default: auto-detect)")
    p.add_argument("-p", "--prompt", default=None, help="vocabulary hints: names and terms to spell correctly, e.g. 'Acme, Priya, Kubernetes'")
    p.add_argument("--device", default="cpu", choices=("cpu", "cuda", "auto"), help="inference device (default: cpu)")
    p.add_argument("--compute-type", default="int8", help="ctranslate2 compute type (default: int8; try float16 on GPU)")
    p.add_argument("--force", action="store_true", help="overwrite existing output files")
    p.add_argument("--json", action="store_true", help="emit one JSON event per line on stdout (for GUIs)")
    return p


def _emitter(enabled: bool) -> Callable[..., None]:
    """Return a function that prints a JSON event line on stdout when enabled."""
    def emit(event: str, **fields) -> None:
        if enabled:
            print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)
    return emit


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    err = sys.stderr
    emit = _emitter(args.json)

    try:
        files = find_audio_files(args.inputs)
    except (FileNotFoundError, UnsupportedFileError) as e:
        print(f"error: {e}", file=err)
        emit("error", message=str(e))
        return 2
    if not files:
        msg = "no audio files found in the given inputs"
        print(f"error: {msg}", file=err)
        emit("error", message=msg)
        return 2

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    model = None
    failures = 0
    total = len(files)
    for i, src in enumerate(files, 1):
        dest = output_path(src, args.format, args.out)
        if dest.exists() and not args.force:
            print(f"[{i}/{total}] skip {src.name}: {dest} exists (use --force)", file=err)
            emit("file_skipped", index=i, total=total, file=str(src), output=str(dest))
            continue
        if model is None:
            print(f"loading model '{args.model}' on {args.device} ...", file=err)
            emit("model_loading", model=args.model, device=args.device)
            try:
                model = load_model(args.model, args.device, args.compute_type)
            except Exception as e:  # noqa: BLE001
                print(f"error: could not load model: {e}", file=err)
                emit("error", message=f"could not load model '{args.model}': {e}")
                return 2
            emit("model_ready", model=args.model)
        print(f"[{i}/{total}] transcribing {src.name} ...", file=err, end="", flush=True)
        emit("file_start", index=i, total=total, file=str(src))
        t0 = time.perf_counter()

        def on_segment(seg: Segment, duration: float, _src=src) -> None:
            pct = 100 if duration <= 0 else min(100, round(seg.end / duration * 100))
            emit("progress", file=str(_src), percent=pct, seconds=seg.end,
                 duration=duration, start=seg.start, text=seg.text.strip())

        try:
            transcript = transcribe_file(model, src, args.model, args.language, on_segment, args.prompt)
        except Exception as e:  # noqa: BLE001 - report and keep going with the batch
            failures += 1
            print(f" failed: {e}", file=err)
            emit("file_error", index=i, total=total, file=str(src), error=str(e))
            continue
        dest.write_text(render(transcript, args.format, args.timestamps), encoding="utf-8")
        elapsed = time.perf_counter() - t0
        print(f" done in {elapsed:.1f}s -> {dest}", file=err)
        emit("file_done", index=i, total=total, file=str(src), output=str(dest),
             seconds=round(elapsed, 1), language=transcript.language,
             duration=transcript.duration)

    emit("done", failures=failures, total=total)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
