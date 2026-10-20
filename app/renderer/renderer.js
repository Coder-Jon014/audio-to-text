'use strict';

const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'wma', 'webm', 'mp4', 'mkv', 'mov', 'aiff', 'aif', 'amr', '3gp']);

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), pickBtn: $('pickBtn'), queue: $('queue'), options: $('options'),
  model: $('model'), language: $('language'), hints: $('hints'), outDirLabel: $('outDirLabel'), outDirBtn: $('outDirBtn'),
  copyBtn: $('copyBtn'),
  outDirClear: $('outDirClear'), startBtn: $('startBtn'), cancelBtn: $('cancelBtn'), status: $('status'),
  railFill: $('railFill'), tName: $('tName'), tMeta: $('tMeta'), openBtn: $('openBtn'), revealBtn: $('revealBtn'),
  transcript: $('transcript'), log: $('log'), logBox: $('logBox'),
  settingsBtn: $('settingsBtn'), settingsDlg: $('settingsDlg'), pythonPath: $('pythonPath'),
  pythonBrowse: $('pythonBrowse'), pythonTest: $('pythonTest'), pythonStatus: $('pythonStatus'), settingsSave: $('settingsSave'),
};

const state = {
  items: [],          // { path, name, isDir, status, percent, output, segments, language, duration, error }
  selected: null,     // path
  running: false,
  settings: null,
  follow: true,       // transcript pane follows the file being worked on
};

// ---------------------------------------------------------------- helpers

const baseName = (p) => p.split(/[\\/]/).pop();
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const fmtTime = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
const find = (p) => state.items.find((it) => it.path === p);

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function logLine(line) {
  el.log.textContent += line + '\n';
  el.log.scrollTop = el.log.scrollHeight;
}

function readOptions() {
  const fd = new FormData(el.options);
  return {
    format: fd.get('format') || 'txt',
    timestamps: fd.get('timestamps') === 'on',
    model: el.model.value,
    language: el.language.value.trim(),
    // Whisper copies the style of the hint text, so make sure it ends with a full stop
    // or the transcript tends to lose its punctuation too.
    hints: el.hints.value.replace(/\s+/g, ' ').trim().replace(/^(.*[^.!?])$/, '$1.'),
    outDir: state.settings?.outDir || '',
    replaceExisting: fd.get('replaceExisting') === 'on',
  };
}

async function persistOptions() {
  state.settings = { ...state.settings, ...readOptions() };
  await window.api.saveSettings(state.settings);
}

function applySettings(s) {
  state.settings = s;
  el.options.elements.format.value = s.format;
  el.options.elements.timestamps.checked = !!s.timestamps;
  el.options.elements.replaceExisting.checked = s.replaceExisting !== false;
  el.model.value = s.model || 'base';
  el.language.value = s.language || '';
  el.hints.value = s.hints || '';
  el.pythonPath.value = s.pythonPath || '';
  renderOutDir();
}

function renderOutDir() {
  const dir = state.settings?.outDir;
  el.outDirLabel.textContent = dir || 'Next to each audio file';
  el.outDirLabel.title = dir || '';
  el.outDirClear.hidden = !dir;
}

// ---------------------------------------------------------------- queue

function addPaths(paths) {
  let added = 0, rejected = [];
  for (const p of paths) {
    if (!p || find(p)) continue;
    const isDir = !p.includes('.') || !AUDIO_EXT.has(extOf(p)) && extOf(p).length > 5;
    if (!isDir && !AUDIO_EXT.has(extOf(p))) { rejected.push(baseName(p)); continue; }
    state.items.push({ path: p, name: baseName(p), isDir, status: 'queued', percent: 0, output: null, segments: [], language: null, duration: null, error: null });
    added++;
  }
  if (rejected.length) setStatus(`Skipped ${rejected.length} unsupported file${rejected.length > 1 ? 's' : ''}: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}`, true);
  else if (added) setStatus('');
  if (!state.selected && state.items.length) select(state.items[0].path);
  renderQueue();
}

