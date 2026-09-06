/**
 * Class A offline unit smoke — no Next, Playwright browser, or network.
 *
 *   node --test smoke.test.mjs
 *   npm test   (from this package)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listCorpus,
  loadCorpusMeta,
  requireCorpusId,
  requireCorpusText,
  safeTerminalText,
} from "./cli.mjs";
import {
  DEFAULT_WRITE_CORPUS_DIRNAME,
  isUnderPackageRoot,
  resolveCorpusDir,
  resolveWriteCorpusDir,
} from "./lib/corpus.mjs";
import {
  parseMonoPcm16Wav,
  listRiffChunks,
  MAX_RIFF_CHUNKS,
  MAX_SILENCE_PADDING_SECONDS,
  MAX_SYNTH_DURATION_SECONDS,
  MAX_WAV_BYTES,
} from "./lib/wav.mjs";

import {
  MIC_FEED_INIT_SCRIPT,
  installMicFeed,
  feedAudio,
  wavToBase64,
  fakeDeviceArgs,
  fakeMicFileCaptureArgs,
  buildVoiceDebugLaunchArgs,
  encodeWav,
  floatTo16BitPCM,
  synthesizeSpeechEnergySamples,
  padWavWithSilence,
  writeWavFile,
  measureRms,
  measurePeakAbs,
  measureWavEnergy,
  measurePeakAbsFromWav,
  readBoundedWavFile,
  decodeMonoPcm16Wav,
  DEFAULT_RMS_THRESHOLD,
  MAX_MIC_FEED_WAV_BYTES,
} from "./index.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, "cli.mjs");
const FIXTURE_WAV = join(
  ROOT,
  "fixtures/voice-corpus/coach-hashmap-explain.wav",
);

describe("voice-debug-harness Class A offline", () => {
  it("exports mic-feed init with __feedAudio + barge hook site", () => {
    assert.match(MIC_FEED_INIT_SCRIPT, /__feedAudio/);
    assert.match(MIC_FEED_INIT_SCRIPT, /__onMicFeedReady/);
    assert.match(MIC_FEED_INIT_SCRIPT, /__micDest/);
    assert.match(MIC_FEED_INIT_SCRIPT, /getUserMedia/);
  });

  it("fakeDeviceArgs / on-demand launch args (primary multi-turn)", () => {
    const args = fakeDeviceArgs();
    assert.ok(args.includes("--use-fake-device-for-media-stream"));
    assert.ok(args.includes("--use-fake-ui-for-media-stream"));
    const built = buildVoiceDebugLaunchArgs({ mode: "on-demand-feed" });
    assert.ok(built.includes("--use-fake-device-for-media-stream"));
    assert.ok(
      !built.some((a) => a.startsWith("--use-file-for-fake-audio-capture=")),
      "on-demand mode must not pin single-shot file capture",
    );
    assert.throws(
      () =>
        buildVoiceDebugLaunchArgs({
          mode: "file-caputre",
          wavPath: "/tmp/x.wav",
        }),
      /unsupported mode/,
    );
    for (const mode of ["", null, false, 0]) {
      assert.throws(
        () => buildVoiceDebugLaunchArgs({ mode }),
        /unsupported mode/,
      );
    }
    assert.throws(
      () => buildVoiceDebugLaunchArgs({ extraArgs: "--not-an-array" }),
      /array of strings/,
    );
  });

  it("fakeMicFileCaptureArgs requires wav path (secondary single-shot)", () => {
    assert.throws(() => fakeMicFileCaptureArgs(), /wavPath required/);
    const a = fakeMicFileCaptureArgs("/tmp/x.wav");
    assert.ok(
      a.some((x) => x.includes("use-file-for-fake-audio-capture=/tmp/x.wav")),
    );
  });

  it("synth speech energy clears RMS threshold (Tier B energy floor)", () => {
    const samples = synthesizeSpeechEnergySamples({
      sampleRate: 8_000,
      durationSec: 0.5,
      frequencyHz: 180,
    });
    const peak = measurePeakAbs(samples);
    const rms = measureRms(samples);
    assert.ok(peak > 0.3, `peakAbs ${peak}`);
    assert.ok(
      rms > DEFAULT_RMS_THRESHOLD,
      `rms ${rms} vs ${DEFAULT_RMS_THRESHOLD}`,
    );
  });

  it("committed offline fixture has speech energy", () => {
    const energy = measureWavEnergy(readFileSync(FIXTURE_WAV));
    assert.ok(energy.peakAbs > 0.3, JSON.stringify(energy));
    assert.ok(energy.rms > DEFAULT_RMS_THRESHOLD, JSON.stringify(energy));
  });

  it("measurePeakAbsFromWav takes WAV bytes, not raw byte values", () => {
    const bytes = readFileSync(FIXTURE_WAV);
    const peak = measurePeakAbsFromWav(bytes);
    assert.equal(peak, measureWavEnergy(bytes).peakAbs);
    assert.ok(peak <= 1, `peak ${peak} is not in -1..1 float space`);
  });

  it("padWavWithSilence lengthens PCM WAV", () => {
    const samples = synthesizeSpeechEnergySamples({
      sampleRate: 8_000,
      durationSec: 0.1,
      frequencyHz: 200,
    });
    const src = join(tmpdir(), `vdh-pkg-src-${Date.now()}.wav`);
    writeWavFile(src, samples, 8_000);
    const before = readFileSync(src).length;
    const paddedPath = padWavWithSilence(src, 1);
    try {
      const after = readFileSync(paddedPath).length;
      assert.ok(
        after > before + 15_000,
        `expected pad growth, before=${before} after=${after}`,
      );
      assert.equal(
        readFileSync(paddedPath).subarray(0, 4).toString("ascii"),
        "RIFF",
      );
      // Re-parse must still validate mono PCM16
      parseMonoPcm16Wav(readFileSync(paddedPath));
    } finally {
      try {
        unlinkSync(src);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(paddedPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("wavToBase64 round-trips buffer", () => {
    const pcm = floatTo16BitPCM(new Float32Array([0, 0.5, -0.5]));
    const wav = encodeWav(pcm, 8_000);
    const b64 = wavToBase64(wav);
    assert.equal(Buffer.from(b64, "base64").compare(wav), 0);
  });

  it("installMicFeed calls addInitScript; feedAudio needs __feedAudio", async () => {
    const calls = [];
    const page = {
      addInitScript: async (arg) => {
        calls.push(arg);
      },
    };
    await installMicFeed(page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], MIC_FEED_INIT_SCRIPT);

    const validWav = encodeWav(
      floatTo16BitPCM(new Float32Array([0, 0.25, -0.25])),
      8_000,
    );
    const validB64 = wavToBase64(validWav);
    const pageReady = {
      evaluate: async (_fn, b64) => {
        assert.equal(b64, validB64);
        return 1.25;
      },
    };
    // Package feedAudio uses page.evaluate(() => window.__feedAudio(...)) —
    // in Node we only assert the mock page contract path via install + rejects.
    const missing = {
      evaluate: async () => {
        throw new Error(
          "__feedAudio missing — call installMicFeed before navigation and ensure getUserMedia ran",
        );
      },
    };
    await assert.rejects(
      () => feedAudio(missing, validB64),
      /__feedAudio missing/,
    );
    // Happy path when evaluate returns duration (browser would call __feedAudio).
    const dur = await feedAudio(pageReady, validB64);
    assert.equal(dur, 1.25);
  });

  it("installMicFeed preserves a page failure and never retries", async () => {
    const sentinel = new Error("Target page has been closed");
    let calls = 0;
    const page = {
      addInitScript: async () => {
        calls += 1;
        throw sentinel;
      },
    };
    await assert.rejects(
      () => installMicFeed(page),
      (error) => error === sentinel,
    );
    assert.equal(calls, 1);
  });

  it("mic feed rejects malformed and oversized payloads before browser IPC", async () => {
    assert.throws(() => wavToBase64(Buffer.from("not a wav")), /RIFF/i);
    assert.throws(
      () => wavToBase64({ byteLength: MAX_MIC_FEED_WAV_BYTES + 1 }),
      /resource limit/,
    );
    let evaluated = false;
    await assert.rejects(
      () =>
        feedAudio(
          {
            evaluate: async () => {
              evaluated = true;
            },
          },
          "not base64!",
        ),
      /invalid base64/,
    );
    assert.equal(evaluated, false);
  });
});

describe("corpus write path (clean-install safe)", () => {
  it("rejects traversal and malformed corpus ids", () => {
    for (const id of [
      "../escape",
      "/absolute",
      ".",
      "..",
      "",
      "a/b",
      "x".repeat(65),
    ]) {
      assert.throws(() => requireCorpusId(id), /safe path segment/);
    }
    assert.equal(requireCorpusId("coach-hashmap_2.0"), "coach-hashmap_2.0");
  });

  it("CLI generate rejects traversal without writing outside corpus", () => {
    const consumerCwd = mkdtempSync(join(tmpdir(), "vdh-traversal-"));
    try {
      const result = spawnSync(
        process.execPath,
        [CLI, "generate", "--id", "../../escape"],
        {
          cwd: consumerCwd,
          env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /safe path segment/);
      assert.throws(
        () => readFileSync(join(consumerCwd, "escape.wav")),
        /ENOENT/,
      );
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  });

  it("CLI rejects missing option values and unknown flags without a traceback", () => {
    for (const args of [
      ["generate", "--id"],
      ["generate", "--unknown"],
    ]) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /at .*cli\.mjs/);
    }
  });

  it("public CLI exposes no Kokoro or remote-network mode", () => {
    const consumerCwd = mkdtempSync(join(tmpdir(), "vdh-no-network-mode-"));
    try {
      for (const flag of ["--kokoro", "--allow-remote"]) {
        const result = spawnSync(process.execPath, [CLI, "generate", flag], {
          cwd: consumerCwd,
          env: {
            ...process.env,
            VOICE_DEBUG_CORPUS_DIR: "",
            VOICE_DEBUG_KOKORO_URL: "https://example.invalid/secret?token=nope",
          },
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unknown option/);
      }
      assert.throws(
        () => readFileSync(join(consumerCwd, DEFAULT_WRITE_CORPUS_DIRNAME)),
        /EISDIR|ENOENT/,
      );
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  });

  it("bounds corpus text before writing", () => {
    assert.throws(() => requireCorpusText("x".repeat(4_001)), /exceeds 4000/);
    assert.equal(requireCorpusText("hello"), "hello");
  });

  it("resolveWriteCorpusDir defaults to cwd-local voice-debug-corpus", () => {
    const cwd = "/tmp/vdh-consumer-app";
    const fakePkg = "/tmp/vdh-sim-node_modules/voice-debug-harness";
    const writeDir = resolveWriteCorpusDir({
      cwd,
      env: {},
      packageRoot: fakePkg,
    });
    assert.equal(writeDir, resolve(cwd, DEFAULT_WRITE_CORPUS_DIRNAME));
    assert.equal(isUnderPackageRoot(writeDir, { packageRoot: fakePkg }), false);
  });

  it("resolveWriteCorpusDir never defaults under a simulated package root", () => {
    const fakePkg = join(tmpdir(), `vdh-pkg-root-${Date.now()}`);
    mkdirSync(join(fakePkg, "fixtures/voice-corpus"), { recursive: true });
    try {
      assert.throws(
        () =>
          resolveWriteCorpusDir({
            cwd: fakePkg,
            env: {},
            packageRoot: fakePkg,
          }),
        /inside the package root/,
      );
      assert.equal(
        resolveWriteCorpusDir({
          cwd: fakePkg,
          env: { VOICE_DEBUG_CORPUS_DIR: "./explicit-corpus" },
          packageRoot: fakePkg,
        }),
        join(fakePkg, "explicit-corpus"),
        "an explicit local override is trusted configuration",
      );

      // Simulated install: package under node_modules, cwd is consumer project
      const consumerCwd = join(tmpdir(), `vdh-consumer-${Date.now()}`);
      mkdirSync(consumerCwd, { recursive: true });
      try {
        const installWrite = resolveWriteCorpusDir({
          cwd: consumerCwd,
          env: {},
          packageRoot: fakePkg,
        });
        assert.equal(
          installWrite,
          join(consumerCwd, DEFAULT_WRITE_CORPUS_DIRNAME),
        );
        assert.equal(
          isUnderPackageRoot(installWrite, { packageRoot: fakePkg }),
          false,
          "clean-install generate must not write under package root",
        );
      } finally {
        rmSync(consumerCwd, { recursive: true, force: true });
      }
    } finally {
      rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  it("VOICE_DEBUG_CORPUS_DIR env override wins for write and read", () => {
    const cwd = "/tmp/vdh-cwd";
    const override = "/tmp/vdh-custom-corpus";
    const env = { VOICE_DEBUG_CORPUS_DIR: override };
    assert.equal(resolveWriteCorpusDir({ cwd, env }), override);
    assert.equal(resolveCorpusDir({ cwd, env }), override);
    // relative env is resolved against cwd
    assert.equal(
      resolveWriteCorpusDir({
        cwd: "/tmp/app",
        env: { VOICE_DEBUG_CORPUS_DIR: "my-corpus" },
      }),
      resolve("/tmp/app/my-corpus"),
    );
  });

  it("CLI generate writes outside the package and claims IDs atomically", async () => {
    const consumerCwd = mkdtempSync(join(tmpdir(), "vdh-gen-cwd-"));
    try {
      const result = spawnSync(
        process.execPath,
        [CLI, "generate", "--id", "write-path-probe"],
        {
          cwd: consumerCwd,
          env: {
            ...process.env,
            // Strip any inherited override so default write path is exercised
            VOICE_DEBUG_CORPUS_DIR: "",
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const expectedWav = join(
        consumerCwd,
        DEFAULT_WRITE_CORPUS_DIRNAME,
        "write-path-probe.wav",
      );
      const expectedMeta = join(
        consumerCwd,
        DEFAULT_WRITE_CORPUS_DIRNAME,
        "write-path-probe.json",
      );
      assert.ok(
        readFileSync(expectedWav).length > 44,
        `expected wav at ${expectedWav}`,
      );
      assert.ok(
        readFileSync(expectedMeta, "utf8").includes("write-path-probe"),
      );
      // Must not have written into package fixtures
      const leaked = join(
        ROOT,
        "fixtures/voice-corpus",
        "write-path-probe.wav",
      );
      assert.throws(() => readFileSync(leaked), /ENOENT/);

      const collision = spawnSync(
        process.execPath,
        [CLI, "generate", "--id", "write-path-probe"],
        {
          cwd: consumerCwd,
          env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
          encoding: "utf8",
        },
      );
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /already exists/);

      const forced = spawnSync(
        process.execPath,
        [CLI, "generate", "--id", "write-path-probe", "--force"],
        {
          cwd: consumerCwd,
          env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
          encoding: "utf8",
        },
      );
      assert.equal(forced.status, 0, forced.stderr || forced.stdout);

      const emptyText = spawnSync(
        process.execPath,
        [CLI, "generate", "--id", "empty-text-probe", "--text", ""],
        {
          cwd: consumerCwd,
          env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
          encoding: "utf8",
        },
      );
      assert.equal(emptyText.status, 0, emptyText.stderr || emptyText.stdout);
      const emptyMeta = JSON.parse(
        readFileSync(
          join(consumerCwd, DEFAULT_WRITE_CORPUS_DIRNAME, "empty-text-probe.json"),
          "utf8",
        ),
      );
      assert.equal(emptyMeta.text, "", "an explicit --text must be recorded verbatim");

      const race = () =>
        new Promise((resolveRace) => {
          const child = spawn(
            process.execPath,
            [CLI, "generate", "--id", "concurrent-probe"],
            {
              cwd: consumerCwd,
              env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (status) => resolveRace({ status, stderr }));
        });
      const outcomes = await Promise.all([race(), race()]);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status).sort(),
        [0, 1],
      );
      assert.match(
        outcomes.find((outcome) => outcome.status === 1)?.stderr || "",
        /already exists/,
      );
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  });
});

describe("corpus list malformed metadata", () => {
  it("loadCorpusMeta names the file and fails loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-bad-meta-"));
    try {
      writeFileSync(join(dir, "broken.json"), "{ not json");
      assert.throws(
        () => loadCorpusMeta(dir, "broken.json"),
        /corpus metadata broken\.json: invalid JSON/,
      );

      writeFileSync(join(dir, "no-id.json"), JSON.stringify({ text: "hi" }));
      assert.throws(
        () => loadCorpusMeta(dir, "no-id.json"),
        /corpus metadata no-id\.json: missing string "id"/,
      );

      writeFileSync(join(dir, "no-text.json"), JSON.stringify({ id: "x" }));
      assert.throws(
        () => loadCorpusMeta(dir, "no-text.json"),
        /corpus metadata no-text\.json: missing string "text"/,
      );

      writeFileSync(join(dir, "huge.json"), "x".repeat(64 * 1024 + 1));
      assert.throws(
        () => loadCorpusMeta(dir, "huge.json"),
        (error) =>
          /exceeds 65536 bytes/.test(error.message) &&
          !/cannot read file/.test(error.message),
        "a size-limit rejection must not claim the file was unreadable",
      );

      mkdirSync(join(dir, "nonregular.json"));
      assert.throws(
        () => loadCorpusMeta(dir, "nonregular.json"),
        (error) =>
          /must be a regular file/.test(error.message) &&
          !/cannot read file/.test(error.message),
        "a non-regular-file rejection must not claim the file was unreadable",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listCorpus throws when a meta file is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-list-bad-"));
    try {
      writeFileSync(
        join(dir, "ok.json"),
        JSON.stringify({ id: "ok", text: "hi" }),
      );
      writeFileSync(join(dir, "bad.json"), "null");
      assert.throws(() => listCorpus(dir), /corpus metadata bad\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects metadata ids that escape or disagree with their filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-meta-id-"));
    try {
      writeFileSync(
        join(dir, "safe.json"),
        JSON.stringify({ id: "../escape", text: "bad id" }),
      );
      assert.throws(
        () => loadCorpusMeta(dir, "safe.json"),
        /safe path segment/,
      );
      writeFileSync(
        join(dir, "other.json"),
        JSON.stringify({ id: "different", text: "mismatch" }),
      );
      assert.throws(
        () => loadCorpusMeta(dir, "other.json"),
        /must match filename/,
      );
      assert.throws(
        () => loadCorpusMeta(dir, "../safe.json"),
        /filename must be one .json basename/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI list exits non-zero and names the bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-cli-list-"));
    try {
      writeFileSync(join(dir, "corrupt.json"), '{"id":');
      const result = spawnSync(process.execPath, [CLI, "list"], {
        cwd: dir,
        env: { ...process.env, VOICE_DEBUG_CORPUS_DIR: dir },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, "list must fail non-zero");
      assert.match(result.stderr, /corrupt\.json/);
      assert.match(result.stderr, /invalid JSON|corpus metadata/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes terminal controls and keeps each corpus record on one line", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-terminal-meta-"));
    const logged = [];
    const originalLog = console.log;
    try {
      writeFileSync(
        join(dir, "hostile.json"),
        JSON.stringify({
          id: "hostile",
          text: "hello\x1b]0;owned\x07\r\nnext",
          source: "user\x9bsupplied",
        }),
      );
      console.log = (value) => logged.push(String(value));
      listCorpus(dir);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(logged.length, 1);
    const fields = logged[0].split("\t");
    assert.equal(fields.length, 3);
    for (const field of fields) {
      assert.doesNotMatch(field, /[\p{Cc}\p{Cf}\u2028\u2029]/u);
    }
    assert.match(logged[0], /\\x1b/);
    assert.match(logged[0], /\\x07/);
    assert.equal(
      safeTerminalText("a\x1b\r\nb\u2028c\u202ed\u2066e\u2069"),
      "a\\x1b\\x0d\\x0ab\\u2028c\\u202ed\\u2066e\\u2069",
    );
  });

  it("bounded WAV reads reject non-regular files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdh-nonregular-wav-"));
    try {
      assert.throws(() => readBoundedWavFile(dir), /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WAV parse hardening (negative cases)", () => {
  function pcmWav({ channels = 1, bits = 16, format = 1, samples = 8 } = {}) {
    // Build via encodeWav for mono 16-bit, then mutate for bad cases
    if (channels === 1 && bits === 16 && format === 1) {
      const floats = new Float32Array(samples);
      for (let i = 0; i < samples; i += 1) floats[i] = 0.25;
      return encodeWav(floatTo16BitPCM(floats), 8_000);
    }
    // Manual header for non-standard layouts
    const bytesPerSample = bits / 8;
    const dataSize = samples * channels * bytesPerSample;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(format, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(8_000, 24);
    buf.writeUInt32LE(8_000 * channels * bytesPerSample, 28);
    buf.writeUInt16LE(channels * bytesPerSample, 32);
    buf.writeUInt16LE(bits, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    return buf;
  }

  it("accepts valid mono PCM16", () => {
    const wav = pcmWav();
    const parsed = parseMonoPcm16Wav(wav);
    assert.equal(parsed.numChannels, 1);
    assert.equal(parsed.bitsPerSample, 16);
    assert.ok(listRiffChunks(wav).some((c) => c.id === "data"));
    const samples = decodeMonoPcm16Wav(wav);
    assert.ok(samples.length > 0);
  });

  it("rejects stereo", () => {
    const wav = pcmWav({ channels: 2 });
    assert.throws(() => parseMonoPcm16Wav(wav), /mono|channel/i);
    assert.throws(() => decodeMonoPcm16Wav(wav), /mono|channel/i);
  });

  it("rejects non-PCM format", () => {
    const wav = pcmWav({ format: 3 }); // IEEE float
    assert.throws(() => parseMonoPcm16Wav(wav), /format|PCM/i);
  });

  it("rejects truncated data chunk", () => {
    const wav = pcmWav({ samples: 32 });
    // Claim a larger data size than available bytes
    wav.writeUInt32LE(10_000, 40);
    assert.throws(() => parseMonoPcm16Wav(wav), /exceeds buffer|truncated/i);
  });

  it("rejects a RIFF declaration longer than the available buffer", () => {
    const wav = pcmWav({ samples: 8 });
    wav.writeUInt32LE(wav.length + 100, 4);
    assert.throws(() => parseMonoPcm16Wav(wav), /RIFF declares|truncated/i);
  });

  it("rejects zero sample rate and inconsistent PCM rates", () => {
    const zeroRate = pcmWav();
    zeroRate.writeUInt32LE(0, 24);
    zeroRate.writeUInt32LE(0, 28);
    assert.throws(() => parseMonoPcm16Wav(zeroRate), /sample rate/i);

    const badBlockAlign = pcmWav();
    badBlockAlign.writeUInt16LE(4, 32);
    assert.throws(() => parseMonoPcm16Wav(badBlockAlign), /block align/i);

    const badByteRate = pcmWav();
    badByteRate.writeUInt32LE(123, 28);
    assert.throws(() => parseMonoPcm16Wav(badByteRate), /byte rate/i);
  });

  it("rejects missing data chunk / non-RIFF", () => {
    assert.throws(() => parseMonoPcm16Wav(Buffer.from("not-a-wav")), /RIFF/i);
    const headerOnly = Buffer.alloc(12);
    headerOnly.write("RIFF", 0);
    headerOnly.writeUInt32LE(4, 4);
    headerOnly.write("WAVE", 8);
    assert.throws(() => parseMonoPcm16Wav(headerOnly), /fmt|data|size/i);
  });

  it("rejects odd data size (not word-aligned for 16-bit)", () => {
    const floats = new Float32Array(4);
    const wav = encodeWav(floatTo16BitPCM(floats), 8_000);
    // Force data size to 1 (odd)
    wav.writeUInt32LE(1, 40);
    // Keep the required RIFF pad byte so the chunk walker can reach the
    // semantic 16-bit alignment check.
    const short = Buffer.concat([wav.subarray(0, 46)]);
    short.writeUInt32LE(short.length - 8, 4);
    short.writeUInt32LE(1, 40);
    assert.throws(() => parseMonoPcm16Wav(short), /word-aligned|data size/i);
  });

  it("padWavWithSilence rejects stereo input", () => {
    const stereo = pcmWav({ channels: 2, samples: 16 });
    const src = join(tmpdir(), `vdh-stereo-${Date.now()}.wav`);
    writeFileSync(src, stereo);
    try {
      assert.throws(() => padWavWithSilence(src, 0.1), /mono|channel/i);
    } finally {
      unlinkSync(src);
    }
  });

  it("rejects oversized WAVs and RIFF chunk floods before decode work", () => {
    assert.throws(
      () => parseMonoPcm16Wav(Buffer.alloc(MAX_WAV_BYTES + 1)),
      /exceeds .*byte limit/,
    );

    const flooded = Buffer.alloc(12 + (MAX_RIFF_CHUNKS + 1) * 8);
    flooded.write("RIFF", 0);
    flooded.writeUInt32LE(flooded.length - 8, 4);
    flooded.write("WAVE", 8);
    for (let i = 0; i < MAX_RIFF_CHUNKS + 1; i += 1) {
      flooded.write("JUNK", 12 + i * 8);
      flooded.writeUInt32LE(0, 12 + i * 8 + 4);
    }
    assert.throws(() => listRiffChunks(flooded), /chunk limit/);

    const oversizedPath = join(tmpdir(), `vdh-oversized-${Date.now()}.wav`);
    writeFileSync(oversizedPath, "");
    try {
      truncateSync(oversizedPath, MAX_WAV_BYTES + 1);
      assert.throws(
        () => readBoundedWavFile(oversizedPath),
        /exceeds .*byte limit/,
      );
    } finally {
      unlinkSync(oversizedPath);
    }
  });

  it("rejects trailing RIFF bytes and excessive sample rates", () => {
    const wav = pcmWav();
    assert.throws(
      () => parseMonoPcm16Wav(Buffer.concat([wav, Buffer.from([0])])),
      /trailing bytes/,
    );

    const highRate = pcmWav();
    highRate.writeUInt32LE(192_001, 24);
    highRate.writeUInt32LE(192_001 * 2, 28);
    assert.throws(() => parseMonoPcm16Wav(highRate), /sample rate/);
  });

  it("caps synthesis and silence padding before allocation", () => {
    assert.throws(
      () =>
        synthesizeSpeechEnergySamples({
          durationSec: MAX_SYNTH_DURATION_SECONDS + 1,
        }),
      /durationSec/,
    );

    const src = join(tmpdir(), `vdh-pad-cap-${Date.now()}.wav`);
    writeWavFile(src, new Float32Array([0, 0.1]), 8_000);
    try {
      assert.throws(
        () => padWavWithSilence(src, MAX_SILENCE_PADDING_SECONDS + 1),
        /seconds exceeds/,
      );
    } finally {
      unlinkSync(src);
    }
  });
});

describe("corpus read path follows generate", () => {
  it("energy and list find an id that generate just wrote in the cwd", () => {
    const consumerCwd = mkdtempSync(join(tmpdir(), "vdh-read-after-gen-"));
    const env = { ...process.env, VOICE_DEBUG_CORPUS_DIR: "" };
    const cli = (args) =>
      spawnSync(process.execPath, [CLI, ...args], {
        cwd: consumerCwd,
        env,
        encoding: "utf8",
      });
    try {
      const bundled = cli(["energy"]);
      assert.equal(bundled.status, 0, bundled.stderr);
      assert.match(bundled.stdout, /^id=coach-hashmap-explain$/m);

      const generated = cli(["generate", "--id", "local-probe"]);
      assert.equal(generated.status, 0, generated.stderr);

      const energy = cli(["energy", "--id", "local-probe"]);
      assert.equal(energy.status, 0, energy.stderr);
      assert.match(energy.stdout, /^id=local-probe$/m);

      const listed = cli(["list"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /^local-probe\twav=ok/m);
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  });
});
