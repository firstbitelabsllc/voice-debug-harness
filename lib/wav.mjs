/**
 * Minimal 16-bit PCM WAV helpers for the voice-debug corpus.
 * Offline-first: generate bounded speech-energy fixtures without a network.
 *
 * Portable core — no app imports.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_WAV_BYTES = 16 * 1024 * 1024;
export const MAX_RIFF_CHUNKS = 1_024;
export const MAX_WAV_DURATION_SECONDS = 5 * 60;
export const MAX_SAMPLE_RATE = 192_000;
export const MAX_SILENCE_PADDING_SECONDS = 60;
export const MAX_SYNTH_DURATION_SECONDS = 30;
const MAX_PCM_BYTES = MAX_WAV_BYTES - 44;

export function readBoundedWavFile(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("WAV read: input must be a regular file");
    }
    const size = stat.size;
    if (size > MAX_WAV_BYTES) {
      throw new Error(
        `WAV read: ${size} bytes exceeds ${MAX_WAV_BYTES}-byte limit`,
      );
    }
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_WAV_BYTES) {
      throw new Error(
        `WAV read: ${bytes.length} bytes exceeds ${MAX_WAV_BYTES}-byte limit`,
      );
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk RIFF chunks safely. Rejects truncated/malformed layouts.
 * @param {Buffer} buf
 * @returns {{ id: string, size: number, dataOffset: number }[]}
 */
export function listRiffChunks(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error("WAV parse: expected Buffer");
  }
  if (buf.length > MAX_WAV_BYTES) {
    throw new Error(
      `WAV parse: ${buf.length} bytes exceeds ${MAX_WAV_BYTES}-byte limit`,
    );
  }
  if (buf.length < 12) {
    throw new Error("WAV parse: truncated RIFF header");
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("WAV parse: not a RIFF container");
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV parse: not a WAVE payload");
  }
  const declaredSize = buf.readUInt32LE(4);
  // declaredSize is bytes after the size field (file size - 8)
  const end = 8 + declaredSize;
  if (end < 12) {
    throw new Error("WAV parse: RIFF size too small");
  }
  if (end > buf.length) {
    throw new Error(
      `WAV parse: RIFF declares ${end} bytes but buffer has ${buf.length} (truncated)`,
    );
  }
  if (end !== buf.length) {
    throw new Error(
      `WAV parse: RIFF declares ${end} bytes but buffer has ${buf.length} (trailing bytes)`,
    );
  }

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= end) {
    if (chunks.length >= MAX_RIFF_CHUNKS) {
      throw new Error(`WAV parse: exceeds ${MAX_RIFF_CHUNKS}-chunk limit`);
    }
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > end) {
      throw new Error(
        `WAV parse: chunk ${JSON.stringify(id)} size ${size} exceeds buffer (offset ${dataOffset}, end ${end})`,
      );
    }
    chunks.push({ id, size, dataOffset });
    // Word-align: odd-sized chunks pad one byte
    const stride = 8 + size + (size % 2);
    if (offset + stride < offset) {
      throw new Error("WAV parse: chunk stride overflow");
    }
    offset += stride;
  }
  if (offset !== end) {
    throw new Error(
      `WAV parse: malformed trailing bytes (offset ${offset}, end ${end})`,
    );
  }
  return chunks;
}

/**
 * Parse and validate mono 16-bit PCM WAV.
 * Rejects stereo, non-PCM, truncated, and misaligned payloads loudly.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {{
 *   sampleRate: number,
 *   numChannels: number,
 *   bitsPerSample: number,
 *   dataOffset: number,
 *   dataSize: number,
 *   pcm: Buffer,
 *   buffer: Buffer,
 * }}
 */
