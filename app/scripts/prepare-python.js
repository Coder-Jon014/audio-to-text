'use strict';
// Builds a self-contained Python runtime in app/python for packaging.
// Downloads the official Windows "embeddable" Python from python.org, enables
// site-packages in it, and installs the transcriber's dependencies into it.
//   node scripts/prepare-python.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PY_VERSION = '3.12.8';
const URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const APP_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(APP_DIR, '..');
const TARGET = path.join(APP_DIR, 'python');
const ZIP = path.join(APP_DIR, `python-${PY_VERSION}-embed-amd64.zip`);
const REQUIREMENTS = path.join(REPO_DIR, 'requirements.txt');

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

(async () => {
  if (fs.existsSync(path.join(TARGET, 'python.exe')) && fs.existsSync(path.join(TARGET, 'Lib', 'site-packages', 'faster_whisper'))) {
    console.log('app/python already prepared; delete it to rebuild.');
    return;
  }
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });

  if (!fs.existsSync(ZIP)) {
    console.log('downloading', URL);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    fs.writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
  }
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${TARGET}' -Force`]);

  // The embeddable build ignores site-packages unless the ._pth file says otherwise.
  const pth = fs.readdirSync(TARGET).find((f) => /^python\d+\._pth$/.test(f));
  if (!pth) throw new Error('could not find python3xx._pth in the embeddable zip');
  fs.writeFileSync(path.join(TARGET, pth), ['python312.zip', '.', 'Lib\\site-packages', 'import site', ''].join('\n'));

  // Install wheels with the system Python's pip into the embedded runtime.
  const site = path.join(TARGET, 'Lib', 'site-packages');
  fs.mkdirSync(site, { recursive: true });
  run('python', ['-m', 'pip', 'install', '--only-binary=:all:', '--python-version', '3.12', '--platform', 'win_amd64',
    '--target', site, '--upgrade', '-r', REQUIREMENTS]);

  // Smoke check: the embedded interpreter must import faster_whisper on its own.
  const out = execFileSync(path.join(TARGET, 'python.exe'), ['-I', '-c', 'import faster_whisper, av, ctranslate2; print("ok", faster_whisper.__version__)'], { encoding: 'utf8' });
  console.log('embedded python check:', out.trim());
  fs.rmSync(ZIP, { force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
