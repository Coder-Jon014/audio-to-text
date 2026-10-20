'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// In development the transcriber lives in the repo next to this folder. In the
// installed app, electron-builder copies it and a bundled Python into resources/.
const REPO_DIR = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const SCRIPT = path.join(REPO_DIR, 'audio2text.py');
const BUNDLED_PYTHON = app.isPackaged
  ? path.join(process.resourcesPath, 'python', 'python.exe')
  : path.join(__dirname, 'python', 'python.exe');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  pythonPath: '',
  format: 'txt',
  timestamps: false,
  model: 'base',
  language: '',
  hints: '',
  outDir: '',
  replaceExisting: true,
};

// Tests point this at a scratch folder so they never touch the user's real settings.
if (process.env.AUDIO2TEXT_USER_DATA) app.setPath('userData', process.env.AUDIO2TEXT_USER_DATA);

let win = null;
let job = null; // { child, cancelled }

// ---------------------------------------------------------------- settings

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8').replace(/^﻿/, '');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------- python

function candidatePythons(settings) {
  const list = [];
  if (settings.pythonPath) list.push(settings.pythonPath);
  list.push(BUNDLED_PYTHON);
  list.push(path.join(REPO_DIR, '.venv', 'Scripts', 'python.exe'));
  list.push(path.join(REPO_DIR, '.venv', 'bin', 'python'));
  list.push('python');
  list.push('py');
  return list;
}

/** Find a Python that has faster-whisper installed. Returns {python, error}. */
function resolvePython(settings) {
  const tried = [];
  for (const py of candidatePythons(settings)) {
    const r = spawnSync(py, ['-c', 'import faster_whisper, sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
    if (r.status === 0) return { python: r.stdout.trim() || py, error: null };
    tried.push(py);
  }
  return {
    python: null,
    error:
      'No Python with faster-whisper was found. Tried: ' +
      tried.join(', ') +
      '. Run "pip install -r requirements.txt" in the project folder, or set the Python path in Settings.',
  };
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: 'Audio to text',
    backgroundColor: '#f2f3ef',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (job?.child) job.child.kill();
  app.quit();
});

// ---------------------------------------------------------------- ipc

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, s) => {
  saveSettings({ ...DEFAULT_SETTINGS, ...s });
  return true;
});

ipcMain.handle('python:check', (_e, pythonPath) => {
  const settings = loadSettings();
  if (typeof pythonPath === 'string') settings.pythonPath = pythonPath;
  return resolvePython(settings);
});

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Audio',
        extensions: ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'wma', 'webm', 'aiff', 'aif', 'amr', '3gp', 'mp4', 'mkv', 'mov'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:pickFolder', async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'python' ? 'Choose python.exe' : 'Choose output folder',
    properties: kind === 'python' ? ['openFile'] : ['openDirectory', 'createDirectory'],
    filters: kind === 'python' ? [{ name: 'Python', extensions: ['exe'] }] : undefined,
  });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('fs:readText', (_e, file) => {
  try {
    return { text: fs.readFileSync(file, 'utf8'), error: null };
  } catch (err) {
    return { text: '', error: String(err.message || err) };
  }
});

ipcMain.handle('shell:open', (_e, file) => shell.openPath(file));
ipcMain.handle('shell:showInFolder', (_e, file) => {
  shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('job:start', (_e, { files, options }) => {
  if (job) return { ok: false, error: 'A transcription is already running.' };
  if (!files?.length) return { ok: false, error: 'No files were chosen.' };

  const settings = loadSettings();
  const { python, error } = resolvePython(settings);
  if (!python) return { ok: false, error };

  const args = [SCRIPT, '--json', '--format', options.format, '--model', options.model];
  if (options.timestamps) args.push('--timestamps');
  if (options.language) args.push('--language', options.language);
  if (options.hints) args.push('--prompt', options.hints);
  if (options.outDir) args.push('--out', options.outDir);
  if (options.replaceExisting) args.push('--force');
  args.push(...files);

  const child = spawn(python, args, {
    cwd: REPO_DIR,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  job = { child, cancelled: false };

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      send('job:event', JSON.parse(line));
    } catch {
      send('job:log', line);
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (line.trim()) send('job:log', line);
  });

  child.on('error', (err) => {
    send('job:event', { event: 'error', message: `Could not start Python: ${err.message}` });
  });
  child.on('close', (code) => {
    const cancelled = job?.cancelled;
    job = null;
    send('job:exit', { code, cancelled });
  });

  return { ok: true, python };
});

ipcMain.handle('job:cancel', () => {
  if (!job) return false;
  job.cancelled = true;
  job.child.kill();
  return true;
});
