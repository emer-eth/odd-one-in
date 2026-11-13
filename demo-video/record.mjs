// Records the product demo from the live site, scene by scene, as timestamped frames.
//   node demo-video/record.mjs            every scene (the live round takes about 8 minutes)
//   node demo-video/record.mjs o01 o09    only these (use "live" for the real round: scenes o04 to o07)
// Then: node demo-video/assemble.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const DIR = import.meta.dirname;
const SITE = "https://odd-one-in-zeta.vercel.app/";
const SCRIPT = JSON.parse(readFileSync(join(DIR, "script.json"), "utf8"));
const DUR = JSON.parse(readFileSync(join(DIR, "vo/durations.json"), "utf8"));
const need = (id) => (DUR[id].sec + 0.9) * 1000; // how long the scene runs in the film
const only = process.argv.slice(2);
const want = (id) => !only.length || only.includes(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shell = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1234");
const EXE = join(shell, readdirSync(shell).find((d) => d.startsWith("chrome")), "chrome-headless-shell");

// A visible cursor, the caption bar, and room for it under the page's own sticky bar.
const INIT = `
(() => {
  const setup = () => {
    if (document.getElementById("__cur")) return;
    const st = document.createElement("style");
    st.textContent = ".sticky.bottom-3{bottom:84px!important}[role=dialog]{padding-bottom:76px!important}#__cur{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(243,240,255,.92);border:2px solid #12101c;box-shadow:0 2px 10px rgba(0,0,0,.5);pointer-events:none;left:-50px;top:-50px;transition:transform .12s ease}#__cur.down{transform:scale(.7)}";
    document.documentElement.appendChild(st);
    const c = document.createElement("div");
    c.id = "__cur";
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => c.classList.add("down"), true);
    addEventListener("mouseup", () => c.classList.remove("down"), true);
  };
  if (document.documentElement) setup();
  document.addEventListener("DOMContentLoaded", setup);
})();`;

let page;
let cap = { text: "", tag: "" };
async function caption(id) {
  const s = SCRIPT.find((x) => x.id === id);
  cap = { text: s?.cap ?? "", tag: s?.tag ?? "" };
  await page
    .evaluate(({ text, tag }) => {
      let el = document.getElementById("__cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "__cap";
        el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:#0c0a14;border-top:1px solid #332d54;color:#f3f0ff;padding:17px 40px;font:500 21px/1.35 'DM Sans',system-ui,sans-serif;display:flex;gap:18px;align-items:baseline";
        document.documentElement.appendChild(el);
      }
      el.style.display = text ? "flex" : "none";
      el.innerHTML = (tag ? `<span style="font:500 12px 'DM Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#c6ff4d;white-space:nowrap">${tag}</span>` : "") + `<span>${text}</span>`;
    }, cap)
    .catch(() => {});
}

class Recorder {
  constructor(scene, fps = 15) {
    this.scene = scene;
    this.fps = fps;
    this.frames = [];
    this.marks = [];
    this.dir = join(DIR, "frames", scene);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
  start() {
    this.on = true;
    this.loop = (async () => {
      let i = 0;
      while (this.on) {
        const t = Date.now();
        try {
          const f = `${String(i++).padStart(5, "0")}.jpg`;
          writeFileSync(join(this.dir, f), await page.screenshot({ type: "jpeg", quality: 90 }));
          this.frames.push({ f, t });
        } catch {}
        const left = 1000 / this.fps - (Date.now() - t);
        if (left > 0) await wait(left);
      }
    })();
    return this;
  }
  mark(name) {
    this.marks.push({ name, t: Date.now() });
    console.log(`  · ${name}`);
  }
  async stop() {
    this.on = false;
    await this.loop;
    writeFileSync(join(this.dir, "frames.json"), JSON.stringify({ scene: this.scene, end: Date.now(), frames: this.frames, marks: this.marks }));
    console.log(`  ${this.scene}: ${this.frames.length} frames, ${((this.frames.at(-1).t - this.frames[0].t) / 1000).toFixed(1)}s`);
  }
}

/** Glide the cursor to the middle of an element, then click it. */
async function click(locator, steps = 28) {
  let b = await locator.boundingBox();
  // keep the target clear of the caption bar and the nav
  if (b.y + b.height > 700 || b.y < 70) {
    await scrollTo(Math.max(0, (await page.evaluate(() => scrollY)) + b.y - 380), 700);
    await wait(200);
    b = await locator.boundingBox();
  }
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
  await wait(250);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
}
const scrollTo = (y, ms = 1100) =>
  page.evaluate(
    ([y, ms]) =>
      new Promise((done) => {
        const from = scrollY, t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms), e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
          scrollTo(0, from + (y - from) * e);
          p < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
const topOf = async (locator, offset = 90) => Math.max(0, (await page.evaluate(() => scrollY)) + (await locator.boundingBox()).y - offset);
/** Seconds left in the round, read from the page's own countdown. */
async function left() {
  const m = (await page.locator("#play").innerText()).match(/closes in\s*(\d+):(\d+)/i);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
const roundNo = async () => Number((await page.locator("#play").innerText()).match(/Round\s+(\d+)/i)?.[1]);
/** Waits for a table of regulars and at least `min` seconds left (but no more than `max`). */
async function goodMoment(min, max = 999) {
  for (;;) {
    const table = await page.getByText(/^Leaning/).count();
    const s = await left();
    if (table && s >= min && s <= max) return s;
    await wait(2000);
  }
}
/** The side fewer regulars lean to (violet on a tie): the better read. */
async function emptierSide() {
  const boxes = await page.locator("#play").getByText(/^Leaning (orange|violet) · \d/).allInnerTexts();
  const n = (w) => Number(boxes.find((b) => b.toLowerCase().includes(w))?.match(/(\d+)\s*$/)?.[1] ?? 0);
  return n("orange") < n("violet") ? "ORANGE" : "VIOLET";
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
async function fresh(url = SITE) {
  if (page) await page.context().close();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark", reducedMotion: "no-preference" });
  await ctx.addInitScript(INIT);
  page = await ctx.newPage();
  page.on("load", () => cap.text && caption(SCRIPT.find((s) => s.cap === cap.text)?.id));
  if (url) {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByText(/closes in/i).waitFor({ timeout: 30000 });
  }
}

// ---------- the real round: seal as a guest, the regulars join, the picks open, the result arrives ----------
if (want("live")) {
  console.log("live round");
  await fresh();
  const s = await goodMoment(75, 125);
  const side = await emptierSide();
  const round = await roundNo();
  console.log(`  round ${round}, ${s}s left, picking ${side}`);
  await caption("o04");
  await page.mouse.move(720, 330);
  const rec = new Recorder("live", 15).start();
  await wait(1400);
  await click(page.getByRole("button", { name: new RegExp(`PICK ${side}`) }));
  await wait(1100);
  await click(page.getByRole("button", { name: "Seal my pick" }));
  await page.getByText("Your pick is in.").waitFor({ timeout: 90000 });
  await page.mouse.move(1300, 430, { steps: 20 });
  await wait(1600);
  rec.mark("sealed");
  await caption("o05");
  await scrollTo(0, 600);
  for (let i = 0; i < 25; i++) {
    if (/Sealed\s*[5-9]/i.test(await page.locator("#play").innerText())) break;
    await wait(2000);
  }
  await wait(2500);
  rec.mark("joined");
  rec.fps = 3;
  while ((await roundNo()) === round) await wait(1000);
  rec.mark("rolled");
  await caption("o06");
  rec.fps = 14;
  const crowd = page.getByText(new RegExp(`Round ${round} · opening now`, "i"));
  await crowd.waitFor({ timeout: 30000 }).catch(() => {});
  await scrollTo(await topOf(crowd, 96), 900);
  await page.locator("svg text", { hasText: "YOU" }).first().waitFor({ timeout: 60000 }).catch(() => console.log("  (no YOU circle seen)"));
  await wait(7000);
  rec.mark("opened");
  rec.fps = 1;
  const result = page.getByText(/You were the odd one in\.|You went with the crowd\.|No minority this time/);
  await result.first().waitFor({ timeout: 300000 });
  rec.mark("result");
  await caption("o07");
  rec.fps = 14;
  await wait(8000);
  console.log("  result:", (await result.first().innerText()).slice(0, 60));
  await rec.stop();
}

if (want("o01")) {
  console.log("o01");
  await fresh();
  await goodMoment(40);
  await caption("o01");
  await page.mouse.move(980, 250);
  const rec = new Recorder("o01").start();
  await wait(3200);
  await page.mouse.move(360, 540, { steps: 50 });
  await wait(1800);
  await page.mouse.move(920, 540, { steps: 50 });
  await wait(need("o01") - 6500);
  await rec.stop();
}

if (want("o02") || want("o03")) {
  await fresh();
  await goodMoment(55);
  if (want("o02")) {
    console.log("o02");
    await caption("o02");
    await page.mouse.move(700, 330);
    const rec = new Recorder("o02").start();
    await wait(1500);
    const seats = page.locator("#play button[aria-label*='Open their record']");
    await scrollTo(190, 900);
    await wait(700);
    await click(seats.first());
    await wait(Math.max(4500, need("o02") - 4500));
    await rec.stop();
    await page.keyboard.press("Escape");
    await wait(400);
  }
  if (want("o03")) {
    console.log("o03");
    await caption("o03");
    const side = (await emptierSide()) === "ORANGE" ? "A" : "B";
    // A practice round is a fresh roll each time: take the one where the read pays off, so the film shows a win once.
    for (let take = 1; take <= 8; take++) {
      const rec = new Recorder("o03").start();
      await wait(500);
      await click(page.getByRole("button", { name: /Practice round · 10/ }));
      await wait(1500);
      await click(page.getByRole("button", { name: new RegExp(`PRACTICE ${side}`) }));
      await page.getByText(/You were the odd one in\.|You went with the crowd\.|No smaller side\. Void\./).last().waitFor({ timeout: 20000 });
      await wait(2600);
      await rec.stop();
      const won = await page.getByText("You were the odd one in.").count();
      console.log(`  take ${take}: ${won ? "won" : "not a win"}`);
      if (won) break;
      await page.keyboard.press("Escape");
      await wait(500);
    }
  }
}

if (want("o08")) {
  console.log("o08");
  await fresh();
  await caption("o08");
  await page.mouse.move(1000, 300);
  await page.evaluate(async (y) => scrollTo(0, y), await topOf(page.locator("#regulars"), 150));
  await wait(600);
  const rec = new Recorder("o08").start();
  await wait(700);
  await scrollTo(await topOf(page.locator("#regulars"), 70), 900);
  await wait(3600);
  await scrollTo(await topOf(page.locator("#rounds"), 70), 1200);
  await wait(900);
  await click(page.getByRole("button", { name: /Replay/ }).first());
  await wait(6500);
  await rec.stop();
}

const fonts = `<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">`;
const base = `*{box-sizing:border-box}html,body{margin:0;height:100%;background:#12101c;color:#f3f0ff;font-family:'DM Sans',sans-serif;overflow:hidden}body{background-image:radial-gradient(1200px 600px at 78% -10%,rgba(124,92,255,.16),transparent 60%),radial-gradient(900px 500px at 0% 0%,rgba(255,107,74,.08),transparent 55%)}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`;

if (want("o09")) {
  console.log("o09");
  await fresh(null);
  const lines = readFileSync(join(DIR, "judge-output.txt"), "utf8").split("\n").filter((l) => l.trim() && !l.includes("add `-- --play`"));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const row = (l, i) => {
    const head = !/^\s/.test(l) && !l.startsWith("✅");
    const m = l.match(/^(\s*(?:✅|➖|❌)\s)(.*?)(\s\s\(.*\))?$/);
    const body = m ? `<span>${m[1]}</span><span style="color:#f3f0ff">${esc(m[2])}</span><span style="color:#7d789c">${esc(m[3] ?? "")}</span>` : esc(l);
    return `<div style="opacity:0;animation:in .25s ease ${(1.5 + i * 0.2).toFixed(2)}s forwards;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${head ? "margin-top:11px;color:#c6ff4d" : "color:#a49fc0"}${l.startsWith("✅") ? ";margin-top:14px;color:#c6ff4d;font-weight:500" : ""}">${body}</div>`;
  };
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>${base}</style></head><body>
    <div style="position:absolute;left:70px;right:70px;top:34px;bottom:96px;border:1px solid #332d54;border-radius:18px;background:#171428;overflow:hidden">
      <div style="display:flex;gap:8px;padding:14px 18px;border-bottom:1px solid #332d54"><i style="width:11px;height:11px;border-radius:50%;background:#ff6b4a"></i><i style="width:11px;height:11px;border-radius:50%;background:#7c5cff"></i><i style="width:11px;height:11px;border-radius:50%;background:#c6ff4d"></i><span style="margin-left:14px;font:400 12px 'DM Mono';color:#7d789c">odd-one-in</span></div>
      <div style="padding:14px 26px;font:400 13.5px/1.5 'DM Mono',monospace">
        <div style="color:#f3f0ff;opacity:0;animation:in .3s ease .4s forwards"><span style="color:#c6ff4d">$</span> npm run judge</div>
        ${lines.map(row).join("")}
      </div>
    </div></body></html>`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  await caption("o09");
  await page.evaluate(() => document.getAnimations().forEach((a) => { a.cancel(); a.play(); }));
  const rec = new Recorder("o09").start();
  await wait(need("o09") + 800);
  await rec.stop();
}

if (want("o10")) {
  console.log("o10");
  await fresh(null);
  const at = (s) => `opacity:0;animation:in .6s cubic-bezier(.2,.8,.2,1) ${s}s forwards`;
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>${base}</style></head><body>
    <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center"><div>
      <svg viewBox="0 0 44 28" style="height:92px;${at(0.2)}"><circle cx="7" cy="9" r="5.5" fill="#ff6b4a"/><circle cx="16" cy="18" r="7" fill="#ff6b4a"/><circle cx="5" cy="21" r="3.5" fill="#ff6b4a"/><circle cx="34" cy="14" r="5.5" fill="#7c5cff"/><circle cx="34" cy="14" r="9" fill="none" stroke="#c6ff4d" stroke-width="1.6" stroke-dasharray="3 2.5"/></svg>
      <div style="font:800 76px/1 Unbounded;letter-spacing:-.045em;margin-top:26px;${at(0.5)}">odd one in</div>
      <div style="font:400 24px 'DM Sans';color:#a49fc0;margin-top:22px;${at(0.9)}">The smaller crowd wins. Read the table, then be the odd one.</div>
      <div style="font:500 20px 'DM Mono';color:#c6ff4d;margin-top:44px;${at(1.4)}">odd-one-in-zeta.vercel.app</div>
      <div style="font:400 15px 'DM Mono';color:#a49fc0;margin-top:14px;letter-spacing:.04em;${at(1.7)}">github.com/emer-eth/odd-one-in · live on NEAR testnet, with test NEAR</div>
    </div></div></body></html>`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.getAnimations().forEach((a) => { a.cancel(); a.play(); }));
  await caption("o10");
  const rec = new Recorder("o10").start();
  await wait(need("o10") + 2600);
  await rec.stop();
}

await browser.close();
console.log("recorded.");
