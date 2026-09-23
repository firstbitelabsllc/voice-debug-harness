import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addReplyOnce,
  buildSyntheticChunk,
  checkpointForTurn,
  completionDelayMs,
  evaluateReplay,
  reconnectAwayBounds,
  resumeDisposition,
  scoreRecall,
} from './long-chat.mjs';
import { summarize } from './report.mjs';
import { evaluateProbe, sanitizeEvent } from './main-thread-probe.mjs';

describe('long-chat soak helpers', () => {
  it('builds a deterministic numbered chunk large enough to pressure context', () => {
    const first = buildSyntheticChunk(7);
    const second = buildSyntheticChunk(7);

    assert.equal(first, second);
    assert.match(first, /^Document chunk 007:/);
    assert.ok(first.length >= 9_000, `chunk was only ${first.length} characters`);
  });

  it('maps the four requested recall checkpoints to the 30-turn schedule', () => {
    assert.deepEqual(
      [8, 15, 23, 30].map(turn => checkpointForTurn(turn, 30)),
      [30, 60, 90, 115],
    );
    assert.equal(checkpointForTurn(14, 30), null);
  });

  it('holds the completion record until the full requested duration', () => {
    assert.equal(completionDelayMs(1_000, 6_000, 10_000), 5_000);
    assert.equal(completionDelayMs(1_000, 12_000, 10_000), 0);
  });

  it('scores planted facts by exact value without accepting partial recall', () => {
    const facts = { codeword: 'opal', number: '48291', preference: 'I prefer rain at night.' };
    assert.deepEqual(scoreRecall('opal 48291 I prefer rain at night.', facts), {
      codeword: true,
      number: true,
      preference: true,
      score: 3,
    });
    assert.equal(scoreRecall('opal and 4829', facts).score, 1);
  });

  it('rejects replay gaps, duplicate terminal events, and epoch changes', () => {
    assert.deepEqual(
      evaluateReplay({ lastSeen: 10, latestSeq: 13, seqs: [11, 12, 13], truncated: false, completeCount: 1, expectedEpoch: 'e1', epoch: 'e1' }),
      { pass: true, reasons: [] },
    );
    assert.deepEqual(
      evaluateReplay({ lastSeen: 10, latestSeq: 13, seqs: [11, 13], truncated: false, completeCount: 2, expectedEpoch: 'e1', epoch: 'e2' }).reasons,
      ['seq_gap:12', 'terminal_count:2', 'epoch_changed:e1->e2'],
    );
  });

  it('reconciles a completed reply from resume messages when the runtime changed and replay is empty', () => {
    const prompt = 'Which color is named?';
    const result = resumeDisposition({
      previousRuntimeId: 'runtime-old',
      resumed: {
        session_id: 'runtime-new',
        running: false,
        messages: [
          { role: 'user', text: prompt, row_id: 41 },
          { role: 'assistant', text: 'Amber.', row_id: 42 },
        ],
      },
      replay: { events: [], latest_seq: 0, truncated: false },
      lastSeen: 9,
      prompt,
      turn: 6,
    });

    assert.equal(result.action, 'complete');
    assert.equal(result.reply.text, 'Amber.');
    assert.deepEqual(result.receipt, {
      type: 'reconcile',
      turn: 6,
      reason: 'runtime_changed',
      from: 'resume_messages',
      found_reply: true,
      watermark_ahead: true,
    });
  });

  it('waits for a terminal event when reconciliation finds no reply but the resumed turn is running', () => {
    const prompt = 'Which color is named?';
    const result = resumeDisposition({
      previousRuntimeId: 'runtime-old',
      resumed: {
        session_id: 'runtime-new',
        running: true,
        messages: [{ role: 'user', text: prompt, row_id: 41 }],
      },
      replay: { events: [], latest_seq: 0, truncated: false },
      lastSeen: 9,
      prompt,
      turn: 6,
    });

    assert.equal(result.action, 'wait');
    assert.equal(result.receipt.reason, 'runtime_changed');
    assert.equal(result.receipt.found_reply, false);
  });

  it('suppresses the same reply observed from terminal replay and durable history', () => {
    const accepted = [];

    assert.equal(addReplyOnce(accepted, { type: 'message.complete', payload: { text: 'Amber.' } }), true);
    assert.equal(addReplyOnce(accepted, { role: 'assistant', text: 'Amber.', row_id: 42 }), false);
    assert.equal(accepted.length, 1);
  });

  it('deliberately alternates reconnects inside and outside the detached-session grace', () => {
    assert.deepEqual(reconnectAwayBounds(3, 5_000, 60_000), {
      min: 5_000,
      max: 15_000,
      grace_side: 'inside',
    });
    assert.deepEqual(reconnectAwayBounds(6, 5_000, 60_000), {
      min: 30_000,
      max: 60_000,
      grace_side: 'outside',
    });
  });
});

