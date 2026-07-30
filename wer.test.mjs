/**
 * Offline tests for the bounded WER string-comparison utility.
 *
 * These run with no daemon, no network and no provider. They cannot prove the
 * production transcription path works. The package ships no speech fixture
 * and no calibrated acceptance threshold.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTranscript,
  wordErrorRate,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_WORDS,
} from "./lib/wer.mjs";

test("normalizer absorbs the formatting an ASR legitimately varies on", () => {
  assert.equal(
    normalizeTranscript("Step-by-step, the O(n) answer."),
    normalizeTranscript("step by step the o n answer"),
  );
  assert.equal(normalizeTranscript("I have 2 items."), "i have two items");
  assert.equal(normalizeTranscript("  Hello,   world!  "), "hello world");
});

test("normalizer does NOT absorb a real substitution", () => {
  // The failure mode on the other side: a normalizer so aggressive that
  // mishearing a word costs nothing. "code" -> "cold" must still be an error.
  const { wer, errors } = wordErrorRate("write any code", "write any cold");
  assert.equal(errors, 1);
  assert.ok(wer > 0, "a substituted word must register as error");
});

test("silence scores 1.0 rather than throwing", () => {
  // Silence is precisely what the live gate exists to catch. It has to fail as
  // a comparable number, not as an exception a caller could swallow.
  const { wer } = wordErrorRate("any words at all", "");
  assert.equal(wer, 1);
});

test("notation differences remain visible to caller-selected policy", () => {
  // This compares two authored strings only. It is an example of why consumers
  // should calibrate normalization before selecting their own threshold.
  const { wer } = wordErrorRate(
    "Please explain step-by-step how the hash map two-sum solution works and why it is O(n).",
    "please explain step by step how the hash map two sum solution works and why it is oh of n",
  );
  assert.ok(wer > 0.1, `expected notation cost above 0.1, got ${wer}`);
});

test("identical caller-supplied strings score zero", () => {
  const { wer, errors } = wordErrorRate(
    "bring your own recording",
    "bring your own recording",
  );
  assert.equal(wer, 0);
  assert.equal(errors, 0);
});

test("character limits apply before normalization", () => {
  assert.throws(
    () => normalizeTranscript("x".repeat(MAX_TRANSCRIPT_CHARS + 1)),
    /exceeds .* characters/,
  );
});

test("word limits stop quadratic work before edit distance", () => {
  const tooManyWords = Array.from(
    { length: MAX_TRANSCRIPT_WORDS + 1 },
    () => "w",
  ).join(" ");
  assert.throws(
    () => wordErrorRate(tooManyWords, "w"),
    /limited to .* normalized words/,
  );
});
