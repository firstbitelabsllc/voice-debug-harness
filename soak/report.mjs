#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(records) {
  const meta = records.find(record => record.type === 'meta');
  const turns = records.filter(record => record.type === 'turn');
  const reconnects = records.filter(record => record.type === 'reconnect');
  const compressions = turns.map(record => Number(record.usage?.compressions) || 0);
  const compressionHappened = compressions.some(value => value > 0);
  const storedRecalls = records.filter(record => record.type === 'recall');
  const responseRecalls = records.filter(record => record.type === 'recall_response').map(record => {
    if (Number.isInteger(record.score)) return record;
    if (!meta?.facts) return { ...record, score: null, total: 3 };
    const facts = meta.facts;
    const response = String(record.response ?? '');
    const score = [facts.codeword, facts.number, facts.preference].filter(value => response.includes(value)).length;
    const turn = turns.find(item => item.turn === record.turn);
    return { ...record, score, total: 3, survived_compression: (Number(turn?.usage?.compressions) || 0) > 0 };
  });
  const recall = storedRecalls.length ? storedRecalls : responseRecalls;
  const epochs = [...new Set(records.map(record => record.epoch).filter(Boolean))];
  const costValues = turns.map(record => Number(record.usage?.cost_usd)).filter(Number.isFinite);
  return {
    recall: recall.map(record => ({ checkpoint_minute: record.checkpoint_minute, score: record.score, total: record.total ?? 3, survived_compression: Boolean(record.survived_compression) })),
    reconnects: {
      pass: reconnects.filter(record => record.pass).length,
      fail: reconnects.filter(record => !record.pass).length,
      reasons: reconnects.flatMap(record => record.reasons ?? []),
    },
    latency: {
      first_delta_p50_ms: percentile(turns.map(record => record.first_delta_ms).filter(Number.isFinite), 0.50),
      first_delta_p95_ms: percentile(turns.map(record => record.first_delta_ms).filter(Number.isFinite), 0.95),
      complete_p50_ms: percentile(turns.map(record => record.complete_ms).filter(Number.isFinite), 0.50),
      complete_p95_ms: percentile(turns.map(record => record.complete_ms).filter(Number.isFinite), 0.95),
    },
    context_growth: turns.map(record => ({ turn: record.turn, tokens: Number(record.usage?.context_used) || 0 })),
    compression: {
      happened: compressionHappened,
      max_count: compressions.length ? Math.max(...compressions) : 0,
      recall_survived: compressionHappened && recall.some(record => record.survived_compression && record.score === record.total),
    },
    epoch: { values: epochs, changed: epochs.length > 1 },
    total_cost_usd: costValues.length ? Math.max(...costValues) : null,
    complete: records.some(record => record.type === 'complete'),
  };
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node soak/report.mjs <run.jsonl>');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  process.stdout.write(`${JSON.stringify(summarize(records), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

