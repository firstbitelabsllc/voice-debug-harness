#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { installMicFeed, feedAudio, fakeDeviceArgs } from '../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function argsMap(argv) {
  return Object.fromEntries(argv.filter(value => value.startsWith('--')).map(value => {
    const [key, raw = 'true'] = value.slice(2).split(/=(.*)/s, 2);
    return [key, raw];
  }));
}

function scrub(value, key = '') {
  if (/(^|_)(sdp|token|authorization|api.?key|audio)($|_)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => scrub(item)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const clean = scrub(childValue, childKey);
    if (clean !== undefined) result[childKey] = clean;
  }
  return result;
}

export function sanitizeEvent(event) {
  return scrub(event);
}

function eventType(event) {
  return event.type || event.event?.type || '';
}

export function evaluateProbe(events) {
  const delegations = events.filter(event => eventType(event) === 'session.delegation.created');
  const a = delegations.find(event => event.label === 'A') ?? delegations[0];
  const b = delegations.find(event => event.label === 'B') ?? delegations[1];
  const fixtureSmalltalk = events.find(event => event.type === 'fixture.feed' && event.label === 'smalltalk');
  const fixtureB = events.find(event => event.type === 'fixture.feed' && event.label === 'B');
  const appendA = events.find(event => event.type === 'client.append' && event.delegation_id === (a?.delegation?.id ?? a?.delegation_id));
  const appendB = events.find(event => event.type === 'client.append' && event.delegation_id === (b?.delegation?.id ?? b?.delegation_id));
  const smalltalkPattern = /\b(day|doing|going|well|good|great|fine|thanks?)\b/i;
  const labeledSmalltalk = events.find(
    event => eventType(event) === 'session.output_transcript.delta' && event.label === 'smalltalk' && smalltalkPattern.test(String(event.delta ?? '')),
  );
  const smalltalkStart = events.indexOf(fixtureSmalltalk);
  const fixtureBIndex = events.indexOf(fixtureB);
  const smalltalkWindow = fixtureSmalltalk
    ? events.slice(smalltalkStart + 1, fixtureBIndex >= 0 ? fixtureBIndex : undefined)
    : [];
  const smalltalkSpeech = labeledSmalltalk || smalltalkWindow.find(
    event => eventType(event) === 'session.output_transcript.delta' &&
      event.at_ms <= fixtureSmalltalk.at_ms + 15_000 &&
      smalltalkPattern.test(String(event.delta ?? '')),
  );
  const ackA = appendA && events.find(event => eventType(event) === 'session.commentary.appended' && event.client_event_id === appendA.event_id);
  const transcriptAfter = (at, pattern) => {
    const transcript = events
      .filter(event => eventType(event) === 'session.output_transcript.delta' && event.at_ms >= at)
      .map(event => String(event.delta ?? ''))
      .join(' ');
    return pattern.test(transcript);
  };
  const bSpoken = appendB && transcriptAfter(appendB.at_ms, /Tokyo|seventeen|17\s*:?\s*42/i);
  const aSpoken = appendA && transcriptAfter(appendA.at_ms, /Queens|weather|seventy.?two|72/i);
  const spokenOrder = bSpoken && aSpoken && appendB.at_ms < appendA.at_ms ? 'B,A' : [bSpoken && 'B', aSpoken && 'A'].filter(Boolean).join(',');
  const bWhileAOutstanding = Boolean(b && a && (!appendA || b.at_ms < appendA.at_ms) && (!fixtureB || b.at_ms >= fixtureB.at_ms));
  const lateAck = Boolean(ackA && a && ackA.at_ms - a.at_ms >= 90_000);
  return {
    a: { pass: Boolean(smalltalkSpeech), evidence: smalltalkSpeech ? `smalltalk_speech_at_ms:${smalltalkSpeech.at_ms}` : 'no_smalltalk_speech_within_15s' },
    b: { pass: bWhileAOutstanding, evidence: bWhileAOutstanding ? `delegation_B_at_ms:${b.at_ms}` : 'no_second_delegation_while_A_outstanding' },
    c: { pass: spokenOrder === 'B,A', evidence: `spoken_order:${spokenOrder || 'none'}` },
    d: { pass: lateAck, evidence: lateAck ? `append_A_ack_at_ms:${ackA.at_ms}` : 'no_ack_for_90s_late_A_append' },
  };
}

