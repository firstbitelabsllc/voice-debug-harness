// E2E: real spoken WAV -> voice-debug-harness mic feed -> Chromium getUserMedia
// -> WebRTC -> OpenAI live -> delegation -> Hermes answer, against the loopback
// voice page (9211 proxy -> 9317 auth-free serve).
// Harness: firstbitelabsllc/voice-debug-harness (same audio, every test).
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { installMicFeed, feedAudio, fakeDeviceArgs, measureWavEnergy } from './index.mjs';

const PAGE_URL = 'http://127.0.0.1:9211/';
const WAV_PATH = '/tmp/voice-e2e.wav';

const wav = await readFile(WAV_PATH);
const energy = measureWavEnergy(wav);
console.log('fixture energy:', JSON.stringify(energy));
if (!energy || !(energy.rms > 0.02)) {
  console.error('E2E FAIL: fixture too quiet to be speech');
  process.exit(1);
}

const consoleLines = [];
const browser = await chromium.launch({
  args: fakeDeviceArgs(),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => { const t = msg.text(); if (t.includes('[voice]')) consoleLines.push(t.slice(0, 120)); });

  // The serve authenticates API calls with its desktop-ssh session token as
  // Bearer; the page's own fetches use same-origin credentials, so the harness
  // injects the header on every /api route (the WS hop authenticates with its
  // ticket instead).
  const TOKEN = (await readFile('/tmp/vh-token-value', 'utf8')).trim();
  await page.route('**/api/**', async (route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${TOKEN}` };
    await route.continue({ headers });
  });

  // The Python proxy cannot tunnel WebSocket upgrades; rewrite the page's
  // delegation hop straight at the backend — what the prod same-origin FQDN
  // routing does implicitly through tailscale serve.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    const Patched = function (url, protocols) {
      const rewritten = typeof url === 'string'
        ? url.replace('://127.0.0.1:9211/', '://127.0.0.1:9317/')
        : url;
      return protocols === undefined ? new Real(rewritten) : new Real(rewritten, protocols);
    };
    Patched.prototype = Real.prototype;
    Patched.CONNECTING = 0; Patched.OPEN = 1; Patched.CLOSING = 2; Patched.CLOSED = 3;
    window.WebSocket = Patched;
  });

  await installMicFeed(page); // BEFORE navigation — same audio, every test
  await page.goto(PAGE_URL, { waitUntil: 'load' });

  await page.getByRole('button', { name: 'Connect' }).click();

  await page.waitForFunction(
    () => (document.getElementById('state')?.textContent || '').includes('Live'),
    null, { timeout: 60000 }
  );
  console.log('LIVE: session up');

  // Tap the mic graph to MEASURE what the page's stream actually carries —
  // the harness exposes __micCtx/__micDest for exactly this.
  const tapInfo = await page.evaluate(() => {
    const ctx = window.__micCtx, dest = window.__micDest;
    if (!ctx || !dest) return { ok: false, why: 'no mic graph' };
    if (ctx.state === 'suspended') ctx.resume();
    const an = ctx.createAnalyser();
    // MediaStreamDestinationNode has zero audio outputs — tap its STREAM
    // through a MediaStreamAudioSourceNode instead.
    const src = ctx.createMediaStreamSource(dest.stream);
    src.connect(an);
    window.__rmsTap = { an, data: new Float32Array(an.fftSize) };
    return { ok: true, ctxState: ctx.state };
  });
  console.log('TAP:', JSON.stringify(tapInfo));
  const sampleRms = () => page.evaluate(() => {
    const t = window.__rmsTap; if (!t) return null;
    t.an.getFloatTimeDomainData(t.data);
    let sum = 0; for (const v of t.data) sum += v * v;
    return Math.sqrt(sum / t.data.length);
  });
  console.log('PRE-FEED RMS:', await sampleRms());

  await feedAudio(page, wav);
  console.log('FED: spoken WAV through the mic');
  for (let i = 1; i <= 4; i++) {
    await new Promise(r => setTimeout(r, 1000));
    console.log(`POST-FEED RMS ${i}s:`, await sampleRms());
  }
  await feedAudio(page, wav);
  console.log('FED: second pass');

  // The spoken request routes a delegation; Hermes' answer lands in the caption.
  await page.waitForFunction(
    () => {
      const st = document.getElementById('state')?.textContent || '';
      const cap = document.getElementById('caption')?.textContent || '';
      return st.includes('Live') && cap.trim() !== '' && cap !== 'Full-duplex voice to your Hermes.';
    },
    null, { timeout: 240000 }
  );
  const caption = await page.evaluate(() => document.getElementById('caption').textContent.trim());
  console.log('ANSWER:', caption.slice(0, 240));

  await browser.close();
  console.log('E2E PASS');
} catch (err) {
  let snapshot = '';
  try {
    snapshot = await page.evaluate(() => JSON.stringify({
      state: document.getElementById('state')?.textContent,
      caption: (document.getElementById('caption')?.textContent || '').slice(0, 200),
      detail: (document.getElementById('detail')?.textContent || '').slice(0, 200),
    }));
  } catch (_) {}
  console.error('E2E FAIL:', err.message, snapshot || '');
  console.error('EVENTS:', consoleLines.slice(-40).join(' | '));
  await browser.close();
  process.exit(1);
}
