#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORDS = ['amber', 'cobalt', 'falcon', 'juniper', 'lattice', 'marble', 'orchid', 'quartz'];
const PREFERENCES = [
  'I prefer rain at night.',
  'I prefer tea before noon.',
  'I prefer quiet trains to busy buses.',
  'I prefer blue notebooks for technical work.',
];
const DETACHED_SESSION_GRACE_MS = 20_000;

export const DEFAULTS = Object.freeze({
  turns: 30,
  intervalMs: 240_000,
  durationMs: 7_200_000,
  longAwayTurn: 12,
  clientDeathTurn: 20,
  reconnectMinMs: 5_000,
  reconnectMaxMs: 60_000,
  longAwayMs: 90_000,
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function argMap(argv) {
  const out = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const [key, raw = 'true'] = value.slice(2).split(/=(.*)/s, 2);
    out[key] = raw;
  }
  return out;
}

function numberArg(args, key, fallback) {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function iso() {
  return new Date().toISOString();
}

function record(logPath, entry) {
  appendFileSync(logPath, `${JSON.stringify({ at: iso(), ...entry })}\n`, { encoding: 'utf8', flush: true });
}

export function buildSyntheticChunk(turn) {
  const heading = `Document chunk ${String(turn).padStart(3, '0')}: deterministic relay architecture\n`;
  const clauses = [
    'the copper scheduler advances one bounded cursor through a replay-safe ledger',
    'the violet cache records monotonically increasing sequence numbers and rejects duplicate terminals',
    'the cedar gateway preserves one conversation identity while transports detach and return',
    'the orbital compressor summarizes older material without changing the numbered observation',
    'the quartz client distinguishes an acknowledged command from speech actually heard by the user',
    'the amber monitor measures first delta, completion, context growth, and epoch continuity',
  ];
  const lines = [];
  for (let index = 1; lines.join('\n').length < 10_200; index += 1) {
    const clause = clauses[(turn * 7 + index * 11) % clauses.length];
    lines.push(`${turn}.${String(index).padStart(3, '0')} ${clause}; checksum ${turn}-${index}-${(turn * 97 + index * 53) % 10_000}.`);
  }
  return `${heading}${lines.join('\n')}`;
}

export function checkpointForTurn(turn, totalTurns = DEFAULTS.turns) {
  const mapping = new Map([
    [Math.max(2, Math.round(totalTurns * 0.25)), 30],
    [Math.max(2, Math.round(totalTurns * 0.50)), 60],
    [Math.max(2, Math.round(totalTurns * 0.75)), 90],
    [totalTurns, 115],
  ]);
  return mapping.get(turn) ?? null;
}

export function completionDelayMs(startedAt, now, durationMs = DEFAULTS.durationMs) {
  return Math.max(0, startedAt + durationMs - now);
}

export function scoreRecall(text, facts) {
  const result = {
    codeword: String(text).includes(facts.codeword),
    number: String(text).includes(facts.number),
    preference: String(text).includes(facts.preference),
  };
  return { ...result, score: Object.values(result).filter(Boolean).length };
}

export function evaluateReplay({ lastSeen, latestSeq, seqs, truncated, completeCount, expectedEpoch, epoch }) {
  const reasons = [];
  if (!truncated) {
    const seen = new Set(seqs.filter(seq => Number.isInteger(seq) && seq > lastSeen));
    for (let seq = lastSeen + 1; seq <= latestSeq; seq += 1) {
      if (!seen.has(seq)) reasons.push(`seq_gap:${seq}`);
    }
  }
  if (completeCount !== 1) reasons.push(`terminal_count:${completeCount}`);
  if (expectedEpoch && epoch && expectedEpoch !== epoch) reasons.push(`epoch_changed:${expectedEpoch}->${epoch}`);
  return { pass: reasons.length === 0, reasons };
}

function replyParts(reply) {
  const value = reply?.payload ?? reply ?? {};
  const id = value.message_id ?? value.row_id ?? value.id ?? reply?.message_id ?? reply?.row_id ?? reply?.id;
  const text = String(value.text ?? value.content ?? '').trim();
  return { id: id === undefined || id === null ? '' : String(id), text };
}

export function addReplyOnce(accepted, reply) {
  const candidate = replyParts(reply);
  const duplicate = accepted.some(existing => {
    const seen = replyParts(existing);
    return Boolean(candidate.id && seen.id && candidate.id === seen.id) ||
      Boolean(candidate.text && seen.text && candidate.text === seen.text);
  });
  if (duplicate) return false;
  accepted.push(reply);
  return true;
}

function replyAfterPrompt(messages, prompt) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && String(message.text ?? message.content ?? '') === prompt) {
      promptIndex = index;
      break;
    }
  }
  const last = messages.at(-1);
  return promptIndex >= 0 && promptIndex < messages.length - 1 && last?.role === 'assistant'
    ? last
    : null;
}

