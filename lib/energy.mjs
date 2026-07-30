/**
 * PCM / RMS energy probe helpers (portable core).
 *
 * Node-side: Float32 sample arrays and raw WAV bytes.
 * Browser-side adapters may use the same thresholds.
 */
import { parseMonoPcm16Wav } from "./wav.mjs";

/**
 * Peak absolute sample amplitude in 0..1 float space.
 * @param {ArrayLike<number>} samples
 */
export function measurePeakAbs(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Root-mean-square of float samples.
 * @param {ArrayLike<number>} samples
 */
export function measureRms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Decode mono 16-bit PCM WAV to Float32 samples in -1..1.
 * Validates PCM format, mono, 16-bit, chunk bounds, and word alignment.
 *
 * @param {Buffer|Uint8Array} bytes
 */
export function decodeMonoPcm16Wav(bytes) {
  const { pcm } = parseMonoPcm16Wav(bytes);
  const sampleCount = pcm.byteLength / 2;
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const int16 = pcm.readInt16LE(i * 2);
    samples[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
  }
  return samples;
}

/**
 * Energy summary for a WAV file buffer.
 * @param {Buffer|Uint8Array} bytes
 */
export function measureWavEnergy(bytes) {
  const samples = decodeMonoPcm16Wav(bytes);
  return {
    peakAbs: measurePeakAbs(samples),
    rms: measureRms(samples),
    samples: samples.length,
  };
}

/** Default speech-energy thresholds for mic-energy probes. */
export const DEFAULT_RMS_THRESHOLD = 0.02;
export const DEFAULT_FRAMES_ABOVE = 3;
