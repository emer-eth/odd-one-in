// Builds the demo video from the recorded frames and the narration: node demo-video/assemble.mjs
// Each scene lasts as long as its line plus a breath. Footage that runs long is sped up to fit; footage
// that runs short holds its last picture.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dirname;
const DUR = JSON.parse(readFileSync(join(dir, "vo/durations.json"), "utf8"));
const SCRIPT = JSON.parse(readFileSync(join(dir, "script.json"), "utf8"));
const LEAD = 0.4, TAIL = 0.5;

const load = (scene) => {
  const d = JSON.parse(readFileSync(join(dir, "frames", scene, "frames.json"), "utf8"));
  const t0 = d.frames[0].t;
  return { frames: d.frames.map((f) => ({ f: join(dir, "frames", scene, f.f), t: (f.t - t0) / 1000 })), end: (d.end - t0) / 1000, marks: Object.fromEntries(d.marks.map((m) => [m.name, (m.t - t0) / 1000])) };
};
/** Frames between two times, as [file, seconds shown]. */
function cut(d, from = 0, to = d.end) {
  const out = [];
  d.frames.forEach((f, i) => {
    const start = Math.max(f.t, from), end = Math.min(d.frames[i + 1]?.t ?? d.end, to);
    if (end > start) out.push([f.f, end - start]);
  });
  return out;
}
const total = (seg) => seg.reduce((a, [, s]) => a + s, 0);
function fit(seg, target) {
  const t = total(seg);
  if (t >= target) return seg.map(([f, s]) => [f, (s * target) / t]);
  return [...seg.slice(0, -1), [seg.at(-1)[0], seg.at(-1)[1] + target - t]];
}

const live = load("live");
const m = live.marks;
const FOOTAGE = {
  o04: () => cut(live, 0, m.sealed),
  // the regulars joining at natural speed, then the wait for the round to close run fast
  o05: (T) => { const a = cut(live, m.sealed, m.joined), b = cut(live, m.joined, m.rolled); const ta = Math.min(total(a), T * 0.62); return [...fit(a, ta), ...fit(b, T - ta)]; },
  o06: () => cut(live, m.rolled, m.opened),
  o07: () => cut(live, m.result),
};

mkdirSync(join(dir, "build"), { recursive: true });
const parts = [];
let at = 0;
for (const s of SCRIPT) {
  const last = s === SCRIPT.at(-1);
  const T = LEAD + DUR[s.id].sec + TAIL + (last ? 2.2 : 0);
  const raw = FOOTAGE[s.id] ? FOOTAGE[s.id](T) : cut(load(s.id));
  const seg = fit(raw, T);
  const list = join(dir, "build", `${s.id}.txt`);
  writeFileSync(list, seg.map(([f, sec]) => `file '${f}'\nduration ${sec.toFixed(4)}`).join("\n") + `\nfile '${seg.at(-1)[0]}'\n`);
  const out = join(dir, "build", `${s.id}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", join(dir, "vo", `${s.id}.wav`),
    "-filter_complex", `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v];[1:a]adelay=${LEAD * 1000}:all=1,apad[a]`,
    "-map", "[v]", "-map", "[a]", "-t", T.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", out]);
  parts.push(out);
  console.log(`${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}  ${s.id}  ${T.toFixed(1)}s  footage ${total(raw).toFixed(1)}s (x${(total(raw) / T).toFixed(1)})`);
  at += T;
}
writeFileSync(join(dir, "build", "all.txt"), parts.map((p) => `file '${p}'`).join("\n"));
const final = join(dir, "odd-one-in-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "build", "all.txt"),
  "-vf", `fade=t=in:st=0:d=0.5,fade=t=out:st=${(at - 0.8).toFixed(2)}:d=0.8`, "-af", `afade=t=out:st=${(at - 0.8).toFixed(2)}:d=0.8`,
  "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", final]);
console.log(`\n${final}\n${Math.floor(at / 60)} min ${Math.round(at % 60)} s`);