export function resumeDisposition({
  previousRuntimeId,
  resumed,
  replay,
  lastSeen,
  prompt,
  turn,
  messages = resumed?.messages,
  from = 'resume_messages',
}) {
  const reason = resumed?.session_id !== previousRuntimeId
    ? 'runtime_changed'
    : replay?.truncated
      ? 'truncated'
      : resumed?.running === false
        ? 'not_running'
        : null;
  if (!reason) return { action: 'wait', reply: null, receipt: null };
  const reply = replyAfterPrompt(messages, prompt);
  const receipt = {
    type: 'reconcile',
    turn,
    reason,
    from,
    found_reply: Boolean(reply),
    watermark_ahead: lastSeen > (Number(replay?.latest_seq) || 0),
  };
  return {
    action: reply ? 'complete' : resumed?.running === true ? 'wait' : 'missing',
    reply,
    receipt,
  };
}

export function reconnectAwayBounds(turn, configuredMin, configuredMax) {
  const min = Number(configuredMin);
  const max = Number(configuredMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > 15_000 || max < 30_000) {
    throw new Error('reconnect range must span the 5-15 s and 30-60 s grace buckets');
  }
  const reconnectOrdinal = Math.max(1, Math.round(turn / 3));
  if (reconnectOrdinal % 2 === 1) {
    return { min: Math.max(5_000, min), max: Math.min(15_000, max), grace_side: 'inside' };
  }
  return { min: Math.max(30_000, min), max: Math.min(60_000, max), grace_side: 'outside' };
}

function graceSide(awayMs) {
  return awayMs < DETACHED_SESSION_GRACE_MS ? 'inside' : 'outside';
}

class RpcClient {
  constructor({ baseUrl, token, logPath }) {
    this.url = `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws?token=${encodeURIComponent(token)}`;
    this.logPath = logPath;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.epoch = null;
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('message', event => this.#onMessage(String(event.data)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 20_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket open failed')); }, { once: true });
    });
    return this;
  }

  #onMessage(raw) {
    for (const line of raw.split('\n').filter(Boolean)) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (Object.hasOwn(frame, 'id')) {
        const pending = this.pending.get(String(frame.id));
        if (!pending) continue;
        this.pending.delete(String(frame.id));
        clearTimeout(pending.timer);
        if (frame.error) pending.reject(new Error(`${frame.error.code ?? 'rpc'}: ${frame.error.message ?? 'unknown'}`));
        else pending.resolve(frame.result);
        continue;
      }
      if (frame.method !== 'event' || !frame.params) continue;
      const event = frame.params;
      if (event.type === 'gateway.ready' && event.payload?.replay_epoch) this.epoch = event.payload.replay_epoch;
      for (const listener of this.listeners) listener(event);
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method, params = {}, timeoutMs = 660_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('socket not open'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'soak reconnect');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('socket closed for reconnect'));
    }
    this.pending.clear();
  }
}