describe('long-chat report', () => {
  it('reports recall, reconnects, latency percentiles, growth, compression, epochs, and cost', () => {
    const summary = summarize([
      { type: 'meta', facts: { codeword: 'opal', number: '48291', preference: 'I prefer rain at night.' } },
      { type: 'turn', turn: 1, first_delta_ms: 100, complete_ms: 1000, usage: { context_used: 1000, compressions: 0, cost_usd: 0.01 }, epoch: 'e1' },
      { type: 'recall', checkpoint_minute: 30, score: 3, total: 3, survived_compression: false },
      { type: 'reconnect', pass: true, reasons: [], epoch: 'e1' },
      { type: 'turn', turn: 2, first_delta_ms: 300, complete_ms: 3000, usage: { context_used: 700, compressions: 1, cost_usd: 0.03 }, epoch: 'e1' },
      { type: 'recall', checkpoint_minute: 60, score: 3, total: 3, survived_compression: true },
    ]);

    assert.equal(summary.recall.length, 2);
    assert.deepEqual(summary.reconnects, { pass: 1, fail: 0, reasons: [] });
    assert.equal(summary.latency.first_delta_p50_ms, 100);
    assert.equal(summary.latency.complete_p95_ms, 3000);
    assert.deepEqual(summary.context_growth, [{ turn: 1, tokens: 1000 }, { turn: 2, tokens: 700 }]);
    assert.equal(summary.compression.happened, true);
    assert.equal(summary.compression.recall_survived, true);
    assert.equal(summary.epoch.changed, false);
    assert.equal(summary.total_cost_usd, 0.03);
  });
});

describe('GPT-Live probe helpers', () => {
  it('strips SDP, credentials, and raw audio from persisted events', () => {
    const clean = sanitizeEvent({
      type: 'fixture',
      sdp: 'secret-sdp',
      token: 'secret-token',
      authorization: 'Bearer secret',
      audio: 'base64-audio',
      nested: { transport: { sdp: 'nested-secret' }, delta: 'safe transcript' },
    });

    assert.deepEqual(clean, { type: 'fixture', nested: { transport: {}, delta: 'safe transcript' } });
  });

  it('grades (a)-(d) from timed delegation, ack, and spoken evidence', () => {
    const events = [
      { type: 'session.delegation.created', at_ms: 1_000, delegation: { id: 'A' }, label: 'A' },
      { type: 'session.output_transcript.delta', at_ms: 5_000, delta: 'My day is going well.', label: 'smalltalk' },
      { type: 'session.delegation.created', at_ms: 10_000, delegation: { id: 'B' }, label: 'B' },
      { type: 'client.append', at_ms: 30_000, delegation_id: 'B', event_id: 'append-B', content: 'Tokyo is 3:00 AM.' },
      { type: 'session.commentary.appended', at_ms: 30_100, client_event_id: 'append-B', delegation_id: 'B' },
      { type: 'session.output_transcript.delta', at_ms: 31_000, delta: 'Tokyo is 3:00 AM.', label: 'B-result' },
      { type: 'client.append', at_ms: 91_500, delegation_id: 'A', event_id: 'append-A', content: 'Queens is 72 degrees.' },
      { type: 'session.commentary.appended', at_ms: 91_600, client_event_id: 'append-A', delegation_id: 'A' },
      { type: 'session.output_transcript.delta', at_ms: 92_000, delta: 'Queens is 72 degrees.', label: 'A-result' },
    ];

    assert.deepEqual(evaluateProbe(events), {
      a: { pass: true, evidence: 'smalltalk_speech_at_ms:5000' },
      b: { pass: true, evidence: 'delegation_B_at_ms:10000' },
      c: { pass: true, evidence: 'spoken_order:B,A' },
      d: { pass: true, evidence: 'append_A_ack_at_ms:91600' },
    });
  });

  it('credits small-talk speech emitted before fixture B in the same millisecond', () => {
    const events = [
      { type: 'session.delegation.created', at_ms: 1_000, delegation: { id: 'A' }, label: 'A' },
      { type: 'fixture.feed', at_ms: 9_676, label: 'smalltalk' },
      { type: 'session.output_transcript.delta', at_ms: 12_656, delta: "It's going" },
      { type: 'fixture.feed', at_ms: 12_656, label: 'B' },
    ];

    assert.deepEqual(evaluateProbe(events).a, {
      pass: true,
      evidence: 'smalltalk_speech_at_ms:12656',
    });
  });
});
