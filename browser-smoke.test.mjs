import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_RMS_THRESHOLD,
  fakeDeviceArgs,
  feedAudio,
  installMicFeed,
  readBoundedWavFile,
  writeWavFile,
} from "./index.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));

test("a short loud burst does not pass the mean-RMS browser check", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "voice-energy-"));
  try {
    for (const name of ["browser-smoke.mjs", "index.mjs", "lib", "README.md"]) {
      await cp(path.join(root, name), path.join(sandbox, name), {
        recursive: true,
      });
    }
    await symlink(
      path.join(root, "node_modules"),
      path.join(sandbox, "node_modules"),
    );
    const corpus = path.join(sandbox, "fixtures/voice-corpus");
    await mkdir(corpus, { recursive: true });
    // This loud 120 ms clip clears the file-energy threshold but should not
    // clear the browser's mean threshold over its 1.8-second observation.
    const samples = Float32Array.from(
      { length: 2880 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 24000),
    );
    writeWavFile(path.join(corpus, "coach-hashmap-explain.wav"), samples);
    let result;
    try {
      result = await run(
        process.execPath,
        [path.join(sandbox, "browser-smoke.mjs")],
        { timeout: 60000 },
      );
    } catch (error) {
      result = error;
    }
    const receipt = JSON.parse(result.stdout.trim().split("\n")[0]);
    assert.ok(receipt.nodeEnergy.rms > receipt.threshold);
    assert.ok(receipt.browserEnergy.peakAbs > receipt.threshold);
    assert.ok(receipt.browserEnergy.rms < receipt.threshold);
    assert.equal(
      receipt.ok,
      false,
      "a peak alone must not pass the mean-RMS check",
    );
    assert.equal(result.code, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("mic-feed closes each owner after all of its tracks stop without breaking a newer stream", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: fakeDeviceArgs(),
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__voiceLifecycle = { contexts: [], closeCalls: [] };
      const close = AudioContext.prototype.close;
      AudioContext.prototype.close = function (...args) {
        const index = window.__voiceLifecycle.contexts.indexOf(this);
        window.__voiceLifecycle.closeCalls[index] =
          (window.__voiceLifecycle.closeCalls[index] || 0) + 1;
        return close.apply(this, args);
      };
      window.__onMicFeedReady = (ctx) => {
        window.__voiceLifecycle.contexts.push(ctx);
      };
    });
    await installMicFeed(page);
    await page.goto(pathToFileURL(path.join(root, "README.md")).href);
    await page.evaluate(async () => {
      const first = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.__voiceLifecycle.first = first;
      window.__voiceLifecycle.firstClone = first.clone();
      window.__voiceLifecycle.firstGrandchild =
        window.__voiceLifecycle.firstClone.clone();
      window.__voiceLifecycle.firstFeed = window.__feedAudio;
      window.__voiceLifecycle.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    });

    await page.evaluate(() => window.__voiceLifecycle.first.getTracks()[0].stop());
    const afterOlderStop = await page.evaluate(() => ({
      firstState: window.__voiceLifecycle.contexts[0].state,
      firstCloneState: window.__voiceLifecycle.firstClone.getTracks()[0].readyState,
      firstGrandchildState:
        window.__voiceLifecycle.firstGrandchild.getTracks()[0].readyState,
      currentState: window.__voiceLifecycle.contexts[1].state,
      currentOwnsGlobals: window.__micCtx === window.__voiceLifecycle.contexts[1],
    }));
    assert.deepEqual(afterOlderStop, {
      firstState: "running",
      firstCloneState: "live",
      firstGrandchildState: "live",
      currentState: "running",
      currentOwnsGlobals: true,
    });

    const wav = readBoundedWavFile(
      path.join(root, "fixtures/voice-corpus/coach-hashmap-explain.wav"),
    );
    const measurePeak = (streamName, contextIndex) => page.evaluate(async ({ streamName, contextIndex }) => {
      const ctx = window.__voiceLifecycle.contexts[contextIndex];
      const analyser = ctx.createAnalyser();
      const source = ctx.createMediaStreamSource(window.__voiceLifecycle[streamName]);
      source.connect(analyser);
      try {
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0;
        const until = performance.now() + 500;
        while (performance.now() < until) {
          analyser.getFloatTimeDomainData(samples);
          peak = Math.max(...samples.map((value) => Math.abs(value)), peak);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return peak;
      } finally {
        source.disconnect();
        analyser.disconnect();
      }
    }, { streamName, contextIndex });
    await page.evaluate(
      (b64) => window.__voiceLifecycle.firstFeed(b64),
      wav.toString("base64"),
    );
    const cloneEnergy = await measurePeak("firstClone", 0);
    assert.ok(
      cloneEnergy > DEFAULT_RMS_THRESHOLD,
      `stream clone peak ${cloneEnergy} did not clear ${DEFAULT_RMS_THRESHOLD}`,
    );

    await feedAudio(page, wav);
    const currentEnergy = await measurePeak("current", 1);
    assert.ok(
      currentEnergy > DEFAULT_RMS_THRESHOLD,
      `newer stream peak ${currentEnergy} did not clear ${DEFAULT_RMS_THRESHOLD}`,
    );

    await page.evaluate(() => window.__voiceLifecycle.firstClone.getTracks()[0].stop());
    assert.equal(
      await page.evaluate(() => window.__voiceLifecycle.contexts[0].state),
      "running",
      "a descendant stream clone must keep the owner alive",
    );
    await page.evaluate(() =>
      window.__voiceLifecycle.firstGrandchild.getTracks()[0].stop(),
    );
    await page.waitForFunction(
      () => window.__voiceLifecycle.contexts[0].state === "closed",
      undefined,
      { timeout: 1_000 },
    );
    const olderClosed = await page.evaluate(async () => {
      let staleFeedError = "";
      try {
        await window.__voiceLifecycle.firstFeed("UklGRgAAAAA=");
      } catch (error) {
        staleFeedError = String(error.message || error);
      }
      return {
        closeCalls: window.__voiceLifecycle.closeCalls[0],
        currentOwnsGlobals: window.__micCtx === window.__voiceLifecycle.contexts[1],
        staleFeedError,
      };
    });
    assert.equal(olderClosed.closeCalls, 1);
    assert.equal(olderClosed.currentOwnsGlobals, true);
    assert.match(olderClosed.staleFeedError, /stream is closed/);

    await page.evaluate(() => {
      const track = window.__voiceLifecycle.current.getTracks()[0];
      track.stop();
      track.stop();
    });
    await page.waitForFunction(
      () => window.__voiceLifecycle.contexts[1].state === "closed",
      undefined,
      { timeout: 1_000 },
    );
    const finalState = await page.evaluate(() => ({
      closeCalls: window.__voiceLifecycle.closeCalls,
      hasCtx: "__micCtx" in window,
      hasDest: "__micDest" in window,
      hasFeed: "__feedAudio" in window,
    }));
    assert.deepEqual(finalState, {
      closeCalls: [1, 1],
      hasCtx: false,
      hasDest: false,
      hasFeed: false,
    });
    await context.close();
  } finally {
    await browser.close();
  }
});
