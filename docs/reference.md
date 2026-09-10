# Reference

## Start with a coding agent

Open this repository in Claude Code or Codex and paste:

> Prove this browser microphone starts silent and receives the fixture. Report
> the measured audio level from the actual Chromium check.

The resulting browser receipt should show quiet baseline energy and post-feed
mean RMS above `DEFAULT_RMS_THRESHOLD` (0.02). This proves the fixture reached
the overridden `getUserMedia()` stream in disposable Chromium. It does not
prove speech transcription, VAD, WebRTC, or a consuming app's response: the
bundled fixture is synthetic, not speech.

For an application behavior test, supply an owned mono PCM16 speech WAV and
assert that application's transcript or action after `feedAudio()`.

## CLI reference

| Command      | Role                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `list`       | Inventory corpus JSON + whether matching `.wav` exists                        |
| `energy`     | Peak + RMS on a fixture WAV                                                   |
| `generate`   | Offline synthetic-energy WAV + metadata; never performs TTS or a network call |
| `play-probe` | macOS `afplay` or RIFF header check                                           |

`generate` fails when the selected ID already exists. Pass `--force` only when
you intend to replace that local WAV/JSON pair.

### Corpus paths

| Mode                                      | Resolution                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read** (`list`, `energy`, `play-probe`) | `VOICE_DEBUG_CORPUS_DIR` if set; else first existing of cwd `voice-debug-corpus`, cwd `fixtures/voice-corpus`, package `fixtures/voice-corpus` |
| **Write** (`generate`)                    | `VOICE_DEBUG_CORPUS_DIR` if set; otherwise `./voice-debug-corpus` under the process cwd, unless that would enter the package root              |

Clean installs must not mutate files inside the package under `node_modules`.
An implicit write from the package root fails closed; run from a consumer
project or set `VOICE_DEBUG_CORPUS_DIR` explicitly.

### Environment

| Variable                 | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `VOICE_DEBUG_CORPUS_DIR` | Override corpus folder for reads and writes |

Consumer-specific environment aliases belong in consumer wrappers, not this portable package.

## Browser smoke

```bash
npx playwright install chromium   # once per machine
npm run test:browser
```

Prints one JSON receipt with Node-side and browser analyser energy. Fails if energy stays below `DEFAULT_RMS_THRESHOLD` (0.02). Requires Playwright + Chromium; offline `npm test` does **not** depend on Playwright.

## Library imports

```js
import {
  writeWavFile,
  synthesizeSpeechEnergySamples,
  measureWavEnergy,
  measureRms,
  installMicFeed,
  feedAudio,
  padWavWithSilence,
  fakeDeviceArgs,
  buildVoiceDebugLaunchArgs,
} from "voice-debug-harness";
```

Relative import from this tree: `./index.mjs` (or package subpath exports
`./wav`, `./energy`, `./mic-feed`, `./chromium`, `./corpus`, `./wer`).

### Injection primitives

1. **Primary (multi-turn):** `installMicFeed(page)` before navigation, then `feedAudio(page, wavBytes)` after `getUserMedia`.
2. **Secondary (single-shot):** `fakeMicFileCaptureArgs(wavPath)` → Chromium `--use-file-for-fake-audio-capture=…`.
3. **Energy:** `measureWavEnergy` / `measureRms` on Node; browser smoke uses a Web Audio analyser on the returned stream.

The runnable [browser smoke](../browser-smoke.mjs) shows the complete sequence:
launch a disposable Chromium context, install the override, open the stream,
check that it starts quiet, feed the bundled WAV, and measure the resulting
energy. Run `npm run test:browser` after installing Chromium to try it without
an app server or model account. The synthetic fixture tests the audio path;
bring a speech recording when your test needs recognizable words.

## Integration notes (engineers)

This package is **I/O and energy only**. Product adapters (app routes, session
mocks, entitlement gates, live STT assertions) stay in the consuming
application. `wordErrorRate()` only compares two caller-supplied strings. It
does not run ASR and the package publishes no calibrated production threshold.

## Corpus format

| File        | Role                                                   |
| ----------- | ------------------------------------------------------ |
| `<id>.wav`  | Mono 16-bit PCM WAV that you own or may use            |
| `<id>.json` | `{ id, text, sampleRate?, source?, peakAbs?, notes? }` |

To use real speech, bring your own matching WAV and JSON files:

```bash
mkdir -p ./my-corpus
cp /path/to/your-owned-clip.wav ./my-corpus/hello.wav
printf '%s\n' '{"id":"hello","text":"what the clip actually says","source":"user-supplied"}' \
  > ./my-corpus/hello.json
VOICE_DEBUG_CORPUS_DIR=./my-corpus node cli.mjs list
VOICE_DEBUG_CORPUS_DIR=./my-corpus node cli.mjs energy --id hello
```

The WAV must be mono PCM16, at most 16 MiB, no longer than five minutes, and
use a sample rate no higher than 192 kHz. Metadata is limited to 64 KiB, corpus
text to 4,000 characters, and a listed directory to 1,000 JSON entries.
Transcript comparison is bounded to 20,000 input characters and 1,000
normalized words per side. Oversized or malformed input fails before expensive
audio or edit-distance work. Synthetic generation is capped at 30 seconds and
one padding operation at 60 seconds.

`VOICE_DEBUG_CORPUS_DIR`, optional output paths passed to library helpers, and
the supplied Playwright page are trusted local test configuration. Corpus IDs
block separator traversal, but the package does not sandbox a configured
directory or follow-up writes through symlinks. Use the mic override only in a
disposable test context.

Bundled fixtures under `fixtures/voice-corpus/` are synthetic and support
offline energy-path checks only. They are not speech or transcription evidence.

## Network statement

The installed runtime modules and `voice-debug` CLI contain no HTTP client,
socket, telemetry, TTS, or model-provider path. `npm install` and
`npx playwright install chromium` may use the package registries configured on
your machine; that installation traffic is outside the runtime. The included
browser smoke opens a local file and makes no network request.

## License

MIT — see [LICENSE](../LICENSE). The bundled fixture is generated by this package;
users are responsible for rights to corpus files they add.
