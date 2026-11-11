import { useEffect, useState } from "react";
import { fmtNear, type ClaimItem, type RoundView } from "../lib/near";

const COPY: Record<ClaimItem["result"], string> = {
  Win: "You were the odd one in.",
  Lose: "You went with the crowd.",
  Void: "No minority this time. Stake returned.",
  Forfeit: "Your vote was never opened. Stake and bond forfeited.",
};

/** Bars grow from zero to the final counts, the smaller one lights up, then the outcome appears. */
export function ResultCard({ item, round, stake, onClose }: { item: ClaimItem; round: RoundView; stake: string; onClose: () => void }) {
  const [grown, setGrown] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const a = requestAnimationFrame(() => setGrown(true));
    const t = setTimeout(() => setShown(true), reduce ? 0 : 1300);
    return () => {
      cancelAnimationFrame(a);
      clearTimeout(t);
    };
  }, []);

  const { revealed_a: a, revealed_b: b } = round;
  const max = Math.max(a, b, 1);
  const winA = item.outcome === "A";
  const winB = item.outcome === "B";
  // Balance change for this round at claim time, relative to the stake paid in.
  const change = BigInt(item.credited) + BigInt(item.bonus) - BigInt(stake);

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Round result">
      <div className="w-full max-w-lg rounded-3xl text-chalk bg-board p-6 sm:p-8 border border-board-line">
        <p className="font-mono text-xs uppercase tracking-widest text-dim">Round {item.round_id} result</p>
        <h2 className="mt-2 display text-xl sm:text-2xl font-extrabold">{round.question.text}</h2>
        <div className="mt-6 space-y-3">
          {([
            ["A", round.question.a, a, winA, "bg-side-a"],
            ["B", round.question.b, b, winB, "bg-side-b"],
          ] as const).map(([side, label, n, lit, color]) => (
            <div key={side}>
              <div className="flex justify-between text-sm mb-1">
                <span className={lit && grown ? "text-odd font-bold" : ""}>
                  {label} {item.choice === side && <span className="text-dim">· your pick</span>}
                </span>
                <span className="font-mono">{n}</span>
              </div>
              <div className="h-4 rounded-full bg-board-2 overflow-hidden">
                <div
                  className={`bar h-full rounded-full ${color} ${lit && shown ? "ring-2 ring-odd shadow-[0_0_24px_var(--color-odd)]" : ""}`}
                  style={{ width: grown ? `${(n / max) * 100}%` : "0%" }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className={`mt-6 transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`} aria-live="polite">
          <p className={`text-xl font-bold ${item.result === "Win" ? "text-odd" : ""}`}>{COPY[item.result]}</p>
          <p className="mt-1 font-mono text-sm text-dim">
            {change >= 0n ? "+" : ""}
            {fmtNear(change)} NEAR
            {item.bonus !== "0" && <span className="text-odd"> · streak bonus {fmtNear(item.bonus)}</span>}
            {" · "}streak {item.streak}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={() => shareCard(item, round)} className="flex-1 rounded-full border border-board-line px-4 py-3 font-bold hover:border-chalk">
              Save card
            </button>
            <a href={postUrl(item, round)} target="_blank" rel="noreferrer" className="flex-1 rounded-full border border-board-line px-4 py-3 text-center font-bold hover:border-chalk">
              Post on X
            </a>
            <button onClick={onClose} className="flex-1 rounded-full bg-chalk text-board px-4 py-3 font-bold">
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A ready-to-post line about this round, opened in X's composer. */
function postUrl(item: ClaimItem, round: RoundView) {
  const small = Math.min(round.revealed_a, round.revealed_b);
  const big = Math.max(round.revealed_a, round.revealed_b);
  const line =
    item.result === "Win"
      ? `I was the odd one in. "${round.question.text}" split ${small} to ${big}, and I picked the smaller side.`
      : item.result === "Lose"
        ? `I went with the crowd. "${round.question.text}" split ${small} to ${big}, and the smaller side won.`
        : `"${round.question.text}" had no smaller side this round.`;
  const text = `${line}\n\nOdd One In, round ${item.round_id}, on @NEARProtocol testnet`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://odd-one-in-zeta.vercel.app")}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Renders a 1200×675 PNG (X card size) and shares it, or downloads it where sharing files isn't supported. */
async function shareCard(item: ClaimItem, round: RoundView) {
  await document.fonts.ready;
  const W = 1200;
  const H = 675;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#12101C";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#A49FC0";
  ctx.font = "600 24px 'DM Mono', monospace";
  ctx.fillText(`ODD ONE IN · ROUND ${item.round_id}`, 72, 92);
  ctx.fillStyle = "#F3F0FF";
  ctx.font = "800 60px 'Unbounded', sans-serif";
  const lines = wrap(ctx, round.question.text, W - 144).slice(0, 2);
  lines.forEach((l, i) => ctx.fillText(l, 72, 176 + i * 70));
  const top = 176 + lines.length * 70 + 20;
  const max = Math.max(round.revealed_a, round.revealed_b, 1);
  const rows: Array<[string, number, string, boolean]> = [
    [round.question.a, round.revealed_a, "#FF6B4A", item.outcome === "A"],
    [round.question.b, round.revealed_b, "#7C5CFF", item.outcome === "B"],
  ];
  rows.forEach(([label, n, color, lit], i) => {
    const y = top + i * 92;
    ctx.fillStyle = lit ? "#C6FF4D" : "#F3F0FF";
    ctx.font = "700 32px 'Unbounded', sans-serif";
    ctx.fillText(label, 72, y);
    ctx.font = "600 32px 'DM Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(String(n), W - 72, y);
    ctx.textAlign = "left";
    ctx.fillStyle = "#201C36";
    ctx.fillRect(72, y + 16, W - 144, 28);
    ctx.fillStyle = color;
    ctx.fillRect(72, y + 16, Math.max(8, ((W - 144) * n) / max), 28);
  });
  ctx.fillStyle = item.result === "Win" ? "#C6FF4D" : "#F3F0FF";
  ctx.font = "800 40px 'Unbounded', sans-serif";
  ctx.fillText(COPY[item.result], 72, H - 64);

  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) return;
  const file = new File([blob], `odd-one-in-round-${item.round_id}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text: `${round.question.text} — ${COPY[item.result]}` }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
