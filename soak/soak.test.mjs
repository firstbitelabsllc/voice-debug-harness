import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSyntheticChunk,
  checkpointForTurn,
  evaluateReplay,
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
});
