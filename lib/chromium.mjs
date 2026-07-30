/**
 * Playwright / Chromium launch helpers for Tier B voice capture.
 *
 * Secondary (single-shot): --use-file-for-fake-audio-capture=<wav>
 * Primary multi-turn: fake-device only + on-demand mic-feed (see mic-feed.mjs).
 *
 * Portable — no product coupling, no Playwright runtime dependency.
 */

/**
 * Base Chromium args that enable a fake media device without a capture file.
 * Safe for multi-turn / barge-in when paired with installMicFeed.
 * @returns {string[]}
 */
export function fakeDeviceArgs() {
  return [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ];
}

/**
 * Single-shot smoke: fake device + file capture from a corpus WAV.
 * Note: Chromium plays the file once at stream-open and does not re-fire —
 * use mic-feed for multi-turn / barge-in.
 *
 * @param {string} wavPath absolute path to mono WAV
 * @returns {string[]}
 */
export function fakeMicFileCaptureArgs(wavPath) {
  if (!wavPath || typeof wavPath !== "string") {
    throw new Error("fakeMicFileCaptureArgs: wavPath required");
  }
  return [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}`,
  ];
}

/**
 * Build launch args for a Tier B scenario.
 *
 * @param {{
 *   mode?: 'file-capture' | 'on-demand-feed',
 *   wavPath?: string,
 *   extraArgs?: string[],
 * }} [opts]
 * @returns {string[]}
 */
export function buildVoiceDebugLaunchArgs(opts = {}) {
  const mode =
    opts.mode === undefined
      ? opts.wavPath
        ? "file-capture"
        : "on-demand-feed"
      : opts.mode;
  const extra = opts.extraArgs || [];
  if (!Array.isArray(extra) || !extra.every((arg) => typeof arg === "string")) {
    throw new Error(
      "buildVoiceDebugLaunchArgs: extraArgs must be an array of strings",
    );
  }
  if (mode === "file-capture") {
    if (!opts.wavPath) {
      throw new Error(
        "buildVoiceDebugLaunchArgs: wavPath required for file-capture mode",
      );
    }
    return [...fakeMicFileCaptureArgs(opts.wavPath), ...extra];
  }
  if (mode === "on-demand-feed") {
    return [...fakeDeviceArgs(), ...extra];
  }
  throw new Error(
    `buildVoiceDebugLaunchArgs: unsupported mode ${JSON.stringify(mode)}`,
  );
}
