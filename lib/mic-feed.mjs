/**
 * On-demand Playwright mic-feed helper (portable core).
 *
 * Primary multi-turn / barge-in primitive: override getUserMedia so tests can
 * call `window.__feedAudio(base64Wav)` after the page opens a stream.
 *
 * Chromium `--use-file-for-fake-audio-capture` is secondary (single-shot at
 * stream-open).
 *
 * This module has **zero Playwright dependency**. Consumers pass a Playwright
 * Page (or equivalent) that implements `addInitScript` / `evaluate`.
 *
 * Product extensions (for example, a barge-in observer) may set
 * `window.__onMicFeedReady = (ctx, dest) => { ... }` in an earlier init script;
 * it runs once per getUserMedia(audio) with the shared AudioContext + dest.
 */
import { MAX_WAV_BYTES, parseMonoPcm16Wav } from "./wav.mjs";

export const MAX_MIC_FEED_WAV_BYTES = MAX_WAV_BYTES;
export const MAX_MIC_FEED_BASE64_CHARS =
  Math.ceil(MAX_MIC_FEED_WAV_BYTES / 3) * 4 + 4;

/**
 * Browser init source: install fake mic + `__feedAudio`.
 * Use with `page.addInitScript(MIC_FEED_INIT_SCRIPT)` or evaluate.
 *
 * Window surface after getUserMedia(audio):
 * - `__micCtx` / `__micDest` — shared graph for product extensions
 * - `__feedAudio(b64)` — decode + play WAV into the mic stream
 * - optional `__onMicFeedReady(ctx, dest)` hook (set by consumer before GUM)
 */
export const MIC_FEED_INIT_SCRIPT = `
(() => {
  if (window.__voiceDebugMicFeedInstalled) return;
  window.__voiceDebugMicFeedInstalled = true;
  const MAX_WAV_BYTES = ${MAX_MIC_FEED_WAV_BYTES};
  const MAX_BASE64_CHARS = ${MAX_MIC_FEED_BASE64_CHARS};
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return realGUM(constraints);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const dest = ctx.createMediaStreamDestination();
    let closed = false;
    let closePromise;
    const tracks = new Set();
    const streams = new WeakSet();
    let feedAudio;
    const close = () => {
      if (closed) return closePromise;
      closed = true;
      if (window.__micCtx === ctx) delete window.__micCtx;
      if (window.__micDest === dest) delete window.__micDest;
      if (window.__feedAudio === feedAudio) delete window.__feedAudio;
      closePromise = Promise.resolve(ctx.close()).catch(() => undefined);
      return closePromise;
    };
    const stopTracking = (track) => {
      tracks.delete(track);
      if (tracks.size === 0) close();
    };
    const track = (audioTrack) => {
      if (!audioTrack || audioTrack.readyState === 'ended') return audioTrack;
      tracks.add(audioTrack);
      let stopped = false;
      const stop = audioTrack.stop.bind(audioTrack);
      const clone = audioTrack.clone.bind(audioTrack);
      audioTrack.stop = () => {
        if (stopped) return undefined;
        stopped = true;
        try {
          return stop();
        } finally {
          stopTracking(audioTrack);
        }
      };
      audioTrack.clone = () => track(clone());
      audioTrack.addEventListener('ended', () => {
        if (stopped) return;
        stopped = true;
        stopTracking(audioTrack);
      }, { once: true });
      return audioTrack;
    };
    const trackStream = (stream) => {
      if (!stream || streams.has(stream)) return stream;
      streams.add(stream);
      for (const audioTrack of stream.getAudioTracks()) track(audioTrack);
      const clone = stream.clone.bind(stream);
      stream.clone = () => trackStream(clone());
      return stream;
    };
    trackStream(dest.stream);
    window.__micCtx = ctx;
    window.__micDest = dest;
    feedAudio = async (b64) => {
      if (typeof b64 !== 'string' || b64.length > MAX_BASE64_CHARS) {
        throw new Error('voice debug mic feed: invalid or oversized base64 payload');
      }
      if (closed || ctx.state === 'closed') {
        throw new Error('voice debug mic feed: stream is closed');
      }
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (error) {
          if (closed || ctx.state === 'closed') {
            throw new Error('voice debug mic feed: stream is closed');
          }
          throw error;
        }
      }
      const binary = atob(b64);
      if (binary.length > MAX_WAV_BYTES) {
        throw new Error('voice debug mic feed: WAV exceeds byte limit');
      }
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      if (
        bytes.length < 12 ||
        String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
        String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE'
      ) {
        throw new Error('voice debug mic feed: payload is not a WAV');
      }
      let audio;
      try {
        audio = await ctx.decodeAudioData(bytes.buffer.slice(0));
      } catch (error) {
        if (closed || ctx.state === 'closed') {
          throw new Error('voice debug mic feed: stream is closed');
        }
        throw error;
      }
      if (closed || ctx.state === 'closed') {
        throw new Error('voice debug mic feed: stream is closed');
      }
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(dest);
      src.start();
      return audio.duration;
    };
    window.__feedAudio = feedAudio;
    if (typeof window.__onMicFeedReady === 'function') {
      window.__onMicFeedReady(ctx, dest);
    }
    return dest.stream;
  };
})();
`.trim();

