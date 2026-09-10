import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installMicFeed, feedAudio, fakeDeviceArgs } from "../index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const record = process.argv.includes("--record");
if (record) {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Recording requires FFmpeg on PATH. Install it, then retry npm run demo:record.",
    );
  }
}
const output = path.join(root, "docs/assets");
const wav = await readFile(
  path.join(root, "fixtures/voice-corpus/coach-hashmap-explain.wav"),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: record,
  args: fakeDeviceArgs(),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1100 },
    deviceScaleFactor: 1,
    permissions: ["microphone"],
    ...(record
      ? { recordVideo: { dir: output, size: { width: 1280, height: 1100 } } }
      : {}),
  });
  const page = await context.newPage();
  await installMicFeed(page);
  await page.exposeFunction("playFixture", () => feedAudio(page, wav));
  await page.goto(new URL("./microphone.html", import.meta.url).href);
  await page.waitForFunction(() => window.demo?.ready || window.demo?.error);
  const error = await page.evaluate(() => window.demo.error);
  if (error) throw new Error(error);
  if (record) {
    await page.waitForTimeout(800);
    const baseline = await page.evaluate(() =>
      Math.max(...window.demo.frames.map((f) => f.rms)),
    );
    if (baseline >= 0.02) throw new Error(`Mic was not quiet: ${baseline}`);
    await page.getByRole("button", { name: "Feed the WAV" }).click();
    await page.waitForFunction(() => window.demo.done || window.demo.error);
    const result = await page.evaluate(() => window.demo.result);
    if (!result || result.rms <= 0.02)
      throw new Error("WAV did not reach the microphone");
    await page.screenshot({
      path: path.join(output, "microphone-demo.png"),
      fullPage: true,
    });
    const scope = page.locator(".scope");
    await scope.screenshot({ path: path.join(output, "microphone-focus.png") });
    const bounds = await scope.boundingBox();
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: "Replay the WAV" }).click();
    await page.waitForFunction(() => window.demo.done);
    await page.waitForTimeout(1200);
    await writeFile(
      path.join(output, "demo-result.json"),
      JSON.stringify(
        { baseline, ...result, browser: browser.version() },
        null,
        2,
      ) + "\n",
    );
    const video = page.video();
    await context.close();
    await video.saveAs(path.join(output, "microphone-demo.webm"));
    await video.delete();
    const even = (value) => Math.floor(value / 2) * 2;
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        path.join(output, "microphone-demo.webm"),
        "-vf",
        `crop=${even(bounds.width)}:${even(bounds.height)}:${even(bounds.x)}:${even(bounds.y)}`,
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
    const cover = await browser.newPage({
      viewport: { width: 1280, height: 640 },
    });
    await cover.goto(new URL("../docs/cover.html", import.meta.url).href);
    await cover.evaluate(() => document.fonts.ready);
    await cover.screenshot({ path: path.join(output, "cover.png") });
    await cover.close();
    console.log(JSON.stringify({ baseline, ...result }));
  } else {
    console.log(
      "Example open. Feed the WAV, then close the browser to finish.",
    );
    await new Promise((resolve) => browser.once("disconnected", resolve));
  }
} finally {
  await browser.close();
}
