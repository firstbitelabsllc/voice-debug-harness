import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeWavFile } from "./index.mjs";

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