export function parseMonoPcm16Wav(bytes) {
  if (
    bytes === null ||
    bytes === undefined ||
    typeof bytes.byteLength !== "number"
  ) {
    throw new Error("WAV parse: expected Buffer or Uint8Array");
  }
  if (bytes.byteLength > MAX_WAV_BYTES) {
    throw new Error(
      `WAV parse: ${bytes.byteLength} bytes exceeds ${MAX_WAV_BYTES}-byte limit`,
    );
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const chunks = listRiffChunks(buf);

  const fmts = chunks.filter((c) => c.id === "fmt ");
  if (!fmts.length) {
    throw new Error('WAV parse: missing "fmt " chunk');
  }
  if (fmts.length !== 1) {
    throw new Error('WAV parse: expected exactly one "fmt " chunk');
  }
  const fmt = fmts[0];
  if (fmt.size < 16) {
    throw new Error('WAV parse: "fmt " chunk too small for PCM');
  }

  const audioFormat = buf.readUInt16LE(fmt.dataOffset);
  const numChannels = buf.readUInt16LE(fmt.dataOffset + 2);
  const sampleRate = buf.readUInt32LE(fmt.dataOffset + 4);
  const byteRate = buf.readUInt32LE(fmt.dataOffset + 8);
  const blockAlign = buf.readUInt16LE(fmt.dataOffset + 12);
  const bitsPerSample = buf.readUInt16LE(fmt.dataOffset + 14);

  if (audioFormat !== 1) {
    throw new Error(
      `WAV parse: unsupported audio format ${audioFormat} (only PCM=1 accepted)`,
    );
  }
  if (numChannels !== 1) {
    throw new Error(`WAV parse: expected mono (1 channel), got ${numChannels}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`WAV parse: expected 16-bit samples, got ${bitsPerSample}`);
  }
  if (sampleRate === 0 || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`WAV parse: sample rate must be 1-${MAX_SAMPLE_RATE} Hz`);
  }
  const expectedBlockAlign = numChannels * (bitsPerSample / 8);
  if (blockAlign !== expectedBlockAlign) {
    throw new Error(
      `WAV parse: block align ${blockAlign} does not match channels/bits ${expectedBlockAlign}`,
    );
  }
  const expectedByteRate = sampleRate * blockAlign;
  if (byteRate !== expectedByteRate) {
    throw new Error(
      `WAV parse: byte rate ${byteRate} does not match sample rate/block align ${expectedByteRate}`,
    );
  }

  const dataChunks = chunks.filter((c) => c.id === "data");
  if (!dataChunks.length) {
    throw new Error('WAV parse: missing "data" chunk');
  }
  if (dataChunks.length !== 1) {
    throw new Error('WAV parse: expected exactly one "data" chunk');
  }
  const data = dataChunks[0];
  if (data.size % 2 !== 0) {
    throw new Error(
      `WAV parse: data size ${data.size} is not word-aligned for 16-bit PCM`,
    );
  }
  if (data.dataOffset + data.size > buf.length) {
    throw new Error("WAV parse: data chunk truncated");
  }
  const durationSeconds = data.size / blockAlign / sampleRate;
  if (durationSeconds > MAX_WAV_DURATION_SECONDS) {
    throw new Error(
      `WAV parse: duration ${durationSeconds.toFixed(3)}s exceeds ${MAX_WAV_DURATION_SECONDS}s limit`,
    );
  }

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    dataOffset: data.dataOffset,
    dataSize: data.size,
    durationSeconds,
    pcm: buf.subarray(data.dataOffset, data.dataOffset + data.size),
    buffer: buf,
  };
}

export function writeWavFile(
  filePath,
  samples,
  sampleRate = 24_000,
  writeOptions = undefined,
) {
  const pcm = floatTo16BitPCM(samples);
  const buffer = encodeWav(pcm, sampleRate);
  writeFileSync(filePath, buffer, writeOptions);
}

/**
 * Append trailing silence to a mono 16-bit PCM WAV so endpointing/VAD can fire
 * after speech.
 *
 * @param {string} srcPath absolute path to a RIFF WAV
 * @param {number} seconds silence duration (must be >= 0)
 * @param {{ outPath?: string }} [opts]
 * @returns {string} path to the padded WAV (tmp file unless opts.outPath set)
 */
export function padWavWithSilence(srcPath, seconds, opts = {}) {
  if (!srcPath || typeof srcPath !== "string") {
    throw new Error("padWavWithSilence: srcPath required");
  }
  if (
    typeof seconds !== "number" ||
    !(seconds >= 0) ||
    !Number.isFinite(seconds)
  ) {
    throw new Error(
      "padWavWithSilence: seconds must be a non-negative finite number",
    );
  }
  if (seconds > MAX_SILENCE_PADDING_SECONDS) {
    throw new Error(
      `padWavWithSilence: seconds exceeds ${MAX_SILENCE_PADDING_SECONDS}s limit`,
    );
  }
  const src = readBoundedWavFile(srcPath);
  const parsed = parseMonoPcm16Wav(src);
  const { sampleRate, numChannels, bitsPerSample } = parsed;
  const bytesPerFrame = numChannels * (bitsPerSample / 8);
  const silenceBytes = Math.floor(seconds * sampleRate) * bytesPerFrame;
  const finalPcmBytes = parsed.dataSize + silenceBytes;
  const finalDuration = finalPcmBytes / bytesPerFrame / sampleRate;
  if (
    !Number.isSafeInteger(silenceBytes) ||
    finalPcmBytes > MAX_PCM_BYTES ||
    finalDuration > MAX_WAV_DURATION_SECONDS
  ) {
    throw new Error("padWavWithSilence: padded WAV exceeds resource limits");
  }
  const silence = Buffer.alloc(silenceBytes);

  // Rebuild a standard 44-byte mono PCM header + original body + silence.
  const body = Buffer.concat([Buffer.from(parsed.pcm), silence]);
  const pcmInt16 = new Int16Array(
    body.buffer,
    body.byteOffset,
    body.byteLength / 2,
  );
  const padded = encodeWav(pcmInt16, sampleRate);

  const out =
    opts.outPath ||
    join(
      tmpdir(),
      `voice-debug-padded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    );
  writeFileSync(out, padded);
  return out;
}

export function encodeWav(pcmInt16, sampleRate) {
  if (!(pcmInt16 instanceof Int16Array)) {
    throw new Error("encodeWav: expected an Int16Array");
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new Error(
      `encodeWav: sampleRate must be an integer from 1-${MAX_SAMPLE_RATE}`,
    );
  }
  const dataSize = pcmInt16.byteLength;
  if (dataSize % 2 !== 0) {
    throw new Error("encodeWav: PCM byte length must be even");
  }
  if (dataSize > MAX_PCM_BYTES) {
    throw new Error(`encodeWav: PCM exceeds ${MAX_PCM_BYTES}-byte limit`);
  }
  const durationSeconds = dataSize / 2 / sampleRate;
  if (durationSeconds > MAX_WAV_DURATION_SECONDS) {
    throw new Error(
      `encodeWav: duration exceeds ${MAX_WAV_DURATION_SECONDS}s limit`,
    );
  }
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength).copy(
    buffer,
    44,
  );
  return buffer;
}

export function floatTo16BitPCM(samples) {
  if (!samples || !Number.isSafeInteger(samples.length) || samples.length < 0) {
    throw new Error("floatTo16BitPCM: samples must be array-like");
  }
  if (samples.length > MAX_PCM_BYTES / 2) {
    throw new Error("floatTo16BitPCM: sample count exceeds WAV resource limit");
  }
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Speech-like energy: amplitude-modulated tone bursts with silence gaps.
 * Enough RMS for mic-energy bridges; not linguistic speech.
 */
export function synthesizeSpeechEnergySamples({
  sampleRate = 24_000,
  durationSec = 2.4,
  frequencyHz = 180,
} = {}) {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new Error(
      `synthesizeSpeechEnergySamples: sampleRate must be an integer from 1-${MAX_SAMPLE_RATE}`,
    );
  }
  if (
    typeof durationSec !== "number" ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    durationSec > MAX_SYNTH_DURATION_SECONDS
  ) {
    throw new Error(
      `synthesizeSpeechEnergySamples: durationSec must be > 0 and <= ${MAX_SYNTH_DURATION_SECONDS}`,
    );
  }
  if (
    typeof frequencyHz !== "number" ||
    !Number.isFinite(frequencyHz) ||
    frequencyHz <= 0 ||
    frequencyHz > sampleRate / 2
  ) {
    throw new Error(
      "synthesizeSpeechEnergySamples: frequencyHz must be > 0 and at most the Nyquist frequency",
    );
  }
  const total = Math.floor(sampleRate * durationSec);
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PCM_BYTES / 2) {
    throw new Error(
      "synthesizeSpeechEnergySamples: sample count exceeds WAV resource limit",
    );
  }
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    // 120ms burst every 300ms — rough syllable cadence
    const phase = t % 0.3;
    const envelope = phase < 0.12 ? Math.sin((Math.PI * phase) / 0.12) : 0;
    samples[i] = 0.55 * envelope * Math.sin(2 * Math.PI * frequencyHz * t);
  }
  return samples;
}

/** @deprecated Prefer import from './energy.mjs' — kept for one-call sites. */
export function measurePeakAbs(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}
