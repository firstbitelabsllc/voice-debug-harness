#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installMicFeed, feedAudio, fakeDeviceArgs } from '../index.mjs';
import { sanitizeEvent } from './main-thread-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const eventType = event => event.type || event.event?.type || '';

function argsMap(argv) {
  return Object.fromEntries(argv.filter(value => value.startsWith('--')).map(value => {
    const [key, raw = 'true'] = value.slice(2).split(/=(.*)/s, 2);
    return [key, raw];
  }));
}

function record(logPath, startedAt, cell, event) {
  const clean = sanitizeEvent({ at: new Date().toISOString(), at_ms: Date.now() - startedAt, cell, ...event });
  appendFileSync(logPath, `${JSON.stringify(clean)}\n`, { encoding: 'utf8', flush: true });
  return clean;
}

function loadPlaywright() {
  for (const moduleRoot of [path.join(ROOT, 'node_modules'), path.resolve(ROOT, '..', '..', 'voice-debug-harness', 'node_modules')]) {
    try {
      return createRequire(path.join(moduleRoot, '_soak-resolver.cjs'))('playwright');
    } catch {}
  }
  throw new Error('Playwright is not installed in the worktree or canonical harness checkout');
}

function makeFixture(directory) {
  mkdirSync(directory, { recursive: true });
  const aiff = path.join(directory, 'commentary-weather.aiff');
  const wav = path.join(directory, 'commentary-weather-24000.wav');
  const say = spawnSync('say', ['-r', '165', '-o', aiff, 'Please look up the weather in Queens.'], { encoding: 'utf8' });
  if (say.status !== 0) throw new Error(`say failed: ${say.stderr.trim()}`);
  const convert = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, wav], { encoding: 'utf8' });
  if (convert.status !== 0) throw new Error(`afconvert failed: ${convert.stderr.trim()}`);
  return readFileSync(wav);
}

