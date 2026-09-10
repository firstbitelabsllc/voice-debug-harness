#!/usr/bin/env node
/**
 * Bounded Chromium browser smoke — real Playwright + package mic-feed.
 *
 * Proves: launch with fake-device args → installMicFeed → getUserMedia →
 * feed bundled non-silent WAV → Web Audio analyser energy above threshold.
 *
 * No network, no live model, no external app. Closes the browser in finally.
 *
 *   npm run test:browser
 *   node browser-smoke.mjs
 *
 * Requires: playwright (devDependency) + Chromium browser binary.
 *   npm install
 *   npx playwright install chromium
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_RMS_THRESHOLD,
  fakeDeviceArgs,
  feedAudio,
  installMicFeed,
  measureWavEnergy,
  readBoundedWavFile,
  wavToBase64,
} from "./index.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_WAV = path.join(
  ROOT,
  "fixtures/voice-corpus/coach-hashmap-explain.wav",
);
const BASELINE_MEASURE_MS = 500;
const MEASURE_MS = 1_800;
const LAUNCH_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 60_000;

function fail(message, extra = {}) {
  const error = new Error(message);
  error.receipt = { ok: false, error: message, ...extra };
  throw error;
}

async function measureStreamEnergy(page, measureMs) {
  return page.evaluate(
    async ({ measureMs: durationMs }) => {
      const stream = window.__browserSmokeStream;
      const ctx = window.__micCtx;
      if (!stream || !ctx) {
        throw new Error("mic stream / AudioContext missing");
      }
      if (ctx.state === "suspended") await ctx.resume();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      try {
        const data = new Float32Array(analyser.fftSize);
        let peakAbs = 0;
        let rmsAcc = 0;
        let frames = 0;
        const start = performance.now();
        while (performance.now() - start < durationMs) {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          let framePeak = 0;
          for (let i = 0; i < data.length; i += 1) {
            const a = Math.abs(data[i]);
            if (a > framePeak) framePeak = a;
            sum += data[i] * data[i];
          }
          const frameRms = Math.sqrt(sum / data.length);
          if (framePeak > peakAbs) peakAbs = framePeak;
          rmsAcc += frameRms;
          frames += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return {
          peakAbs,
          rms: frames ? rmsAcc / frames : 0,
          frames,
          measureMs: durationMs,
        };
      } finally {
        source.disconnect();
        analyser.disconnect();
      }
    },
    { measureMs },
  );
}

let browser;

async function run() {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    fail(
      "browser-smoke: playwright is not installed.\n" +
        "  Install: npm install\n" +
        "  Browser: npx playwright install chromium\n" +
        `  Detail: ${msg}`,
    );
  }

  const wavBytes = readBoundedWavFile(FIXTURE_WAV);
  let nodeEnergy;
  try {
    nodeEnergy = measureWavEnergy(wavBytes);
  } catch (cause) {
    fail(
      `fixture WAV failed Node energy parse: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
  if (nodeEnergy.rms < DEFAULT_RMS_THRESHOLD) {
    fail("fixture WAV is below DEFAULT_RMS_THRESHOLD before browser feed", {
      nodeEnergy,
      threshold: DEFAULT_RMS_THRESHOLD,
    });
  }

  const b64 = wavToBase64(wavBytes);
  const { chromium } = playwright;
  browser = await chromium.launch({
    headless: true,
    args: fakeDeviceArgs(),
    timeout: LAUNCH_TIMEOUT_MS,
  });
  // A local file is a trustworthy context in Chromium and avoids even a
  // loopback request. README is only used as a stable local document target.
  const context = await browser.newContext({
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await installMicFeed(page);
  await page.goto(pathToFileURL(path.join(ROOT, "README.md")).href, {
    waitUntil: "domcontentloaded",
  });

  // Open the mic stream so __feedAudio is installed by the init script.
  await page.evaluate(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("navigator.mediaDevices.getUserMedia unavailable");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!stream || !stream.getAudioTracks().length) {
      throw new Error("getUserMedia returned no audio tracks");
    }
    if (typeof window.__feedAudio !== "function") {
      throw new Error("__feedAudio missing after getUserMedia");
    }
    window.__browserSmokeStream = stream;
  });

  const threshold = DEFAULT_RMS_THRESHOLD;
  const baselineEnergy = await measureStreamEnergy(page, BASELINE_MEASURE_MS);
  const baselineQuiet =
    baselineEnergy.peakAbs < threshold && baselineEnergy.rms < threshold;
  if (!baselineQuiet) {
    fail("browser mic stream was not quiet before fixture feed", {
      baselineEnergy,
      threshold,
    });
  }

  const durationSec = await feedAudio(page, b64);
  if (!(durationSec > 0)) {
    fail("feedAudio returned non-positive duration", { durationSec });
  }

  const browserEnergy = await measureStreamEnergy(page, MEASURE_MS);
  const energyOk = browserEnergy.rms > threshold;
  const receipt = {
    ok: baselineQuiet && energyOk,
    threshold,
    durationSec,
    nodeEnergy,
    baselineEnergy,
    browserEnergy,
    fixture: path.relative(ROOT, FIXTURE_WAV),
  };
  console.log(JSON.stringify(receipt));
  if (!energyOk) {
    fail(
      "browser mic stream stayed below threshold after fixture feed",
      receipt,
    );
  }
}

async function main() {
  let timeout;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            Object.assign(new Error("browser-smoke overall timeout"), {
              receipt: {
                ok: false,
                error: "browser-smoke overall timeout",
                timeoutMs: OVERALL_TIMEOUT_MS,
              },
            }),
          );
        }, OVERALL_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Common when chromium browser binary is missing
    if (
      /Executable doesn't exist|browserType\.launch|playwright install/i.test(
        message,
      )
    ) {
      console.error(
        "browser-smoke: Chromium browser binary unavailable.\n" +
          "  Install: npx playwright install chromium\n" +
          `  Detail: ${message}`,
      );
    } else {
      console.log(
        JSON.stringify(
          cause?.receipt || {
            ok: false,
            error: message,
          },
        ),
      );
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

await main();