function makeFacts() {
  return {
    codeword: WORDS[randomInt(WORDS.length)],
    number: String(randomInt(10_000, 100_000)),
    preference: PREFERENCES[randomInt(PREFERENCES.length)],
  };
}

function promptForTurn(turn, totalTurns, facts) {
  const chunk = buildSyntheticChunk(turn);
  const checkpoint = checkpointForTurn(turn, totalTurns);
  const recall = checkpoint
    ? ' Also return the exact codeword, five-digit number, and preference sentence I planted in turn one.'
    : '';
  const opening = turn === 1
    ? `First answer: What do you remember about me before this message? Do not infer private facts. Then remember these three test facts for later: codeword ${facts.codeword}; number ${facts.number}; preference sentence "${facts.preference}". `
    : '';
  return `${opening}${chunk}\n\nIn one line, what color is named in observation ${turn}.001?${recall}`;
}

function cacheWrite(cachePath, value) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const temp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, cachePath);
}

function cacheRead(cachePath) {
  const value = JSON.parse(readFileSync(cachePath, 'utf8'));
  const exact = { session_id: value.session_id, last_seq: value.last_seq, epoch: value.epoch };
  if (!exact.session_id || !Number.isInteger(exact.last_seq) || !exact.epoch) throw new Error('invalid client cache');
  return exact;
}

function eventText(event) {
  return String(event?.payload?.text ?? '');
}

