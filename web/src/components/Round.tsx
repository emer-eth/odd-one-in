// The round, drawn as a crowd. Every vote is a circle. Sealed votes are grey and drift; when a vote is opened it
// takes its side's colour and glides to its side. The smaller crowd gets the ring: that's the odd one in.
import type { RoundView } from "../lib/near";
import { Countdown } from "./Panels";

const W = 600;
const H = 560;
const CENTER = { A: [182, 290], B: [418, 290] } as const;

/** Circles packed around a centre in a sunflower spiral, biggest first. */
function cluster(n: number, [cx, cy]: readonly [number, number]) {
  const r = Math.max(13, Math.min(48, 62 - n * 5));
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const d = i === 0 ? 0 : r * 1.55 * Math.sqrt(i);
    const a = i * 2.39996;
    pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9, r * (i === 0 ? 1.12 : 1 - (i % 3) * 0.1)]);
  }
  const reach = n === 0 ? 0 : Math.max(...pts.map(([x, y, rr]) => Math.hypot(x - cx, y - cy) + rr));
  return { pts, reach };
}

/** Where sealed (unopened) votes wait: a loose arc above the two crowds. */
function waiting(i: number, n: number): [number, number, number] {
  const t = n <= 1 ? 0.5 : i / (n - 1);
  return [110 + t * 380, 96 + Math.sin(t * Math.PI) * -34 + (i % 2) * 16, 11];
}

type Props = {
  /** The round to draw: the one being opened now, or else the last one that finished. */
  round: RoundView | null;
  /** Milliseconds until the opening closes (only while `round` is being opened). */
  ms: number;
  /** Sealed votes in the round that is open for picks now. */
  sealedNow: number;
  /** The viewer's own opened pick in `round`, to outline their circle. */
  mine: "A" | "B" | null;
};