function removeItem(p) {
  state.items = state.items.filter((it) => it.path !== p);
  if (state.selected === p) select(state.items[0]?.path || null);
  renderQueue();
}

function stateLabel(it) {
  switch (it.status) {
    case 'queued': return it.isDir ? 'folder' : 'waiting';
    case 'working': return `${it.percent}%`;
    case 'done': return `done${it.language ? ' · ' + it.language : ''}`;
    case 'skipped': return 'already exists';
    case 'error': return 'failed';
    default: return '';
  }
}

function renderQueue() {
  el.queue.replaceChildren(...state.items.map((it) => {
    const li = document.createElement('li');
    li.dataset.path = it.path;
    li.classList.toggle('selected', it.path === state.selected);
    li.innerHTML = `
      <span class="name" title="${it.path.replace(/"/g, '&quot;')}"></span>
      <span class="state ${it.status}"></span>
      <button class="remove" type="button" title="Remove" aria-label="Remove">×</button>
      <span class="bar ${it.status === 'done' ? 'done' : ''}"><i style="width:${it.status === 'done' ? 100 : it.percent}%"></i></span>`;
    li.querySelector('.name').textContent = it.name;
    li.querySelector('.state').textContent = stateLabel(it);
    li.querySelector('.remove').disabled = state.running;
    return li;
  }));
  el.startBtn.disabled = state.running || state.items.length === 0;
  const n = state.items.length;
  if (!state.running) el.startBtn.textContent = n > 1 ? `Transcribe ${n} files` : 'Transcribe';
}

function updateRow(it) {
  const li = el.queue.querySelector(`li[data-path="${CSS.escape(it.path)}"]`);
  if (!li) return renderQueue();
  const st = li.querySelector('.state');
  st.className = `state ${it.status}`;
  st.textContent = stateLabel(it);
  const bar = li.querySelector('.bar');
  bar.classList.toggle('done', it.status === 'done');
  bar.firstElementChild.style.width = `${it.status === 'done' ? 100 : it.percent}%`;
}

// ---------------------------------------------------------------- transcript pane

function select(p, manual = false) {
  state.selected = p;
  if (manual) state.follow = !state.running || find(p)?.status === 'working';
  for (const li of el.queue.children) li.classList.toggle('selected', li.dataset.path === p);
  renderTranscript();
}

async function renderTranscript() {
  const it = find(state.selected);
  el.openBtn.disabled = el.revealBtn.disabled = !it?.output;
  el.copyBtn.disabled = !(it?.segments.length || it?.output);
  if (!it) {
    el.tName.textContent = 'No file selected';
    el.tMeta.textContent = 'Transcripts appear here as they are decoded.';
    el.transcript.innerHTML = '';
    el.railFill.style.width = '0%';
    return;
  }
  el.tName.textContent = it.name;
  el.railFill.style.width = `${it.status === 'done' ? 100 : it.percent}%`;

  if (it.segments.length) {
    el.tMeta.textContent = metaFor(it);
    el.transcript.replaceChildren(...it.segments.map(segmentNode));
    return;
  }
  if (it.output) {
    const r = await window.api.readText(it.output);
    if (state.selected !== it.path) return;
    it.loadedText = r.error ? '' : r.text;
    el.copyBtn.disabled = !it.loadedText;
    el.tMeta.textContent = r.error ? r.error : `Saved earlier · ${it.output}`;
    el.transcript.innerHTML = '';
    const pre = document.createElement('p');
    pre.textContent = r.text;
    pre.style.whiteSpace = 'pre-wrap';
    el.transcript.append(pre);
    return;
  }
  el.tMeta.textContent = it.error ? it.error : it.isDir ? 'Every audio file inside this folder will be transcribed.' : 'Waiting to start.';
  el.transcript.innerHTML = `<p class="empty">${it.error ? '' : 'Press Transcribe to begin.'}</p>`;
}