/**
 * Install the mic-feed override on a Playwright page (before navigation ideal).
 * @param {{ addInitScript: (arg: string | Function) => Promise<unknown> }} page
 */
export async function installMicFeed(page) {
  if (typeof page.addInitScript !== "function") {
    throw new Error(
      "installMicFeed expects a Playwright Page with addInitScript",
    );
  }
  // Supported Playwright versions accept the string form. Preserve any error
  // from the page instead of retrying after an unrelated failure.
  await page.addInitScript(MIC_FEED_INIT_SCRIPT);
}

/**
 * Encode a WAV Buffer/Uint8Array as base64 for `__feedAudio`.
 * @param {Buffer|Uint8Array} wavBytes
 */
export function wavToBase64(wavBytes) {
  if (
    wavBytes === null ||
    wavBytes === undefined ||
    typeof wavBytes.byteLength !== "number"
  ) {
    throw new Error("wavToBase64: expected Buffer or Uint8Array");
  }
  if (wavBytes.byteLength > MAX_MIC_FEED_WAV_BYTES) {
    throw new Error("wavToBase64: WAV exceeds resource limit");
  }
  const buf = Buffer.isBuffer(wavBytes) ? wavBytes : Buffer.from(wavBytes);
  parseMonoPcm16Wav(buf);
  return buf.toString("base64");
}

/**
 * Feed a WAV into the page mic stream (after getUserMedia has run).
 * @param {{ evaluate: (fn: Function, arg: string) => Promise<unknown> }} page
 * @param {Buffer|Uint8Array|string} wavBytesOrBase64
 * @returns {Promise<number>} spoken duration seconds (from browser)
 */
export async function feedAudio(page, wavBytesOrBase64) {
  if (!page || typeof page.evaluate !== "function") {
    throw new Error("feedAudio expects a Playwright Page with evaluate");
  }
  let bytes;
  if (typeof wavBytesOrBase64 === "string") {
    if (wavBytesOrBase64.length > MAX_MIC_FEED_BASE64_CHARS) {
      throw new Error("feedAudio: base64 payload exceeds resource limit");
    }
    if (
      wavBytesOrBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(wavBytesOrBase64)
    ) {
      throw new Error("feedAudio: invalid base64 payload");
    }
    bytes = Buffer.from(wavBytesOrBase64, "base64");
  } else {
    bytes = wavBytesOrBase64;
  }
  const b64 = wavToBase64(bytes);
  return page.evaluate(async (payload) => {
    if (typeof window.__feedAudio !== "function") {
      throw new Error(
        "__feedAudio missing — call installMicFeed before navigation and ensure getUserMedia ran",
      );
    }
    return window.__feedAudio(payload);
  }, b64);
}
