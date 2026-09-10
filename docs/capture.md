# Making the demo

Run `node docs/capture.mjs` after installing the development dependencies and
Chromium, with `ttyd`, Claude Code, and FFmpeg on your PATH. Before recording,
open Claude Code once in this exact checkout and complete its trust prompt; the
recorder never broadens that trust automatically. It opens a
loopback-only terminal, starts Claude Code in safe mode with no settings or MCP
servers, and asks it to run `npm run test:browser`.

The script records the terminal Claude Code actually sees. It fails unless the
terminal shows the browser-check command and preserves its synthetic-browser
scope. It writes the screenshot, WebM, MP4, and a compact result record to
`docs/assets`; the existing waveform illustration remains available for the
cover image. The recording shows Claude Code's reported quiet baseline and
post-feed threshold result. It does not show or prove physical audio or
transcription.

`npm run demo:record` remains the separate browser-waveform capture helper.

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