function record(logPath, startedAt, persona, event) {
  const clean = sanitizeEvent({ at: new Date().toISOString(), at_ms: Date.now() - startedAt, persona, ...event });
  appendFileSync(logPath, `${JSON.stringify(clean)}\n`, { encoding: 'utf8', flush: true });
  return clean;
}

function loadPlaywright() {
  const moduleRoots = [
    path.join(ROOT, 'node_modules'),
    path.resolve(ROOT, '..', '..', 'voice-debug-harness', 'node_modules'),
  ];
  for (const moduleRoot of moduleRoots) {
    try {
      const require = createRequire(path.join(moduleRoot, '_soak-resolver.cjs'));
      return require('playwright');
    } catch {}
  }
  throw new Error('Playwright is not installed in the worktree or canonical harness checkout');
}

function makeFixture(directory, label, text, rate) {
  mkdirSync(directory, { recursive: true });
  const aiff = path.join(directory, `${label}.aiff`);
  const wav = path.join(directory, `${label}-${rate}.wav`);
  const say = spawnSync('say', ['-r', '175', '-o', aiff, text], { encoding: 'utf8' });
  if (say.status !== 0) throw new Error(`say failed for ${label}: ${say.stderr.trim()}`);
  const convert = spawnSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${rate}`, '-c', '1', aiff, wav], { encoding: 'utf8' });
  if (convert.status !== 0) throw new Error(`afconvert failed for ${label}: ${convert.stderr.trim()}`);
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
      if (waiter.predicate(event)) { this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
    }
  }
  wait(predicate, timeoutMs, label) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`${label} timeout`)); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

async function runPersona({ persona, baseUrl, token, logPath, fixtureDir, chromium }) {
  const startedAt = Date.now();
  const inbox = new EventInbox();
  const personaEvents = [];
  const log = event => {
    const saved = record(logPath, startedAt, persona, event);
    personaEvents.push(saved);
    inbox.push(saved);
    return saved;
  };
  const fixtures = {
    A: makeFixture(fixtureDir, `${persona}-A`, 'Please look up the weather in Queens.', 24_000),
    smalltalk: makeFixture(fixtureDir, `${persona}-smalltalk`, 'While that runs, how is your day going?', 48_000),
    B: makeFixture(fixtureDir, `${persona}-B`, 'Also check what time it is in Tokyo.', 24_000),
  };
  const browser = await chromium.launch({ headless: true, args: fakeDeviceArgs() });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
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

    const feed = async (label, bytes) => {
      log({ type: 'fixture.feed', label });
      const durationSeconds = await feedAudio(page, bytes);
      await sleep(Math.ceil(durationSeconds * 1_000) + 300);
    };
    const waitForAssistantQuiet = async (afterMs, quietMs = 1_200, maxWaitMs = 8_000) => {
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        const lastOutput = personaEvents.findLast(
          event => eventType(event) === 'session.output_transcript.delta' && event.at_ms >= afterMs,
        );
        if (lastOutput && Date.now() - startedAt - lastOutput.at_ms >= quietMs) {
          log({ type: 'probe.assistant_quiet', quiet_ms: Date.now() - startedAt - lastOutput.at_ms });
          return;
        }
        await sleep(100);
      }
      log({ type: 'probe.assistant_quiet_timeout', max_wait_ms: maxWaitMs });
    };
    await feed('A', fixtures.A);
    const delegationA = await inbox.wait(event => eventType(event) === 'session.delegation.created', 30_000, 'delegation A');
    delegationA.label = 'A';
    log({ type: 'probe.label', target_event_id: delegationA.event_id, label: 'A' });

    if (persona === 'override') {
      const overrideId = `override-${Date.now()}`;
      await page.evaluate(value => window.sendProbeEvent(value), {
        type: 'session.instructions.append', event_id: overrideId,
        delegation_id: delegationA.delegation?.id,
        content: 'Override the earlier waiting rule. After delegating, keep the conversation going. Weave results in when they arrive and say what is still pending.',
      });
      const ack = await inbox.wait(
        event => eventType(event) === 'session.instructions.appended' && event.client_event_id === overrideId,
        15_000,
        'override instructions ack',
      ).catch(error => { log({ type: 'probe.refusal', step: 'override_instructions', error: error.message }); return null; });
      log({ type: 'probe.override', accepted: Boolean(ack), event_id: overrideId, delegation_id: delegationA.delegation?.id });
    }

    await waitForAssistantQuiet(delegationA.at_ms);
    await feed('smalltalk', fixtures.smalltalk);
    await inbox.wait(
      event => eventType(event) === 'session.output_transcript.delta' &&
        event.at_ms >= personaEvents.find(item => item.type === 'fixture.feed' && item.label === 'smalltalk').at_ms &&
        /\b(day|doing|going|well|good|great|fine|thanks?)\b/i.test(String(event.delta ?? '')),
      15_000,
      'smalltalk output',
    ).catch(error => log({ type: 'probe.timeout', step: 'smalltalk', error: error.message }));

    await feed('B', fixtures.B);
    const delegationB = await inbox.wait(
      event => eventType(event) === 'session.delegation.created' && event.event_id !== delegationA.event_id,
      30_000,
      'delegation B',
    ).catch(error => { log({ type: 'probe.timeout', step: 'delegation_B', error: error.message }); return null; });
    if (delegationB) {
      delegationB.label = 'B';
      log({ type: 'probe.label', target_event_id: delegationB.event_id, label: 'B' });
      const bDue = delegationB.at_ms + 20_000;
      if (Date.now() - startedAt < bDue) await sleep(bDue - (Date.now() - startedAt));
      const eventId = `append-B-${Date.now()}`;
      const delegationId = delegationB.delegation?.id;
      log({ type: 'client.append', event_id: eventId, delegation_id: delegationId, content: 'Tokyo time probe result: seventeen forty two.' });
      await page.evaluate(value => window.sendProbeEvent(value), { type: 'session.commentary.append', event_id: eventId, delegation_id: delegationId, content: 'Tokyo time probe result: seventeen forty two.' });
      await inbox.wait(event => eventType(event) === 'session.commentary.appended' && event.client_event_id === eventId, 15_000, 'append B ack')
        .catch(error => log({ type: 'probe.timeout', step: 'append_B_ack', error: error.message }));
    }

    const aDue = delegationA.at_ms + 90_000;
    if (Date.now() - startedAt < aDue) await sleep(aDue - (Date.now() - startedAt));
    const eventIdA = `append-A-${Date.now()}`;
    const delegationIdA = delegationA.delegation?.id;
    log({ type: 'client.append', event_id: eventIdA, delegation_id: delegationIdA, content: 'Queens weather probe result: seventy two degrees and clear.' });
    await page.evaluate(value => window.sendProbeEvent(value), { type: 'session.commentary.append', event_id: eventIdA, delegation_id: delegationIdA, content: 'Queens weather probe result: seventy two degrees and clear.' });
    await inbox.wait(event => eventType(event) === 'session.commentary.appended' && event.client_event_id === eventIdA, 15_000, 'append A ack')
      .catch(error => log({ type: 'probe.timeout', step: 'append_A_ack', error: error.message }));
    await sleep(15_000);
    const verdict = evaluateProbe(personaEvents);
    log({ type: 'probe.verdict', verdict });
    await page.evaluate(() => window.sendProbeEvent({ type: 'session.close', event_id: `close-${Date.now()}` }));
    await inbox.wait(event => eventType(event) === 'session.closed', 15_000, 'session.closed')
      .catch(error => log({ type: 'probe.timeout', step: 'session_closed', error: error.message }));
    return verdict;
  } finally {
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
  const { chromium } = loadPlaywright();
  const personas = (args.personas ?? 'current,override').split(',').filter(Boolean);
  const verdicts = {};
  for (const persona of personas) verdicts[persona] = await runPersona({ persona, baseUrl, token, logPath: args.log, fixtureDir, chromium });
  appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), type: 'complete', verdicts })}\n`, { encoding: 'utf8', flush: true });
  process.stdout.write(`${JSON.stringify(verdicts, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