export function CrowdField({ round, ms, sealedNow, mine }: Props) {
  const opening = round?.phase === "Reveal";
  const a = round?.revealed_a ?? 0;
  const b = round?.revealed_b ?? 0;
  const sealed = round ? Math.max(0, round.commits - a - b) : 0;
  const A = cluster(Math.min(a, 24), CENTER.A);
  const B = cluster(Math.min(b, 24), CENTER.B);
  const decided = a !== b && a > 0 && b > 0;
  const small: "A" | "B" | null = decided ? (a < b ? "A" : "B") : null;
  const voidRound = !!round && !opening && !decided;
  const label = (side: "A" | "B") => (side === "A" ? round!.question.a : round!.question.b);
  const ring = small ? { c: CENTER[small], r: (small === "A" ? A : B).reach + 20 } : null;

  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-board-line bg-[radial-gradient(circle_at_50%_45%,#241f3d,#161327_70%)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 font-mono text-[11px] uppercase tracking-widest text-dim">
        {round ? (
          <>
            <span className={opening ? "text-odd" : ""}>
              {opening && <span className="live-dot mr-2 inline-block h-2 w-2 rounded-full bg-odd align-middle" />}
              Round {round.id} · {opening ? "opening now" : "last result"}
            </span>
            {opening && (
              <span>
                final in{" "}
                <span className="text-chalk">
                  <Countdown ms={ms} />
                </span>
              </span>
            )}
          </>
        ) : (
          <span>The crowd</span>
        )}
      </div>
      {round && <p className="display px-5 pt-2 text-lg font-bold text-chalk sm:text-xl">{round.question.text}</p>}

      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={round ? `${label("A")} ${a}, ${label("B")} ${b}${sealed ? `, ${sealed} not opened` : ""}` : "No round has been opened yet"}>
        {/* a few far-off dots, so the field is never empty */}
        {[[60, 60, 5], [540, 90, 7], [300, 500, 6], [70, 470, 8], [520, 480, 5], [300, 40, 4]].map(([x, y, r], i) => (
          <circle key={`bg${i}`} cx={x} cy={y} r={r} fill="#3a345c" opacity={0.6} />
        ))}
        {ring && (
          <circle key={`ring-${small}`} className="crowd-ring" cx={ring.c[0]} cy={ring.c[1]} r={ring.r} fill="none" stroke="var(--color-odd)" strokeWidth={2.5} strokeDasharray="7 7" />
        )}
        {(["A", "B"] as const).map((side) =>
          (side === "A" ? A : B).pts.map(([x, y, r], i) => (
            <g key={`${side}${i}`} className="crowd-dot" style={{ transform: `translate(${x}px, ${y}px)` }}>
              <g className="crowd-drift" style={{ animationDelay: `${-((i * 37 + (side === "A" ? 0 : 19)) % 60) / 10}s` }}>
                <circle r={r} fill={side === "A" ? "var(--color-side-a)" : "var(--color-side-b)"} stroke={mine === side && i === 0 ? "var(--color-chalk)" : "none"} strokeWidth={3} opacity={!opening && small && small !== side ? 0.55 : 1} />
                {mine === side && i === 0 && (
                  <text textAnchor="middle" y={4} fontSize={11} fontFamily="DM Mono, monospace" fontWeight={500} fill={side === "A" ? "var(--color-night)" : "#fff"}>
                    YOU
                  </text>
                )}
              </g>
            </g>
          )),
        )}
        {Array.from({ length: Math.min(sealed, 20) }, (_, i) => {
          const [x, y, r] = waiting(i, Math.min(sealed, 20));
          return (
            <g key={`s${i}`} className="crowd-dot" style={{ transform: `translate(${x}px, ${y}px)` }}>
              <circle className="crowd-drift" r={r} fill="#4a4470" stroke="#6a63a0" strokeWidth={1.5} strokeDasharray="3 3" style={{ animationDelay: `${-i * 0.7}s` }} />
            </g>
          );
        })}
        {round && (
          <g fontFamily="DM Mono, monospace" fontSize={13} letterSpacing={1.2} textAnchor="middle">
            {(["A", "B"] as const).map((side) => (
              <text key={side} x={CENTER[side][0]} y={H - 44} fill={small === side ? "var(--color-odd)" : "var(--color-ink-2)"}>
                {label(side).toUpperCase().slice(0, 16)} · {side === "A" ? a : b}
              </text>
            ))}
            {small && (
              <text x={CENTER[small][0]} y={H - 22} fill="var(--color-odd)" fontSize={11}>
                {opening ? "SMALLER SO FAR" : "THE ODD ONE IN"}
              </text>
            )}
            {sealed > 0 && (
              <text x={W / 2} y={150} fill="var(--color-ink-2)" fontSize={11}>
                {sealed} {opening ? "STILL SEALED" : "NEVER OPENED"}
              </text>
            )}
            {voidRound && (
              <text x={W / 2} y={H - 22} fill="var(--color-ink-2)" fontSize={11}>
                NO SMALLER SIDE · STAKES RETURNED
              </text>
            )}
          </g>
        )}
        {!round && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontFamily="DM Mono, monospace" fontSize={13} fill="var(--color-ink-2)">
            The first opened round will gather here.
          </text>
        )}
      </svg>

      <div className="flex items-center gap-3 border-t border-board-line px-5 py-3.5 font-mono text-xs text-dim">
        <span className="flex gap-1" aria-hidden="true">
          {Array.from({ length: Math.min(sealedNow, 14) }, (_, i) => (
            <span key={i} className="env-in h-3 w-3 rounded-full border border-dashed border-[#6a63a0] bg-[#4a4470]" />
          ))}
        </span>
        <span>
          {sealedNow === 0 ? "Nobody has sealed a pick in this round yet." : `${sealedNow} sealed in this round. They join the crowd when the round opens.`}
        </span>
      </div>
    </div>
  );
}

/** Where a vote is on its way: sealed in one round, opened in the next, result after that. */
export function Journey({ stage, ms, label }: { stage: 1 | 2; ms: number; label: string }) {
  const steps = ["Sealed", "Opening", "Result"];
  return (
    <div aria-label={`${label}: step ${stage} of 3`}>
      <ol className="grid max-w-md grid-cols-3 text-left">
        {steps.map((s, i) => {
          const done = i + 1 < stage;
          const now = i + 1 === stage;
          return (
            <li key={s} className="relative pr-2">
              <span className={`block h-1.5 rounded-full ${done ? "bg-chalk" : now ? "journey-now bg-odd" : "bg-board-line"}`} />
              <span className={`mt-2 block font-mono text-[11px] uppercase tracking-widest ${now ? "text-odd" : done ? "text-chalk" : "text-dim"}`}>
                {String(i + 1).padStart(2, "0")} {s}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 font-mono text-sm text-dim">
        {label} · {stage === 1 ? "opens in " : "result in "}
        <span className="text-chalk">
          <Countdown ms={ms} />
        </span>
      </p>
    </div>
  );
}
