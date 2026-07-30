/** voice-debug-harness — portable core exports. */
export {
  writeWavFile,
  readBoundedWavFile,
  encodeWav,
  floatTo16BitPCM,
  synthesizeSpeechEnergySamples,
  padWavWithSilence,
  measurePeakAbs as measurePeakAbsFromWav,
  MAX_WAV_BYTES,
  MAX_WAV_DURATION_SECONDS,
  MAX_SAMPLE_RATE,
  MAX_SILENCE_PADDING_SECONDS,
  MAX_SYNTH_DURATION_SECONDS,
} from "./lib/wav.mjs";

export {
  measurePeakAbs,
  measureRms,
  decodeMonoPcm16Wav,
  measureWavEnergy,
  DEFAULT_RMS_THRESHOLD,
  DEFAULT_FRAMES_ABOVE,
} from "./lib/energy.mjs";

export {
  MIC_FEED_INIT_SCRIPT,
  installMicFeed,
  wavToBase64,
  feedAudio,
  MAX_MIC_FEED_WAV_BYTES,
} from "./lib/mic-feed.mjs";

export {
  fakeDeviceArgs,
  fakeMicFileCaptureArgs,
  buildVoiceDebugLaunchArgs,
} from "./lib/chromium.mjs";

export { resolveCorpusDir, DEFAULT_ID, DEFAULT_TEXT } from "./lib/corpus.mjs";

export {
  normalizeTranscript,
  wordErrorRate,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_WORDS,
} from "./lib/wer.mjs";
