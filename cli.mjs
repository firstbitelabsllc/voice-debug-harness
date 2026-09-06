#!/usr/bin/env node
/**
 * voice-debug CLI (portable core)
 *
 *   voice-debug list
 *   voice-debug generate [--id <slug>] [--text "..."]
 *   voice-debug play-probe [--id <slug>]
 *   voice-debug energy [--id <slug>]
 *
 * Env (VOICE_DEBUG_* portable prefix):
 *   VOICE_DEBUG_CORPUS_DIR   corpus folder
 *     reads: also fall back to bundled fixtures
 *     writes: without env → ./voice-debug-corpus under cwd (never package root)
 * Generate writes a synthetic speech-energy WAV + meta JSON. The CLI has no
 * network mode; users bring their own WAV/JSON fixtures for real speech.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  measurePeakAbs,
  measureWavEnergy,
  readBoundedWavFile,
  synthesizeSpeechEnergySamples,
  writeWavFile,
} from "./index.mjs";
import {
  DEFAULT_ID,
  DEFAULT_TEXT,
  DEFAULT_WRITE_CORPUS_DIRNAME,
  resolveCorpusDir,
  resolveWriteCorpusDir,
} from "./lib/corpus.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;
export const MAX_CORPUS_TEXT_CHARS = 4_000;
export const MAX_CORPUS_META_BYTES = 64 * 1024;
export const MAX_CORPUS_ENTRIES = 1_000;

function usage(exitCode = 0) {
  const readDir = resolveCorpusDir();
  let writeDir;
  try {
    writeDir = resolveWriteCorpusDir();
  } catch (error) {
    writeDir = `[disabled: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const text = `voice-debug — portable voice debug harness

Usage:
  voice-debug list
  voice-debug generate [--id <slug>] [--text <utterance>] [--force]
  voice-debug play-probe [--id <slug>]
  voice-debug energy [--id <slug>]

Env:
  VOICE_DEBUG_CORPUS_DIR     corpus folder (writes without this use ./${DEFAULT_WRITE_CORPUS_DIRNAME})

Read corpus:  ${safeTerminalText(readDir)}
Write corpus: ${safeTerminalText(writeDir)}
Package:      ${safeTerminalText(PKG_ROOT)}
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--id" || a === "--text") {
      if (i + 1 >= argv.length) {
        throw new Error(`${a} requires a value`);
      }
      out[a.slice(2)] = argv[++i];
    } else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else out._.push(a);
  }
  return out;
}

export function requireCorpusText(value) {
  if (typeof value !== "string") {
    throw new Error("corpus text must be a string");
  }
  if (value.length > MAX_CORPUS_TEXT_CHARS) {
    throw new Error(`corpus text exceeds ${MAX_CORPUS_TEXT_CHARS} characters`);
  }
  return value;
}

/** Remove terminal controls from user-authored metadata before printing it. */
export function safeTerminalText(value, maxChars = 256) {
  const safe = String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) => {
      const code = char.codePointAt(0);
      const hex = code.toString(16);
      if (code <= 0xff) return `\\x${hex.padStart(2, "0")}`;
      if (code <= 0xffff) return `\\u${hex.padStart(4, "0")}`;
      return `\\u{${hex}}`;
    })
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe;
}

export function requireCorpusId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  ) {
    throw new Error(
      "corpus id must be one safe path segment (1-64 letters, digits, dot, underscore, or hyphen; start with a letter or digit)",
    );
  }
  return value;
}

function corpusPaths(corpusDir, id) {
  const safeId = requireCorpusId(id);
  return {
    wav: path.join(corpusDir, `${safeId}.wav`),
    meta: path.join(corpusDir, `${safeId}.json`),
  };
}

/**
 * Load one corpus metadata file. Throws with the filename and an actionable
 * message when JSON is invalid or required fields are missing.
 *
 * @param {string} corpusDir
 * @param {string} file basename (e.g. foo.json)
 */