class EventInbox {
  constructor() {
    this.events = [];
    this.waiters = new Set();
  }
  push(event) {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  }
  wait(predicate, timeoutMs, label) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${label} timeout`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

async function runCell({ cell, delayMs, thinkingFirst, roomNoise, referenceShape = false, baseUrl, token, logPath, fixtureDir, chromium }) {
  const startedAt = Date.now();
  const inbox = new EventInbox();
  const events = [];
  const log = event => {
    const saved = record(logPath, startedAt, cell, event);
    events.push(saved);
    inbox.push(saved);
    return saved;
  };
  const fixture = makeFixture(fixtureDir);
  const browser = await chromium.launch({ headless: true, args: fakeDeviceArgs() });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  let statsTimer;
  try {
    await installMicFeed(page);
    await page.exposeFunction('recordProbeEvent', value => log(value));
    await page.exposeFunction('exchangeSdp', async sdp => {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/audio/voice-live/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!response.ok) throw new Error(`voice-live session refused ${response.status}: ${(await response.text()).slice(0, 240)}`);
      return response.json();
    });
    await page.goto(pathToFileURL(path.join(HERE, 'main-thread-probe.html')).href);
    const session = await page.evaluate(() => window.startProbe());
    log({ type: 'probe.session', session_id: session.session_id, browser: browser.version() });
    await inbox.wait(event => eventType(event) === 'session.started', 30_000, 'session.started');

    const sampleStats = async () => {
      try {
        const stats = await page.evaluate(() => window.sampleOutboundAudioStats());
        log({ type: 'rtc.outbound_rtp', ...(stats ?? { packets_sent: null, bytes_sent: null }) });
      } catch (error) {
        log({ type: 'rtc.stats_error', error: error.message });
      }
    };
    await sampleStats();
    statsTimer = setInterval(sampleStats, 2_000);

    log({ type: 'fixture.feed', text: 'Please look up the weather in Queens.' });
    const fixtureSeconds = await feedAudio(page, fixture);
    await sleep(Math.ceil(fixtureSeconds * 1_000) + 300);
    const delegation = await inbox.wait(event => eventType(event) === 'session.delegation.created', 30_000, 'delegation');
    const delegationId = delegation.delegation?.id;
    log({ type: 'probe.delegation', delegation_id: delegationId });

    if (roomNoise) {
      await page.evaluate(() => window.startProbeRoomNoise());
      log({ type: 'probe.room_noise.started', rms_target: 0.00046 });
    }

    if (thinkingFirst) {
      await sleep(1_000);
      const thinkingId = `thinking-${cell}-${Date.now()}`;
      const thinking = referenceShape ? {
        content: 'The weather lookup is still in progress.',
        delegation_id: delegationId,
        event_id: 'think_1',
        type: 'session.thinking.append',
      } : {
        type: 'session.thinking.append',
        event_id: thinkingId,
        delegation_id: delegationId,
        content: 'The weather lookup is still in progress.',
      };
      log({ type: 'client.append', append_kind: 'thinking', append_event: thinking.type, event_id: thinking.event_id, delegation_id: thinking.delegation_id, content: thinking.content });
      await page.evaluate(value => window.sendProbeEvent(value), thinking);
    }

    const elapsedSinceDelegation = Date.now() - startedAt - delegation.at_ms;
    if (elapsedSinceDelegation < delayMs) await sleep(delayMs - elapsedSinceDelegation);
    const eventId = `commentary-${cell}-${Date.now()}`;
    const append = referenceShape ? {
      content: 'Queens is seventy-two degrees and clear.',
      delegation_id: delegationId,
      event_id: 'say_2',
      type: 'session.commentary.append',
    } : {
      type: 'session.commentary.append',
      event_id: eventId,
      delegation_id: delegationId,
      content: 'Queens is seventy-two degrees and clear.',
    };
    const commentaryEventId = append.event_id;
    const appendRecord = log({ type: 'client.append', append_kind: 'commentary', append_event: append.type, event_id: commentaryEventId, delegation_id: append.delegation_id, content: append.content });
    await page.evaluate(value => window.sendProbeEvent(value), append);

    await sleep(60_000);
    await page.evaluate(() => window.sendProbeEvent({ type: 'session.close', event_id: `close-${Date.now()}` }));
    await inbox.wait(event => eventType(event) === 'session.closed', 15_000, 'session.closed').catch(error => log({ type: 'probe.timeout', step: 'session.closed', error: error.message }));
    await sleep(500);

    const ack = events.find(event => eventType(event) === 'session.commentary.appended' && event.client_event_id === commentaryEventId);
    const errors = events.filter(event => eventType(event) === 'error' && event.error?.client_event_id === commentaryEventId);
    const spoken = events
      .filter(event => eventType(event) === 'session.output_transcript.delta' && event.at_ms >= appendRecord.at_ms)
      .map(event => String(event.delta ?? ''))
      .join('')
      .trim();
    const stats = events.filter(event => event.type === 'rtc.outbound_rtp' && Number.isFinite(event.packets_sent));
    const packetsFlowing = stats.length >= 2 && stats.at(-1).packets_sent > stats[0].packets_sent;
    const summary = {
      type: 'probe.summary',
      append_event_id: commentaryEventId,
      ack_ms: ack ? ack.at_ms - appendRecord.at_ms : null,
      spoken_text_after_append: spoken,
      errors: errors.map(event => event.error),
      packets_flowing: packetsFlowing,
      first_packets_sent: stats[0]?.packets_sent ?? null,
      last_packets_sent: stats.at(-1)?.packets_sent ?? null,
      first_bytes_sent: stats[0]?.bytes_sent ?? null,
      last_bytes_sent: stats.at(-1)?.bytes_sent ?? null,
    };
    log(summary);
    return summary;
  } finally {
    clearInterval(statsTimer);
    await page.evaluate(() => window.stopProbe()).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = argsMap(process.argv.slice(2));
  const token = process.env.HERMES_SOAK_TOKEN;
  if (!token || !args.log) throw new Error('HERMES_SOAK_TOKEN and --log are required');
  const baseUrl = args['base-url'] ?? 'http://127.0.0.1:9318';
  const fixtureDir = args['fixture-dir'] ?? path.join(path.dirname(args.log), 'fixtures');
  const selected = (args.cells ?? '1,2,3,4').split(',');
  const definitions = {
    '1': { delayMs: 1_000, thinkingFirst: false, roomNoise: false },
    '2': { delayMs: 8_000, thinkingFirst: false, roomNoise: false },
    '3': { delayMs: 8_000, thinkingFirst: true, roomNoise: false },
    '4': { delayMs: 8_000, thinkingFirst: false, roomNoise: true },
    '5': { delayMs: 8_000, thinkingFirst: true, roomNoise: true, referenceShape: true },
  };
  const { chromium } = loadPlaywright();
  const summaries = [];
  for (const cell of selected) {
    if (!definitions[cell]) throw new Error(`unknown cell ${cell}`);
    summaries.push(await runCell({ cell, ...definitions[cell], baseUrl, token, logPath: args.log, fixtureDir, chromium }));
  }
  appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), type: 'complete', summaries })}\n`, { encoding: 'utf8', flush: true });
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const logPath = argsMap(process.argv.slice(2)).log;
    if (logPath) {
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), type: 'fatal', error: error.message })}\n`, { encoding: 'utf8', flush: true });
    }
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
