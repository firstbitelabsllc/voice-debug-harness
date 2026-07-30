/**
 * Bounded word error rate for comparing caller-supplied transcript strings.
 *
 * This utility does not transcribe audio, validate a model, or establish a
 * production threshold. Consumers must use recordings they have rights to and
 * calibrate acceptance criteria against their own speech-recognition system.
 */

export const MAX_TRANSCRIPT_CHARS = 20_000;
export const MAX_TRANSCRIPT_WORDS = 1_000;

const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/**
 * NFC, lowercase, hyphens to spaces, digits to words, punctuation stripped,
 * whitespace collapsed. Deliberately NOT locale-aware: the gate compares a
 * fixed English reference against one ASR engine, and a smarter normalizer is
 * a place for a bug to hide.
 */
export function normalizeTranscript(value) {
  if (typeof value !== "string") {
    throw new TypeError("normalizeTranscript expects a string");
  }
  if (value.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(
      `normalizeTranscript: input exceeds ${MAX_TRANSCRIPT_CHARS} characters`,
    );
  }
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-‐-―]/g, " ")
    .replace(/\d/g, (d) => ` ${DIGIT_WORDS[Number(d)]} `)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance over word arrays. */
function editDistance(reference, hypothesis) {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/**
 * Returns { wer, errors, referenceWords, normalizedReference,
 * normalizedHypothesis }.
 *
 * An empty hypothesis scores 1.0 rather than throwing: silence and a dead
 * transcription pipeline are exactly what the gate exists to catch, and they
 * must fail as a NUMBER the caller compares to a threshold, not as an
 * exception a caller might swallow.
 */
export function wordErrorRate(reference, hypothesis) {
  const normalizedReference = normalizeTranscript(reference);
  const normalizedHypothesis = normalizeTranscript(hypothesis);
  const referenceWords = normalizedReference
    ? normalizedReference.split(" ")
    : [];
  const hypothesisWords = normalizedHypothesis
    ? normalizedHypothesis.split(" ")
    : [];
  if (referenceWords.length === 0) {
    throw new Error("wordErrorRate requires a non-empty reference");
  }
  if (
    referenceWords.length > MAX_TRANSCRIPT_WORDS ||
    hypothesisWords.length > MAX_TRANSCRIPT_WORDS
  ) {
    throw new Error(
      `wordErrorRate: each transcript is limited to ${MAX_TRANSCRIPT_WORDS} normalized words`,
    );
  }
  const errors = editDistance(referenceWords, hypothesisWords);
  return {
    wer: errors / referenceWords.length,
    errors,
    referenceWords: referenceWords.length,
    normalizedReference,
    normalizedHypothesis,
  };
}
