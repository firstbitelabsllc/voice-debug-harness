#!/usr/bin/env node
/**
 * Offline Class A CI — no Next, Cypress, Playwright, or network.
 *
 *   node ci-offline.mjs
 *   npm run ci:offline   (from this package)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");
const CORPUS = path.join(ROOT, "fixtures/voice-corpus");
const GENERATED_CORPUS = mkdtempSync(
  path.join(tmpdir(), "voice-debug-ci-offline-"),
);

function run(args, corpusDir = CORPUS) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      VOICE_DEBUG_CORPUS_DIR: corpusDir,
    },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    throw new Error(`cli ${args.join(" ")} exited ${result.status}`);
  }
}

try {
  run(["list"]);
  run(["energy"]);
  // Generate is always an offline synthetic-energy operation.
  run(["generate", "--id", "ci-offline-synth"], GENERATED_CORPUS);
  run(["list"], GENERATED_CORPUS);

  // Unit smoke (node:test) — mic-feed/energy/chromium contracts, plus the
  // WER comparison layer is bounded string comparison only.
  const unit = spawnSync(
    process.execPath,
    [
      "--test",
      path.join(ROOT, "smoke.test.mjs"),
      path.join(ROOT, "wer.test.mjs"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  process.stdout.write(unit.stdout || "");
  process.stderr.write(unit.stderr || "");
  if (unit.status !== 0) {
    throw new Error(`unit tests exited ${unit.status}`);
  }

  console.log("ci-offline: PASS");
} catch (error) {
  console.error(`ci-offline: FAIL: ${error.message}`);
  process.exit(1);
} finally {
  rmSync(GENERATED_CORPUS, { recursive: true, force: true });
}