function metaFor(it) {
  const bits = [];
  if (it.duration) bits.push(`${fmtTime(it.duration)} of audio`);
  if (it.language) bits.push(`language ${it.language}`);
  if (it.status === 'working') bits.push(`decoding ${fmtTime(it.segments.at(-1)?.end || 0)}`);
  if (it.output) bits.push(it.output);
  return bits.join(' · ');
}

function segmentNode(seg) {
  const p = document.createElement('p');
  const stamp = document.createElement('span');
  stamp.className = 'stamp';
  stamp.textContent = `[${fmtTime(seg.start)}]`;
  p.append(stamp, document.createTextNode(seg.text));
  return p;
}

function appendSegment(it, seg) {
  it.segments.push(seg);
  if (state.selected !== it.path) return;
  const atBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 60;
  el.transcript.querySelector('.empty')?.remove();
  el.transcript.append(segmentNode(seg));
  el.tMeta.textContent = metaFor(it);
  el.railFill.style.width = `${it.percent}%`;
  if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
}

// ---------------------------------------------------------------- running

async function start() {
  if (state.running || !state.items.length) return;
  await persistOptions();
  for (const it of state.items) {
    if (it.status !== 'queued' && !it.isDir) Object.assign(it, { status: 'queued', percent: 0, segments: [], output: null, error: null });
  }
  el.log.textContent = '';
  state.follow = true;
  const opts = readOptions();
  const r = await window.api.startJob(state.items.map((it) => it.path), opts);
  if (!r.ok) { setStatus(r.error, true); return; }
  state.running = true;
  el.startBtn.textContent = 'Transcribing…';
  el.cancelBtn.hidden = false;
  setStatus('Starting…');
  renderQueue();
  renderTranscript();
}

function finish({ code, cancelled }) {
  state.running = false;
  el.cancelBtn.hidden = true;
  for (const it of state.items) {
    if (it.status === 'working') { it.status = cancelled ? 'queued' : 'error'; it.error = cancelled ? null : 'Stopped before finishing.'; it.percent = 0; }
    if (it.isDir && it.status === 'queued' && !cancelled) it.status = 'done';
  }
  const done = state.items.filter((it) => it.status === 'done' && !it.isDir).length;
  const failed = state.items.filter((it) => it.status === 'error').length;
  if (cancelled) setStatus('Stopped.');
  else if (failed) setStatus(`${done} finished, ${failed} failed. See the activity log.`, true);
  else if (code === 0) setStatus(done === 1 ? 'Finished.' : `Finished ${done} files.`);
  else if (!el.status.classList.contains('error')) setStatus(`Transcriber exited with code ${code}. See the activity log.`, true);
  renderQueue();
  renderTranscript();
}

window.api.onJobEvent((evt) => {
  const it = evt.file ? find(evt.file) : null;
  switch (evt.event) {
    case 'model_loading':
      setStatus(`Loading the ${evt.model} model… the first run downloads it, which can take a few minutes.`);
      break;
    case 'model_ready':
      setStatus('Model ready.');
      break;
    case 'file_start': {
      let item = it;
      if (!item) { // file discovered inside a dropped folder
        item = { path: evt.file, name: baseName(evt.file), isDir: false, status: 'queued', percent: 0, output: null, segments: [], language: null, duration: null, error: null };
        state.items.push(item);
        renderQueue();
      }
      Object.assign(item, { status: 'working', percent: 0, segments: [], output: null, error: null });
      setStatus(`Transcribing ${item.name} (${evt.index} of ${evt.total})…`);
      if (state.follow) select(item.path); else updateRow(item);
      if (state.selected === item.path) { el.transcript.innerHTML = ''; renderTranscript(); }
      break;
    }
    case 'progress':
      if (!it) break;
      it.percent = evt.percent;
      it.duration = evt.duration;
      appendSegment(it, { start: evt.start, end: evt.seconds, text: evt.text });
      updateRow(it);
      break;
    case 'file_done':
      if (!it) break;
      Object.assign(it, { status: 'done', percent: 100, output: evt.output, language: evt.language, duration: evt.duration });
      updateRow(it);
      if (state.selected === it.path) renderTranscript();
      break;
    case 'file_skipped':
      if (!it) break;
      Object.assign(it, { status: 'skipped', output: evt.output });
      updateRow(it);
      if (state.selected === it.path) renderTranscript();
      break;
    case 'file_error':
      if (!it) break;
      Object.assign(it, { status: 'error', error: evt.error });
      updateRow(it);
      if (state.selected === it.path) renderTranscript();
      break;
    case 'error':
      setStatus(evt.message, true);
      el.logBox.open = true;
      break;
    default:
      break;
  }
});
window.api.onJobLog(logLine);
window.api.onJobExit(finish);

