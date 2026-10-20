from datetime import datetime
from pathlib import Path

import pytest

import audio2text as a2t


# ---------- timestamp formatting ----------

def test_fmt_time_under_an_hour():
    assert a2t.fmt_time(0) == "00:00"
    assert a2t.fmt_time(65.4) == "01:05"
    assert a2t.fmt_time(599.9) == "09:59"


def test_fmt_time_over_an_hour():
    assert a2t.fmt_time(3600) == "1:00:00"
    assert a2t.fmt_time(3725) == "1:02:05"


# ---------- input discovery ----------

def test_find_audio_files_accepts_single_file(tmp_path):
    f = tmp_path / "talk.MP3"
    f.write_bytes(b"x")
    assert a2t.find_audio_files([f]) == [f]


def test_find_audio_files_walks_directory_and_skips_non_audio(tmp_path):
    (tmp_path / "a.mp3").write_bytes(b"x")
    (tmp_path / "b.ogg").write_bytes(b"x")
    (tmp_path / "notes.txt").write_text("hi")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "c.flac").write_bytes(b"x")
    found = a2t.find_audio_files([tmp_path])
    names = sorted(p.name for p in found)
    assert names == ["a.mp3", "b.ogg", "c.flac"]


def test_find_audio_files_rejects_unsupported_file(tmp_path):
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"x")
    with pytest.raises(a2t.UnsupportedFileError):
        a2t.find_audio_files([f])


def test_find_audio_files_rejects_missing_path(tmp_path):
    with pytest.raises(FileNotFoundError):
        a2t.find_audio_files([tmp_path / "nope.mp3"])


# ---------- output path ----------

def test_output_path_next_to_source_by_default(tmp_path):
    src = tmp_path / "x.mp3"
    assert a2t.output_path(src, "txt", None) == tmp_path / "x.txt"
    assert a2t.output_path(src, "md", None) == tmp_path / "x.md"


def test_output_path_in_chosen_dir(tmp_path):
    src = tmp_path / "in" / "x.ogg"
    out = tmp_path / "out"
    assert a2t.output_path(src, "md", out) == out / "x.md"


# ---------- rendering ----------

SEGS = [
    a2t.Segment(start=0.0, end=2.5, text=" Hello there."),
    a2t.Segment(start=2.5, end=5.0, text=" How are you?"),
]
RESULT = a2t.Transcript(
    source=Path("C:/audio/meeting.mp3"),
    language="en",
    language_probability=0.98,
    duration=5.0,
    model="small",
    segments=SEGS,
    created=datetime(2026, 10, 20, 9, 30),
)


def test_render_txt_plain_joins_segments():
    out = a2t.render_txt(RESULT, timestamps=False)
    assert out == "Hello there. How are you?\n"


def test_render_txt_with_timestamps():
    out = a2t.render_txt(RESULT, timestamps=True)
    assert out == "[00:00] Hello there.\n[00:02] How are you?\n"


def test_render_md_has_header_metadata_and_text():
    out = a2t.render_md(RESULT, timestamps=False)
    assert out.startswith("# meeting\n")
    assert "- **Source:** meeting.mp3" in out
    assert "- **Duration:** 00:05" in out
    assert "- **Language:** en" in out
    assert "- **Model:** small" in out
    assert "- **Transcribed:** 2026-10-20 09:30" in out
    assert "## Transcript\n\nHello there. How are you?\n" in out
    assert out.rstrip().endswith("Hello there. How are you?")


def test_render_md_with_timestamps_uses_bold_stamps():
    out = a2t.render_md(RESULT, timestamps=True)
    assert "**[00:00]** Hello there.  \n**[00:02]** How are you?" in out


def test_render_dispatches_on_format():
    assert a2t.render(RESULT, "txt", False) == a2t.render_txt(RESULT, False)
    assert a2t.render(RESULT, "md", True) == a2t.render_md(RESULT, True)


# ---------- CLI wiring with a fake transcriber ----------

