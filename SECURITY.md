# Security

Voice Debug Harness is a local developer-test package. It does not start a
server, watch in the background, contact a model provider, or send telemetry.

## Filesystem boundary

- Corpus IDs are validated as one safe path segment before any read or write.
- `generate` writes to `./voice-debug-corpus` under the caller's current
  directory unless `VOICE_DEBUG_CORPUS_DIR` explicitly selects another path.
  It refuses an implicit target inside the package root.
- Bundled fixtures are read-only defaults. Clean installs do not write inside
  the installed package under `node_modules`.
- Treat a configured corpus directory and its WAV/JSON files as local,
  user-controlled test input. The package rejects malformed metadata and
  malformed or unsupported WAV layouts.
- Inputs are bounded before expensive work: WAVs are at most 16 MiB and five
  minutes; metadata is at most 64 KiB; transcript comparison is bounded by
  character and word counts. Terminal control characters in metadata and
  errors are escaped before CLI output.
- `VOICE_DEBUG_CORPUS_DIR` and optional output paths passed to library helpers
  are trusted local configuration. Safe IDs block path separators, but this is
  not a filesystem sandbox: a configured directory may contain symlinks and an
  explicit output path may replace a file the caller selected.
- CLI generation fails on an existing ID unless the caller explicitly passes
  `--force`.

## Network boundary

The installed runtime modules and CLI have no HTTP client, socket, TTS,
model-provider, or telemetry path. Offline generation, energy probes, unit
tests, and the Chromium browser smoke make no outbound request; the browser
smoke opens a package-local file. Package-manager installation and
Playwright browser download may use registries configured by the caller, but
that installation traffic is outside this package's runtime.

## Browser boundary

The browser helper overrides `getUserMedia()` inside a Playwright-controlled
page so a WAV can feed the test stream. Use it only in isolated test browser
contexts; the page receives callable feed and AudioContext globals. The helper
validates and bounds the WAV before browser IPC. It does not validate a
physical microphone, production WebRTC, speech recognition, VAD, or
application behavior.

## Evidence boundary

Metadata, WAVs, browser pages, and transcript strings are inputs, not
authoritative product evidence. A browser energy pass proves only the bounded
test audio reached the overridden media stream. It is not ASR, VAD, WebRTC,
turn-taking, or end-to-end voice proof.

## Reporting

Report security issues through the repository's GitHub security advisory
form. Do not attach private recordings, transcripts, credentials, or product
data to a public issue.
