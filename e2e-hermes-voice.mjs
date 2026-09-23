// E2E: real spoken WAV -> voice-debug-harness mic feed -> Chromium getUserMedia
// -> WebRTC -> OpenAI live -> delegation -> Hermes answer, against the loopback
// voice page (9211 proxy -> 9317 auth-free serve).
// Harness: firstbitelabsllc/voice-debug-harness (same audio, every test).
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { installMicFeed, feedAudio, fakeDeviceArgs, measureWavEnergy } from './index.mjs';

const PAGE_URL = 'http://127.0.0.1:9211/';
const WAV_PATH = '/tmp/voice-e2e.wav';

const STARTED_AT = Date.now();
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
  // The ws-ticket needs a browser dashboard session. The harness's loopback
  // serve runs HERMES_DESKTOP=1 with a session token, which the WS accepts as
  // the legacy ?token= (the Desktop-owned loopback path), so the harness
  // stands in for the ticket and swaps it for the token on the upgrade.
  await page.route('**/api/auth/ws-ticket', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
                    body: JSON.stringify({ ticket: 'harness', ttl_seconds: 30 }) }));
  await page.addInitScript((tok) => {
    const Real = window.WebSocket;
    const Patched = function (url, protocols) {
      const rewritten = typeof url === 'string'
        ? url.replace('://127.0.0.1:9211/', '://127.0.0.1:9317/')
             .replace('ticket=harness', 'token=' + encodeURIComponent(tok))
        : url;
      return protocols === undefined ? new Real(rewritten) : new Real(rewritten, protocols);
    };
    Patched.prototype = Real.prototype;
    Patched.CONNECTING = 0; Patched.OPEN = 1; Patched.CLOSING = 2; Patched.CLOSED = 3;
    window.WebSocket = Patched;
  }, TOKEN);

  await installMicFeed(page); // BEFORE navigation — same audio, every test
  await page.goto(PAGE_URL, { waitUntil: 'load' });

  await page.getByRole('button', { name: 'Start talking' }).click();

  await page.waitForFunction(
    () => document.body.dataset.state === 'live',
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

  // The real contract: the spoken turns are SAVED as one Hermes session that
  // shows in the sidebar — asserted against the session store, not the DOM.
  const { execFileSync } = await import('node:child_process');
  const db = `file:${process.env.HOME}/.hermes/state.db?mode=ro`;
  const q = (sql) => execFileSync('sqlite3', ['-separator', '|', db, sql]).toString().trim();
  const since = Math.floor(STARTED_AT / 1000);
  let row = '';
  for (let i = 0; i < 80 && !row; i++) {
    row = q(`SELECT id, message_count FROM sessions WHERE source='voice-safari' AND started_at >= ${since} AND message_count >= 2 ORDER BY started_at DESC LIMIT 1;`);
    if (!row) await new Promise(r => setTimeout(r, 3000));
  }
  if (!row) throw new Error('no saved voice-safari session with a completed turn');
  const [sid, count] = row.split('|');
  const sessions = q(`SELECT COUNT(*) FROM sessions WHERE source='voice-safari' AND started_at >= ${since};`);
  const reply = q(`SELECT substr(replace(content,char(10),' '),1,200) FROM messages WHERE session_id='${sid}' AND role='assistant' ORDER BY id DESC LIMIT 1;`);
  console.log(`SAVED: session ${sid} messages=${count} voice-sessions-this-run=${sessions}`);
  console.log('HERMES REPLY:', reply);
  if (sessions !== '1') throw new Error(`expected ONE persistent voice session, got ${sessions}`);
  // The saved user row is the whole spoken request, not one streamed delta.
  const userRow = q(`SELECT content FROM messages WHERE session_id='${sid}' AND role='user' ORDER BY id LIMIT 1;`);
  console.log('SAVED USER TURN:', userRow.slice(0, 160));
  if (!/shadow|board/i.test(userRow)) throw new Error(`user turn is a fragment, not the utterance: "${userRow}"`);

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