class FakeModel:
    def __init__(self, *a, **k):
        pass

    def transcribe(self, path, **kwargs):
        class Info:
            language = "en"
            language_probability = 0.9
            duration = 3.0

        class Seg:
            def __init__(self, s, e, t):
                self.start, self.end, self.text = s, e, t

        return iter([Seg(0, 1.5, " One."), Seg(1.5, 3, " Two.")]), Info()


def test_main_writes_output_file(tmp_path, monkeypatch):
    monkeypatch.setattr(a2t, "load_model", lambda *a, **k: FakeModel())
    src = tmp_path / "clip.ogg"
    src.write_bytes(b"x")
    out_dir = tmp_path / "out"
    rc = a2t.main([str(src), "--format", "md", "--out", str(out_dir)])
    assert rc == 0
    written = out_dir / "clip.md"
    assert written.exists()
    body = written.read_text(encoding="utf-8")
    assert "# clip" in body and "One. Two." in body


def test_main_refuses_to_overwrite_without_force(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(a2t, "load_model", lambda *a, **k: FakeModel())
    src = tmp_path / "clip.mp3"
    src.write_bytes(b"x")
    existing = tmp_path / "clip.txt"
    existing.write_text("keep me", encoding="utf-8")
    rc = a2t.main([str(src)])
    assert rc == 0
    assert existing.read_text(encoding="utf-8") == "keep me"
    assert "skip" in capsys.readouterr().err.lower()
    rc = a2t.main([str(src), "--force"])
    assert existing.read_text(encoding="utf-8") == "One. Two.\n"


def test_main_returns_nonzero_for_missing_input(tmp_path, capsys):
    rc = a2t.main([str(tmp_path / "ghost.mp3")])
    assert rc != 0
    assert "ghost.mp3" in capsys.readouterr().err


# ---------- JSON event stream (used by the desktop app) ----------

def test_main_json_emits_event_stream(tmp_path, monkeypatch, capsys):
    import json
    monkeypatch.setattr(a2t, "load_model", lambda *a, **k: FakeModel())
    src = tmp_path / "clip.mp3"
    src.write_bytes(b"x")
    rc = a2t.main([str(src), "--json"])
    assert rc == 0
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    events = [e["event"] for e in lines]
    assert events[0] == "model_loading"
    assert "model_ready" in events
    assert "file_start" in events
    progress = [e for e in lines if e["event"] == "progress"]
    assert len(progress) == 2
    assert progress[0]["text"] == "One."
    assert progress[-1]["percent"] == 100
    done = next(e for e in lines if e["event"] == "file_done")
    assert done["output"].endswith("clip.txt")
    assert done["language"] == "en"
    assert lines[-1] == {"event": "done", "failures": 0, "total": 1}


def test_main_json_reports_missing_input(tmp_path, capsys):
    import json
    rc = a2t.main([str(tmp_path / "ghost.mp3"), "--json"])
    assert rc == 2
    out = capsys.readouterr().out.strip().splitlines()
    evt = json.loads(out[-1])
    assert evt["event"] == "error" and "ghost.mp3" in evt["message"]


# ---------- vocabulary hints ----------

def test_prompt_is_passed_to_model_as_initial_prompt(tmp_path, monkeypatch):
    calls = []

    class RecordingModel(FakeModel):
        def transcribe(self, path, **kwargs):
            calls.append(kwargs)
            return super().transcribe(path, **kwargs)

    monkeypatch.setattr(a2t, "load_model", lambda *a, **k: RecordingModel())
    src = tmp_path / "clip.mp3"
    src.write_bytes(b"x")
    assert a2t.main([str(src), "--prompt", "Acme Corp, Priya Natarajan, Kubernetes"]) == 0
    assert calls[0]["initial_prompt"] == "Acme Corp, Priya Natarajan, Kubernetes"


def test_no_prompt_means_no_initial_prompt(tmp_path, monkeypatch):
    calls = []

    class RecordingModel(FakeModel):
        def transcribe(self, path, **kwargs):
            calls.append(kwargs)
            return super().transcribe(path, **kwargs)

    monkeypatch.setattr(a2t, "load_model", lambda *a, **k: RecordingModel())
    src = tmp_path / "clip.mp3"
    src.write_bytes(b"x")
    assert a2t.main([str(src)]) == 0
    assert calls[0]["initial_prompt"] is None
