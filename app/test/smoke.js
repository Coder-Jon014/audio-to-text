'use strict';
// End-to-end smoke test: launches the app, queues an audio file, transcribes it,
// and checks that the transcript shows up and the output file is written.
//   node test/smoke.js <audio-file> [screenshot.png]

const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require('playwright-core');

const audio = path.resolve(process.argv[2] || '');
const shot = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!audio || !fs.existsSync(audio)) {
  console.error('usage: node test/smoke.js <audio-file> [screenshot.png]');
  process.exit(2);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audio2text-test-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    bypassCSP: true,
    env: { ...process.env, AUDIO2TEXT_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.getElementById('startBtn') !== null);

  // Queue the file the same way a drop would, then start.
  await page.evaluate((p) => addPaths([p]), audio);
  await page.waitForSelector('#queue li');
  await page.fill('#hints', 'quick brown fox, lazy dog');
  await page.click('#startBtn');

  // Wait for the job to finish (model download on first run can take a while).
  await page.waitForFunction(
    () => /^Finished/.test(document.getElementById('status').textContent) ||
          document.getElementById('status').classList.contains('error'),
    null,
    { timeout: 15 * 60 * 1000 },
  );

  const status = await page.textContent('#status');
  const transcript = await page.textContent('#transcript');
  const rowState = await page.textContent('#queue li .state');
  const outputEnabled = await page.isEnabled('#openBtn');

  // Copy button: label flips to "Copied" and the clipboard holds the plain text.
  await page.click('#copyBtn');
  const copyLabel = await page.textContent('#copyBtn');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());

  if (shot) await page.screenshot({ path: shot });
  await app.close();

  console.log('status    :', status.trim());
  console.log('row state :', rowState.trim());
  console.log('transcript:', transcript.trim().replace(/\s+/g, ' ').slice(0, 300));
  console.log('open btn  :', outputEnabled ? 'enabled' : 'disabled');
  console.log('copy btn  :', copyLabel.trim());
  console.log('clipboard :', clipboard.trim().slice(0, 300));
  const ok = /^Finished/.test(status) && outputEnabled && transcript.trim().length > 0 &&
    copyLabel.trim() === 'Copied' && clipboard.trim().length > 0 && !clipboard.includes('[00:');
  console.log(ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('SMOKE TEST ERROR:', err);
  process.exit(1);
});