async function waitForTurn({ client, runtimeId, storedId, prompt, reconnect, awayMs, state, logPath, turn }) {
  const submittedAt = Date.now();
  const observed = new Map();
  let firstDeltaAt = null;
  let completeEvent = null;
  const acceptedReplies = [];
  let disconnected = false;
  let resolveTerminal;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const acceptComplete = event => {
    if (!addReplyOnce(acceptedReplies, event)) return false;
    if (!completeEvent) {
      completeEvent = event;
      resolveTerminal(event);
    }
    return true;
  };
  const consume = event => {
    if (event.session_id !== runtimeId) return;
    if (Number.isInteger(event.seq)) {
      if (observed.has(event.seq)) return;
      observed.set(event.seq, event);
      state.lastSeq = Math.max(state.lastSeq, event.seq);
    }
    if (event.type === 'message.delta' && firstDeltaAt === null) {
      firstDeltaAt = Date.now();
      if (reconnect && !disconnected) {
        disconnected = true;
        client.close();
      }
    }
    if (event.type === 'message.complete') {
      acceptComplete(event);
    }
  };
  let unsubscribe = client.onEvent(consume);
  void client.request('prompt.submit', { session_id: runtimeId, text: prompt }).catch(error => {
    if (!disconnected) record(logPath, { type: 'submit_error', turn, error: error.message });
  });

  let replayReceipt = null;
  if (reconnect) {
    const deltaDeadline = Date.now() + 600_000;
    while (!disconnected && !completeEvent && Date.now() < deltaDeadline) await sleep(25);
    if (disconnected) {
      unsubscribe();
      await sleep(awayMs);
      const lastSeen = state.lastSeq;
      client = await new RpcClient({ baseUrl: state.baseUrl, token: state.token, logPath }).connect();
      const liveAfterReconnect = [];
      unsubscribe = client.onEvent(event => {
        if (event.session_id === runtimeId) liveAfterReconnect.push(event);
        consume(event);
      });
      const previousRuntimeId = runtimeId;
      const resumed = await client.request('session.resume', { session_id: storedId, source: 'soak-long-chat' });
      const runtimeChanged = resumed.session_id !== previousRuntimeId;
      runtimeId = resumed.session_id;
      state.runtimeId = runtimeId;
      const replay = await client.request('session.events.since', { session_id: runtimeId, last_seen: lastSeen });
      if (runtimeChanged) {
        observed.clear();
        state.lastSeq = 0;
      }
      for (const event of replay.events ?? []) consume(event);
      for (const event of liveAfterReconnect) consume(event);
      state.lastSeq = Math.max(state.lastSeq, Number(replay.latest_seq) || 0);
      if (!completeEvent) {
        let disposition = resumeDisposition({ previousRuntimeId, resumed, replay, lastSeen, prompt, turn });
        if (disposition.receipt && !disposition.reply) {
          const history = await client.request('session.history', { session_id: runtimeId }).catch(() => null);
          if (Array.isArray(history?.messages)) {
            disposition = resumeDisposition({
              previousRuntimeId,
              resumed,
              replay,
              lastSeen,
              prompt,
              turn,
              messages: history.messages,
              from: 'session_history',
            });
          }
        }
        if (disposition.receipt) record(logPath, disposition.receipt);
        if (disposition.reply) {
          acceptComplete({
            type: 'message.complete',
            session_id: runtimeId,
            payload: {
              text: disposition.reply.text ?? disposition.reply.content ?? '',
              row_id: disposition.reply.row_id,
              status: 'complete',
              reconciled: true,
            },
          });
        } else if (disposition.action === 'wait' && resumed.running === true) {
          await Promise.race([terminal, sleep(660_000).then(() => { throw new Error('turn terminal timeout after reconnect'); })]);
        } else {
          throw new Error(`turn reply missing after ${disposition.receipt?.reason ?? 'resume'} reconciliation`);
        }
      }
      const seqs = [...observed.keys()].filter(seq => seq > lastSeen).sort((a, b) => a - b);
      const completeCount = acceptedReplies.length;
      replayReceipt = {
        ...evaluateReplay({
          lastSeen,
          latestSeq: replay.latest_seq,
          seqs,
          truncated: Boolean(replay.truncated),
          completeCount,
          expectedEpoch: state.epoch,
          epoch: replay.epoch,
        }),
        turn,
        away_ms: awayMs,
        grace_side: graceSide(awayMs),
        truncated: Boolean(replay.truncated),
        last_seen: lastSeen,
        latest_seq: replay.latest_seq,
        epoch: replay.epoch,
        resume: {
          running: resumed.running,
          inflight: Boolean(resumed.inflight),
          queued: Boolean(resumed.queued),
          message_count: resumed.message_count,
        },
      };
      state.epoch = replay.epoch || state.epoch;
    }
  }
  if (!completeEvent) await Promise.race([terminal, sleep(660_000).then(() => { throw new Error('turn terminal timeout'); })]);
  unsubscribe();
  const usage = completeEvent?.payload?.usage ?? await client.request('session.usage', { session_id: runtimeId }).catch(() => ({}));
  const history = await client.request('session.history', { session_id: runtimeId }).catch(() => ({ count: null }));
  const completeAt = Date.now();
  return {
    client,
    runtimeId,
    text: eventText(completeEvent),
    receipt: {
      type: 'turn',
      t_ms: completeAt - state.startedAt,
      turn,
      first_delta_ms: firstDeltaAt === null ? null : firstDeltaAt - submittedAt,
      complete_ms: completeAt - submittedAt,
      usage,
      message_count: history.count,
      epoch: state.epoch,
      errors: completeEvent?.payload?.status === 'error' ? [completeEvent.payload.error || completeEvent.payload.text || 'turn error'] : [],
    },
    replayReceipt,
  };
}

