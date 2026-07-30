#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout;
}

function packageTreeDigest(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`unexpected installed package entry: ${absolute}`);
    }
  };
  visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const scratch = mkdtempSync(path.join(tmpdir(), "voice-debug-consumer-smoke-"));
try {
  const packDir = path.join(scratch, "pack");
  const consumerDir = path.join(scratch, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumerDir);

  const packReceipt = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packDir], ROOT),
  );
  const filename = packReceipt[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a filename");
  const tarball = path.join(packDir, filename);

  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    consumerDir,
  );

  const installedRoot = path.join(
    consumerDir,
    "node_modules",
    "voice-debug-harness",
  );
  const bin = path.join(consumerDir, "node_modules", ".bin", "voice-debug");
  const before = packageTreeDigest(installedRoot);

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const m = await import('voice-debug-harness'); if (typeof m.measureWavEnergy !== 'function') process.exit(1);",
    ],
    consumerDir,
  );
  run(bin, ["list"], consumerDir);
  run(bin, ["generate", "--id", "consumer-smoke"], consumerDir);

  const generatedWav = path.join(
    consumerDir,
    "voice-debug-corpus",
    "consumer-smoke.wav",
  );
  if (!statSync(generatedWav).isFile()) {
    throw new Error("consumer generation did not produce a regular WAV file");
  }

  const packageRootAttempt = spawnSync(
    bin,
    ["generate", "--id", "must-not-write"],
    {
      cwd: installedRoot,
      encoding: "utf8",
      env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
    },
  );
  if (
    packageRootAttempt.status === 0 ||
    existsSync(path.join(installedRoot, "voice-debug-corpus"))
  ) {
    throw new Error("package-root generation did not fail closed");
  }

  const after = packageTreeDigest(installedRoot);
  if (after !== before) {
    throw new Error("installed package changed during consumer generation");
  }

  console.log(
    JSON.stringify({
      ok: true,
      tarball: filename,
      import: "passed",
      bin: "passed",
      generation: "consumer-cwd",
      packageRootWrite: "rejected",
      installedTreeUnchanged: true,
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
