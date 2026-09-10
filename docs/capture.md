# Making the demo

Run `npm run demo:record` after installing the development dependencies and
Chromium, with FFmpeg on your PATH. The script opens the example in an isolated browser, checks that the
microphone starts quiet, clicks **Feed the WAV**, and fails unless the measured
mean RMS exceeds 0.02. It saves the full PNG and WebM, a focused PNG and MP4,
the cover PNG, and the measured result in `docs/assets`. The focused video is
cropped to the measured bounds of the waveform panel; no frames are fabricated.
The screenshot and video capture that run; the waveform is drawn from the
browser analyser. Frame timing and the measured RMS vary slightly between runs.

The example uses the package's `installMicFeed` and `feedAudio` functions. It
does not play the clip through speakers. The recording is silent because it
shows audio entering a microphone stream, not audio sent to an output device.

## Capture tools considered

- [Playwright](https://playwright.dev/docs/videos) records this browser example
  and checks its behavior in one reproducible script. It is already a development
  dependency, so this example needs no extra capture application.
- [VHS](https://github.com/charmbracelet/vhs) executes terminal sessions from
  `.tape` scripts and exports GIFs, videos, and screenshots. It is the better
  fit for demonstrations of a command-line tool. It requires ttyd and FFmpeg.
- [Freeze](https://github.com/charmbracelet/freeze) renders code and terminal
  output as images. Useful for a still of actual command output, but it cannot
  demonstrate microphone behavior.
- [Cap](https://github.com/CapSoftware/Cap) offers screen recording and local
  editing for a manually narrated walkthrough. The automated example uses
  Playwright so anyone can reproduce its actions and assertions.

The cable mark was generated with OpenAI's built-in image tool: a bold, flat
audio cable bent into a V on an ivory background. It is an illustration,
not product evidence.

Space Grotesk is distributed under the SIL Open Font License; see
[the included license](assets/OFL.txt).