export function loadCorpusMeta(corpusDir, file) {
  if (
    typeof file !== "string" ||
    path.basename(file) !== file ||
    !file.endsWith(".json")
  ) {
    throw new Error(
      "corpus metadata filename must be one .json basename, not a path",
    );
  }
  const full = path.join(corpusDir, file);
  let fd;
  try {
    fd = openSync(full, "r");
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: cannot open file (${safeTerminalText(msg)}).`,
    );
  }
  let raw;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(
        `corpus metadata ${safeTerminalText(file)} must be a regular file`,
      );
    }
    const size = stat.size;
    if (size > MAX_CORPUS_META_BYTES) {
      throw new Error(
        `corpus metadata ${safeTerminalText(file)} exceeds ${MAX_CORPUS_META_BYTES} bytes`,
      );
    }
    raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CORPUS_META_BYTES) {
      throw new Error(
        `corpus metadata ${safeTerminalText(file)} exceeds ${MAX_CORPUS_META_BYTES} bytes`,
      );
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: cannot read file (${safeTerminalText(msg)}).`,
    );
  } finally {
    closeSync(fd);
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: invalid JSON (${safeTerminalText(msg)}).`,
    );
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: expected a JSON object with string "id" and "text"`,
    );
  }
  if (typeof meta.id !== "string" || !meta.id.trim()) {
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: missing string "id"`,
    );
  }
  if (typeof meta.text !== "string") {
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: missing string "text"`,
    );
  }
  requireCorpusText(meta.text);
  if (
    meta.source !== undefined &&
    (typeof meta.source !== "string" || meta.source.length > 256)
  ) {
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: optional "source" must be a string of at most 256 characters`,
    );
  }
  requireCorpusId(meta.id);
  const fileId = file.slice(0, -".json".length);
  if (meta.id !== fileId) {
    throw new Error(
      `corpus metadata ${safeTerminalText(file)}: "id" must match filename (${safeTerminalText(fileId)})`,
    );
  }
  return meta;
}

/**
 * List corpus entries. Fails non-zero (via thrown Error) on malformed meta.
 * @param {string} corpusDir
 */
export function listCorpus(corpusDir) {
  if (!existsSync(corpusDir)) {
    console.log("(empty corpus — run generate)");
    return;
  }
  const files = [];
  const directory = opendirSync(corpusDir);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (files.length >= MAX_CORPUS_ENTRIES) {
        throw new Error(
          `corpus contains more than ${MAX_CORPUS_ENTRIES} metadata files`,
        );
      }
      files.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  files.sort();
  if (!files.length) {
    console.log("(empty corpus — run generate)");
    return;
  }
  for (const file of files) {
    const meta = loadCorpusMeta(corpusDir, file);
    const wav = path.join(corpusDir, `${meta.id}.wav`);
    const wavOk = existsSync(wav) ? "wav=ok" : "wav=MISSING";
    console.log(`${meta.id}\t${wavOk}\t${safeTerminalText(meta.text, 72)}`);
  }
}

async function generateOffline(corpusDir, id, text, { force = false } = {}) {
  requireCorpusText(text);
  mkdirSync(corpusDir, { recursive: true });
  const { wav, meta } = corpusPaths(corpusDir, id);
  const samples = synthesizeSpeechEnergySamples();
  const payload = {
    id,
    text,
    sampleRate: 24_000,
    source: "offline-speech-energy",
    peakAbs: measurePeakAbs(samples),
    notes:
      "Synthetic speech-energy fixture for Chromium fake-mic injection; not linguistic speech.",
  };
  const writeOptions = force ? undefined : { flag: "wx" };
  let createdWav = false;
  try {
    writeWavFile(wav, samples, 24_000, writeOptions);
    createdWav = !force;
    writeFileSync(meta, `${JSON.stringify(payload, null, 2)}\n`, writeOptions);
  } catch (error) {
    if (!force && createdWav) {
      try {
        unlinkSync(wav);
      } catch {
        // Best-effort rollback of the file this process created exclusively.
      }
    }
    if (
      !force &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        `corpus id=${id} already exists; choose another id or pass --force`,
      );
    }
    throw error;
  }
  console.log(`wrote ${safeTerminalText(wav)}`);
  console.log(`wrote ${safeTerminalText(meta)}`);
  console.log(`peakAbs=${payload.peakAbs.toFixed(3)}`);
}

function playProbe(corpusDir, id) {
  const { wav, meta } = corpusPaths(corpusDir, id);
  if (!existsSync(wav) || !existsSync(meta)) {
    throw new Error(`missing corpus files for id=${id}; run generate first`);
  }
  const wavBytes = readBoundedWavFile(wav);
  measureWavEnergy(wavBytes);
  const info = loadCorpusMeta(corpusDir, `${id}.json`);
  console.log(`probe id=${id}`);
  console.log(`wav=${safeTerminalText(wav)}`);
  console.log(`text=${safeTerminalText(info.text)}`);
  console.log(`source=${safeTerminalText(info.source)}`);
  if (process.platform === "darwin") {
    const result = spawnSync("afplay", [wav], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn("afplay failed; WAV still present for Playwright capture");
    }
  } else {
    const header = wavBytes.subarray(0, 4).toString("ascii");
    if (header !== "RIFF") throw new Error("WAV header invalid");
    console.log("WAV RIFF header ok (no afplay on this platform)");
  }
}

function energyProbe(corpusDir, id) {
  const { wav, meta } = corpusPaths(corpusDir, id);
  if (!existsSync(wav)) {
    throw new Error(`missing corpus wav for id=${id}; run generate first`);
  }
  const bytes = readBoundedWavFile(wav);
  const energy = measureWavEnergy(bytes);
  console.log(`id=${id}`);
  console.log(`wav=${safeTerminalText(wav)}`);
  console.log(`samples=${energy.samples}`);
  console.log(`peakAbs=${energy.peakAbs.toFixed(4)}`);
  console.log(`rms=${energy.rms.toFixed(4)}`);
  if (existsSync(meta)) {
    const info = loadCorpusMeta(corpusDir, `${id}.json`);
    console.log(`source=${safeTerminalText(info.source)}`);
  }
  if (energy.peakAbs <= 0) {
    throw new Error(
      "peakAbs=0 — silent fixture (not usable for mic energy tests)",
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help || args._.length === 0) usage(args.help ? 0 : 2);
    if (args._.length !== 1) {
      throw new Error(`unexpected argument: ${args._[1]}`);
    }
    const cmd = args._[0];
    const id = requireCorpusId(args.id || DEFAULT_ID);
    const text = requireCorpusText(args.text ?? DEFAULT_TEXT);
    const readDir = resolveCorpusDir();

    if (cmd === "list") listCorpus(readDir);
    else if (cmd === "generate") {
      const writeDir = resolveWriteCorpusDir();
      await generateOffline(writeDir, id, text, { force: args.force });
    } else if (cmd === "play-probe") playProbe(readDir, id);
    else if (cmd === "energy") energyProbe(readDir, id);
    else usage(2);
  } catch (error) {
    console.error(
      `voice-debug: ${safeTerminalText(
        error instanceof Error ? error.message : error,
        1_000,
      )}`,
    );
    process.exit(1);
  }
}

// Resolve symlinks before comparing: when invoked through the packaged
// `voice-debug` bin, npm links node_modules/.bin/voice-debug -> cli.mjs, so
// process.argv[1] is the symlink path while import.meta.url is the real file.
// A plain path.resolve compare would be false and the bin would never run
// main(). realpathSync collapses both to the same target (falling back to
// path.resolve when a path can't be realpath'd).
const resolveEntry = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const isMain =
  Boolean(process.argv[1]) &&
  resolveEntry(process.argv[1]) ===
    resolveEntry(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