// ---------------------------------------------------------------- wiring

el.pickBtn.addEventListener('click', async (e) => { e.stopPropagation(); addPaths(await window.api.pickFiles()); });
el.dropzone.addEventListener('click', async () => addPaths(await window.api.pickFiles()));
el.dropzone.addEventListener('keydown', async (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addPaths(await window.api.pickFiles()); } });

for (const evName of ['dragenter', 'dragover']) {
  document.addEventListener(evName, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
}
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) el.dropzone.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('over');
  addPaths([...e.dataTransfer.files].map((f) => window.api.pathForFile(f)));
});

el.queue.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.classList.contains('remove')) { if (!state.running) removeItem(li.dataset.path); return; }
  select(li.dataset.path, true);
});

el.options.addEventListener('submit', (e) => { e.preventDefault(); start(); });
el.options.addEventListener('change', persistOptions);
el.cancelBtn.addEventListener('click', () => { setStatus('Stopping…'); window.api.cancelJob(); });

el.outDirBtn.addEventListener('click', async () => {
  const dir = await window.api.pickFolder('out');
  if (!dir) return;
  state.settings.outDir = dir;
  renderOutDir();
  await window.api.saveSettings(state.settings);
});
el.outDirClear.addEventListener('click', async () => {
  state.settings.outDir = '';
  renderOutDir();
  await window.api.saveSettings(state.settings);
});

function transcriptText(it) {
  if (it.segments.length) {
    const withStamps = el.options.elements.timestamps.checked;
    return withStamps
      ? it.segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n')
      : it.segments.map((s) => s.text).join(' ');
  }
  return it.loadedText || '';
}

let copyResetTimer = null;
el.copyBtn.addEventListener('click', async () => {
  const it = find(state.selected);
  if (!it) return;
  const text = transcriptText(it);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent = 'Copied';
  } catch {
    el.copyBtn.textContent = 'Copy failed';
  }
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => { el.copyBtn.textContent = 'Copy text'; }, 1500);
});

el.openBtn.addEventListener('click', () => { const it = find(state.selected); if (it?.output) window.api.openPath(it.output); });
el.revealBtn.addEventListener('click', () => { const it = find(state.selected); if (it?.output) window.api.showInFolder(it.output); });

// settings dialog
el.settingsBtn.addEventListener('click', () => { el.pythonStatus.textContent = ''; el.pythonPath.value = state.settings.pythonPath || ''; el.settingsDlg.showModal(); });
el.pythonBrowse.addEventListener('click', async () => { const p = await window.api.pickFolder('python'); if (p) el.pythonPath.value = p; });
el.pythonTest.addEventListener('click', async () => {
  el.pythonStatus.textContent = 'Checking…';
  el.pythonStatus.classList.remove('error');
  const r = await window.api.checkPython(el.pythonPath.value.trim());
  el.pythonStatus.textContent = r.python ? `Ready: ${r.python}` : r.error;
  el.pythonStatus.classList.toggle('error', !r.python);
});
el.settingsDlg.addEventListener('close', async () => {
  if (el.settingsDlg.returnValue !== 'save') return;
  state.settings.pythonPath = el.pythonPath.value.trim();
  await window.api.saveSettings(state.settings);
});

// ---------------------------------------------------------------- boot

(async () => {
  applySettings(await window.api.getSettings());
  renderQueue();
  renderTranscript();
  const r = await window.api.checkPython();
  if (!r.python) { setStatus(r.error, true); }
})();
