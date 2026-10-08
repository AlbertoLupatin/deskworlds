import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Renders a deskworlds scene offline to a seamlessly looping VP9 webm, plus
// <out base>-thumb.jpg. The page clock is virtual: every captured frame advances
// the scene by exactly 1/fps, so the clip is smooth at any fps no matter how long
// the GPU takes per frame (that only changes how long the export runs).
//
// Usage:
//   node tools/render-clips.mjs <scene> <out.webm> [seconds] [width] [height] [quality] [fps]

const [, , scene, outFile, secs = "30", width = "1920", height = "1080", quality = "native", fpsArg = "30"] =
  process.argv;
if (!scene || !outFile) {
  console.error("usage: render-clips.mjs <scene> <out.webm> [seconds] [width] [height] [quality] [fps]");
  process.exit(2);
}
const FPS = +fpsArg;
const DUR = +secs;
const FADE = Math.min(2, DUR / 4); // loop crossfade, seconds
const WARMUP = 4; // virtual seconds simulated before capture: loading fade, school settles
const port = 9333;
const base = outFile.replace(/\.webm$/, "");
const url = `http://127.0.0.1:${process.env.PORT || 8790}/scenes/${scene}/wallpaper.html?quality=${quality}`;

// Injected before any page script: performance.now, rAF and setTimeout all run on
// a virtual clock that only moves when the recorder calls __advance(ms).
const VIRTUAL_CLOCK = `(() => {
  let t = 0, nextId = 1;
  const rafs = new Map(), timers = new Map();
  performance.now = () => t;
  window.requestAnimationFrame = (fn) => { const id = nextId++; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => rafs.delete(id);
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextId++; timers.set(id, { due: t + Math.max(0, +ms || 0), fn, args }); return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.__advance = (ms) => {
    const end = t + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of timers) if (timer.due <= end && (!next || timer.due < next[1].due)) next = [id, timer];
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].due);
      if (typeof next[1].fn === "function") next[1].fn(...next[1].args);
    }
    t = end;
    const due = [...rafs.values()];
    rafs.clear();
    for (const fn of due) fn(t);
  };
})();`;

mkdirSync(dirname(outFile), { recursive: true });

const chrome = spawn("chromium-browser", [
  "--headless=new",
  "--no-sandbox",
  `--remote-debugging-port=${port}`,
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--mute-audio",
  `--window-size=${width},${height}`,
  "--hide-scrollbars",
  "about:blank",
], { stdio: ["ignore", "ignore", "inherit"] });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = async (target, tries = 0) => {
  try {
    const r = await fetch(target);
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } catch (e) {
    if (tries > 150) throw e;
    await wait(200);
    return getJSON(target, tries + 1);
  }
};

async function main() {
  const targets = await getJSON(`http://127.0.0.1:${port}/json`);
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };
  await new Promise((res) => (ws.onopen = res));
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: VIRTUAL_CLOCK });
  await send("Page.navigate", { url });

  // Assets load in real time; the scene is ready once it has published its stats hook.
  for (let i = 0; !(await evaluate("typeof window.sceneStats === 'function'")); i++) {
    if (i > 300) throw new Error(`${scene} never became ready`);
    await wait(100);
  }
  // wallpaper.html leaves the frame rate to its host; 60 keeps one draw per step at any fps <= 60.
  await evaluate("window.sceneRate(60)");
  for (let s = 0; s < WARMUP * 10; s++) await evaluate("__advance(100)");

  const ff = spawn("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-",
    "-filter_complex",
    `[0:v]split[a][b];[a]trim=start=${FADE},setpts=PTS-STARTPTS[main];` +
    `[b]trim=end=${FADE},setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=fade:duration=${FADE}:offset=${DUR - FADE},format=yuv420p`,
    "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-cpu-used", "4",
    "-an", "-auto-alt-ref", "0", outFile,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((r) => ff.on("close", r));

  // DUR + FADE seconds: the extra tail is crossfaded into the head so the clip loops.
  const total = Math.round((DUR + FADE) * FPS);
  const step = 1000 / FPS;
  const t0 = Date.now();
  let previous = "", duplicates = 0;
  for (let i = 0; i < total; i++) {
    await evaluate(`__advance(${step})`);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
    const frame = Buffer.from(data, "base64");
    const hash = createHash("sha1").update(frame).digest("hex");
    if (hash === previous) duplicates++;
    previous = hash;
    if (i === 0) writeFileSync(`${base}-thumb.jpg`, frame);
    if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % FPS === 0) process.stdout.write(`\r[${scene}] ${i}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  const code = await ffDone;
  chrome.kill();
  console.log(`\n[${scene}] ${total} frames @ ${FPS} fps in ${((Date.now() - t0) / 1000).toFixed(0)}s, ` +
    `${duplicates} repeated frames -> ${outFile}${code ? ` (ffmpeg exit ${code})` : ""}`);
  process.exit(code ? 1 : 0);
}
main().catch((e) => { console.error(`[${scene}]`, e.message); chrome.kill(); process.exit(1); });
