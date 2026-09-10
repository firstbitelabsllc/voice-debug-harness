import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href
    : "playwright"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
const output = path.join(root, "docs", "assets");
await mkdir(output, { recursive: true });
const server = spawn(
  "ttyd",
  [
    "-p",
    "8853",
    "-i",
    "127.0.0.1",
    "-O",
    "-o",
    "-W",
    "-w",
    root,
    "-t",
    "fontSize=20",
    "-t",
    "screenReaderMode=true",
    "-t",
    "fontFamily=Menlo",
    "-t",
    'theme={"background":"#f4f2eb","foreground":"#212920","cursor":"#b6532a"}',
    "claude",
    "--safe-mode",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--model", "sonnet",
    "--effort", "low",
    "--tools", "Bash,Read",
    "--allowedTools", "Bash(npm run test:browser)",
  ],
  {
    env: {
      ...process.env,
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
server.stderr.on("data", (chunk) => (logs += chunk));
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error(logs || "ttyd startup timeout")),
      10000,
    );
    server.stderr.on("data", () => {
      if (logs.includes("Listening on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error("ttyd exited " + code + " " + logs));
    });
  });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 820 },
    recordVideo: { dir: output, size: { width: 1440, height: 820 } },
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8853");
  await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  await page.addStyleTag({
    content:
      "body{background:#e6e4dd!important;margin:0!important;padding:0!important}#terminal-container{position:fixed!important;inset:60px!important;width:auto!important;height:auto!important;border-radius:12px;overflow:hidden;padding:0!important;background:#f4f2eb;box-sizing:border-box!important;box-shadow:0 0 0 20px #f4f2eb}.xterm{height:100%!important;padding:0!important}",
  });
  // ttyd fits xterm before the inset frame lands. Resize twice after the frame
  // is present so the terminal recalculates its full visible grid.
  await page.setViewportSize({ width: 1439, height: 820 });
  await page.setViewportSize({ width: 1440, height: 820 });
  await page.waitForTimeout(800);
  await page.waitForFunction(
    () => document.body.textContent.includes("Claude Code"),
    null,
    { timeout: 15000 },
  );
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    "Run npm run test:browser. Report baseline and post-feed RMS in two bullets, 35 words total. This uses a synthetic browser microphone; do not claim physical audio or speech recognition.",
    { delay: 25 },
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => /done \d+:\d+ [AP]M/.test(document.body.textContent),
    null,
    { timeout: 120000 },
  );
  const terminalText = await page.locator("body").innerText();
  if (!/Bash\(npm run test:browser(?:\s|\))/.test(terminalText))
    throw Error("Claude Code did not show the native browser-check tool invocation");
  if (!terminalText.includes("synthetic browser microphone"))
    throw Error("Claude Code did not retain the synthetic-browser scope");
  await page.screenshot({ path: path.join(output, "microphone-demo.png") });
  await page.waitForTimeout(2200);
  await page.waitForTimeout(4000);
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(output, "microphone-demo.webm"));
  await video.delete();
  for (const name of ["microphone-demo.png", "microphone-demo.webm"])
    if ((await stat(path.join(output, name))).size < 1000)
      throw Error("Capture missing: " + name);
  await writeFile(
    path.join(output, "capture-result.json"),
    JSON.stringify(
      {
        command: "npm run test:browser",
        proof: "Native interactive Claude Code ran the isolated Chromium browser check",
        scope:
          "Synthetic audio through a browser microphone; this does not test physical audio or speech recognition.",
        browser: browser.version(),
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      path.join(output, "microphone-demo.webm"),
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(output, "microphone-focus.mp4"),
    ],
    { stdio: "ignore" },
  );
  console.log("Verified native Claude Code screenshot and recording exist.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
