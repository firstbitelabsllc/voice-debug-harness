#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "browser-smoke.mjs",
  "ci-offline.mjs",
  "cli.mjs",
  "fixtures/voice-corpus/README.md",
  "fixtures/voice-corpus/coach-hashmap-explain.json",
  "fixtures/voice-corpus/coach-hashmap-explain.wav",
  "index.mjs",
  "lib/chromium.mjs",
  "lib/corpus.mjs",
  "lib/energy.mjs",
  "lib/mic-feed.mjs",
  "lib/wav.mjs",
  "lib/wer.mjs",
  "package.json",
  "release-check.mjs",
  "smoke.test.mjs",
  "wer.test.mjs",
].sort();

const RUNTIME_SOURCES = EXPECTED.filter(
  (file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"),
);
const FORBIDDEN_NETWORK_SURFACE = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /node:(?:http|http2|https|net|tls|dns|dgram)(?:\/|['"])/,
  /(?:from\s+|require\s*\(\s*)["'](?:undici|axios|got|node-fetch)["']/,
  /https?:\/\/127(?:\.\d+){3}/,
];

for (const file of RUNTIME_SOURCES) {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  for (const pattern of FORBIDDEN_NETWORK_SURFACE) {
    if (pattern.test(source)) {
      console.error(
        JSON.stringify({
          ok: false,
          error: "runtime network surface is forbidden",
          file,
          pattern: pattern.source,
        }),
      );
      process.exit(1);
    }
  }
}

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "npm pack failed\n");
  process.exit(result.status || 1);
}

let receipt;
try {
  receipt = JSON.parse(result.stdout);
} catch (error) {
  console.error(
    `release:verify: npm pack returned invalid JSON: ${error.message}`,
  );
  process.exit(1);
}
const actual = (receipt[0]?.files || []).map((file) => file.path).sort();
if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "package allowlist mismatch",
        expected: EXPECTED,
        actual,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
console.log(
  JSON.stringify({
    ok: true,
    files: actual.length,
    forbiddenNetworkClientPatterns: "none",
    filename: receipt[0]?.filename,
    integrity: receipt[0]?.integrity,
  }),
);
