# audio2text

Convert audio files (mp3, ogg, wav, flac, m4a, opus, and more) into `.txt` or `.md`
transcripts. Runs fully offline on your CPU using [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
No ffmpeg install and no API key needed.

Comes as both a **desktop app** (Electron) and a **command-line tool**.

## Install (Windows)

Download **Audio-to-text-Setup-x.y.z.exe** from the
[latest release](https://github.com/Coder-Jon014/audio-to-text/releases/latest) and run it.
The installer bundles its own Python runtime, so nothing else needs to be installed.
Windows SmartScreen may warn because the installer is not code-signed: choose
"More info" then "Run anyway".

The first transcription downloads the Whisper model you pick (about 150 MB for `base`),
after which everything runs offline.

## Desktop app

If you installed from the release, open **Audio to text** from the Start menu or Desktop.
Running from this source folder instead: double-click **Audio to text.bat**.
Drop audio files (or whole folders) into the window, pick `.txt` or `.md`, and press Transcribe.
The transcript streams into the right-hand pane as it is decoded. From there, **Copy text** puts
the plain transcript on the clipboard (with timestamps if that box is ticked), and the finished
file can be opened or revealed in its folder.

**Hints** takes names and terms the model should spell correctly, such as people, companies and
jargon. Write them as they should appear in the transcript, with capitals and a full stop, because
Whisper copies the style of the hint text. The same option is `--prompt` on the command line.

Requirements: Node.js (for Electron) and the Python environment from the Setup section below.
The app looks for Python in this order: the path set in Settings, then `.venv` in this folder,
then `python` on your PATH. Use Settings → Test to confirm it is found.

To run from a terminal instead:

```powershell
cd app
npm install
npm start
```

End-to-end check (launches the app, transcribes a file, prints the result):

```powershell
cd app
node test/smoke.js ..\path\to\clip.mp3
```

### Building the installer

```powershell
cd app
npm install
npm run dist
```

`npm run dist` first runs `scripts/prepare-python.js`, which downloads the official
embeddable Python from python.org into `app/python` and installs the requirements into it,
then runs electron-builder. The installer lands in `app/dist/`.

## Command line

### Setup

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

The first run downloads the Whisper model you pick (about 150 MB for the default `base`)
into your Hugging Face cache. After that it works without a network connection.

### Usage

```powershell
# one file -> interview.txt next to it
python audio2text.py interview.mp3

# markdown with a [mm:ss] stamp on each line
python audio2text.py lecture.ogg --format md --timestamps

# a whole folder (searched recursively) into a separate output folder
python audio2text.py .\recordings --out .\transcripts

# better accuracy, slower: pick a bigger model and fix the language
python audio2text.py call.m4a --model small --language en
```

#### Options

| Flag | Meaning | Default |
|------|---------|---------|
| `-f, --format txt\|md` | output format | `txt` |
| `-o, --out DIR` | write transcripts here instead of next to each audio file | next to source |
| `-t, --timestamps` | prefix each line with its start time | off |
| `-m, --model` | `tiny`, `base`, `small`, `medium`, `large-v3`, `turbo` | `base` |
| `-l, --language` | language code (`en`, `es`, `fr`, ...) | auto-detect |
| `-p, --prompt` | vocabulary hints: names and terms to spell correctly | none |
| `--device cpu\|cuda\|auto` | run on CPU or an NVIDIA GPU | `cpu` |
| `--compute-type` | ctranslate2 precision, e.g. `int8`, `float16` | `int8` |
| `--force` | overwrite an existing transcript | off |

Existing transcripts are skipped unless you pass `--force`. If one file in a batch
fails, the rest still run and the exit code is 1.

#### Model guide (CPU, rough)

| Model | Size | Speed vs. real time | When to use |
|-------|------|---------------------|-------------|
| `tiny` | 75 MB | ~20x faster | quick drafts |
| `base` | 150 MB | ~10x faster | default, good for clear English |
| `small` | 480 MB | ~4x faster | noisy audio, accents, other languages |
| `medium` | 1.5 GB | ~1x | best quality without a GPU |
| `large-v3` / `turbo` | 3 GB / 1.6 GB | slow on CPU | with a GPU (`--device cuda --compute-type float16`) |

### Supported input formats

mp3, ogg, oga, opus, wav, flac, m4a, aac, wma, webm, aiff, amr, 3gp, and the audio
track of mp4, mkv, mov video files.

### Output examples

`--format txt`

```
The quick brown fox jumps over the lazy dog. This is a test of the audio to text converter.
```

`--format md --timestamps`

```markdown
# sample

- **Source:** sample.mp3
- **Duration:** 00:06
- **Language:** en (100% confidence)
- **Model:** base
- **Transcribed:** 2026-10-20 08:43

## Transcript

**[00:00]** The quick brown fox jumps over the lazy dog.
**[00:03]** This is a test of the audio to text converter.
```

### Tests

```powershell
.venv\Scripts\python -m pytest tests
```

The tests use a fake transcriber so they run in well under a second without downloading a model.