async function worker(args) {
  const logPath = args.log;
  const cachePath = args.cache;
  const token = process.env.HERMES_SOAK_TOKEN;
  if (!logPath || !cachePath || !token) throw new Error('worker needs --log, --cache, and HERMES_SOAK_TOKEN');
  const turns = numberArg(args, 'turns', DEFAULTS.turns);
  const intervalMs = numberArg(args, 'interval-ms', DEFAULTS.intervalMs);
  const durationMs = numberArg(args, 'duration-ms', DEFAULTS.durationMs);
  const deathTurn = numberArg(args, 'client-death-turn', DEFAULTS.clientDeathTurn);
  const longAwayTurn = numberArg(args, 'long-away-turn', DEFAULTS.longAwayTurn);
  const state = {
    baseUrl: args['base-url'] ?? 'http://127.0.0.1:9318', token,
    startedAt: Number(args['started-at']) || Date.now(), lastSeq: 0, epoch: null, runtimeId: null,
    messageCount: null,
  };
  let storedId;
  let client = await new RpcClient({ baseUrl: state.baseUrl, token, logPath }).connect();
  if (args.phase === 'resume') {
    const cache = cacheRead(cachePath);
    storedId = cache.session_id;
    state.lastSeq = cache.last_seq;
    state.epoch = cache.epoch;
    const resumed = await client.request('session.resume', { session_id: storedId, source: 'soak-long-chat' });
    state.runtimeId = resumed.session_id;
    state.messageCount = resumed.message_count;
    const replay = await client.request('session.events.since', { session_id: state.runtimeId, last_seen: state.lastSeq });
    record(logPath, { type: 'client_death_resume', cache_keys: Object.keys(cache).sort(), resume: { message_count: resumed.message_count, running: resumed.running, inflight: Boolean(resumed.inflight), queued: Boolean(resumed.queued) }, replay: { latest_seq: replay.latest_seq, truncated: replay.truncated, epoch: replay.epoch } });
    state.lastSeq = Math.max(state.lastSeq, Number(replay.latest_seq) || 0);
    state.epoch = replay.epoch || state.epoch;
  } else {
    const facts = makeFacts();
    record(logPath, { type: 'meta', started_at: iso(), turns, interval_ms: intervalMs, model: 'glm-5.3-flash', provider: 'zai', facts, context_engine: process.env.SOAK_CONTEXT_ENGINE || null, context_threshold: process.env.SOAK_CONTEXT_THRESHOLD || null });
    const created = await client.request('session.create', {
      source: 'soak-long-chat', title: `Long chat soak ${iso()}`,
      model: 'glm-5.3-flash', provider: 'zai', close_on_disconnect: false,
    });
    storedId = created.stored_session_id;
    state.runtimeId = created.session_id;
    state.messageCount = created.message_count;
    state.epoch = client.epoch;
    record(logPath, { type: 'session_created', session_id: storedId, runtime_id: state.runtimeId, epoch: state.epoch, model: created.info?.model, provider: created.info?.provider, skills: created.info?.skills ?? null });
    // Facts stay only in JSONL; subsequent phases never load them.
    state.facts = facts;
  }

  const startTurn = numberArg(args, 'start-turn', 1);
  for (let turn = startTurn; turn <= turns; turn += 1) {
    const target = state.startedAt + (turn - 1) * intervalMs;
    if (Date.now() < target) await sleep(target - Date.now());
    const reconnect = turn % 3 === 0;
    let awayMs = 0;
    if (turn === longAwayTurn) {
      awayMs = numberArg(args, 'long-away-ms', DEFAULTS.longAwayMs);
    } else if (reconnect) {
      const bounds = reconnectAwayBounds(
        turn,
        numberArg(args, 'reconnect-min-ms', DEFAULTS.reconnectMinMs),
        numberArg(args, 'reconnect-max-ms', DEFAULTS.reconnectMaxMs),
      );
      awayMs = randomInt(bounds.min, bounds.max + 1);
    }
    // Only phase one owns facts; recall prompts never restate them.
    const prompt = promptForTurn(turn, turns, state.facts ?? { codeword: '', number: '', preference: '' });
    let result = await waitForTurn({ client, runtimeId: state.runtimeId, storedId, prompt, reconnect: reconnect || turn === longAwayTurn, awayMs, state, logPath, turn });
    if (result.receipt.errors.some(error => /\b429\b|rate.?limit/i.test(error))) {
      record(logPath, { type: 'retry', turn, reason: 'zai_429', backoff_ms: 90_000 });
      await sleep(90_000);
      result = await waitForTurn({ client: result.client, runtimeId: result.runtimeId, storedId, prompt, reconnect: false, awayMs: 0, state, logPath, turn });
    }
    client = result.client;
    state.runtimeId = result.runtimeId;
    if (Number.isInteger(result.receipt.message_count)) {
      result.receipt.message_count_monotonic = state.messageCount === null || result.receipt.message_count >= state.messageCount;
      if (!result.receipt.message_count_monotonic) result.receipt.errors.push(`message_count_regressed:${state.messageCount}->${result.receipt.message_count}`);
      state.messageCount = result.receipt.message_count;
    }
    record(logPath, result.receipt);
    if (result.replayReceipt) record(logPath, { type: 'reconnect', ...result.replayReceipt });
    if (turn === 1) {
      const leoMarkers = ['StrongYes', 'Snowcubes', 'Resplit', 'Pickles', 'US Open'];
      record(logPath, { type: 'isolation', pass: !leoMarkers.some(marker => result.text.includes(marker)), matched_markers: leoMarkers.filter(marker => result.text.includes(marker)), answer: result.text });
    }
    if (checkpointForTurn(turn, turns)) {
      const meta = state.facts ? scoreRecall(result.text, state.facts) : null;
      record(logPath, { type: 'recall_response', turn, checkpoint_minute: checkpointForTurn(turn, turns), response: result.text, local_score_available: Boolean(meta), ...(meta ?? {}) });
    }
    cacheWrite(cachePath, { session_id: storedId, last_seq: state.lastSeq, epoch: state.epoch });
    if (turn === deathTurn && args.phase !== 'resume' && turn < turns) {
      record(logPath, { type: 'client_death', turn, action: 'worker_exit_after_cache_flush' });
      client.close();
      process.exit(75);
    }
  }
  const finalDelay = completionDelayMs(state.startedAt, Date.now(), durationMs);
  if (finalDelay > 0) await sleep(finalDelay);
  client.close();
  record(logPath, { type: 'complete', turns, completed_at: iso(), session_id: storedId, last_seq: state.lastSeq, epoch: state.epoch });
}

