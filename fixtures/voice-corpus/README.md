# Offline audio-energy corpus

Bundled mono PCM WAV + JSON metadata for offline energy-path checks.

## Provenance

| Fixture                   | Source                               | Notes                                                          |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `coach-hashmap-explain.*` | Package offline energy synthesizer   | Tone bursts with a speech-like envelope; not linguistic speech |
| `ci-offline-synth.*`      | Same synthesizer (temporary CI data) | Generated in a temporary directory by `npm run ci:offline`     |

## Limits

- Fixtures assert **audio energy / decode chain** behavior, not speech,
  product STT, VAD, WebRTC, or end-to-end voice behavior.
- The `text` field labels the intended test scenario; the synthetic tone does
  not speak that text.
- No bundled fixture establishes a word-error-rate threshold.

## Refresh (optional)

```bash
# Offline synth into a cwd-local write dir
node ../../cli.mjs generate --id my-clip

# Or pin the corpus folder explicitly
VOICE_DEBUG_CORPUS_DIR=./ node ../../cli.mjs generate --id coach-hashmap-explain
```

## Add your own speech

Use audio you own or may redistribute. Add matching `<id>.wav` and `<id>.json`
files; IDs must match and be one safe path segment.

```json
{
  "id": "hello",
  "text": "what the recording actually says",
  "source": "user-supplied"
}
```

WAV input must be mono PCM16, no more than 16 MiB or five minutes, and at most
192 kHz. Validate it without any network call:

```bash
VOICE_DEBUG_CORPUS_DIR=./ node ../../cli.mjs list
VOICE_DEBUG_CORPUS_DIR=./ node ../../cli.mjs energy --id hello
```