function spawnWorker(args, phase, startTurn) {
  const forwarded = Object.entries(args)
    .filter(([key]) => !['worker', 'phase', 'start-turn'].includes(key))
    .map(([key, value]) => `--${key}=${value}`);
  const childArgs = [fileURLToPath(import.meta.url), '--worker=true', `--phase=${phase}`, ...forwarded];
  if (startTurn) childArgs.push(`--start-turn=${startTurn}`);
  return spawn(process.execPath, childArgs, { env: process.env, stdio: 'inherit' });
}

async function controller(args) {
  if (!args.log || !args.cache) throw new Error('controller needs --log and --cache');
  mkdirSync(path.dirname(args.log), { recursive: true });
  const startedAt = Date.now();
  args['started-at'] = String(startedAt);
  record(args.log, { type: 'controller_start', pid: process.pid, started_at: iso() });
  const initial = spawnWorker(args, 'initial');
  const initialCode = await new Promise(resolve => initial.once('exit', code => resolve(code ?? 1)));
  if (initialCode !== 75) {
    record(args.log, { type: 'controller_error', phase: 'initial', exit_code: initialCode });
    process.exitCode = initialCode;
    return;
  }
  const nextTurn = numberArg(args, 'client-death-turn', DEFAULTS.clientDeathTurn) + 1;
  const resumed = spawnWorker(args, 'resume', nextTurn);
  const resumedCode = await new Promise(resolve => resumed.once('exit', code => resolve(code ?? 1)));
  if (resumedCode !== 0) {
    record(args.log, { type: 'controller_error', phase: 'resume', exit_code: resumedCode });
    process.exitCode = resumedCode;
  }
}

async function main() {
  const args = argMap(process.argv.slice(2));
  await (args.worker === 'true' ? worker(args) : controller(args));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const args = argMap(process.argv.slice(2));
    if (args.log) record(args.log, { type: 'fatal', error: error.stack || error.message });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
