// One round played out in a few seconds: sealed picks open one by one, walk to their side, and the smaller
// crowd gets the ring. Used to replay a finished round from the chain, and for practice rounds (not on chain).
import { useEffect, useMemo, useState } from "react";
import { fmtNear, type Config, type Question } from "../lib/near";
import { FOLLOW, other, type Side } from "../lib/regulars";
import type { PastTable, Regulars, Seat } from "../lib/useRegulars";

export type Vote = { key: string; name: string; side: Side | null; you?: boolean; broke?: boolean };

const W = 600;
const H = 380;
const CENTER = { A: 165, B: 435 } as const;

function spot(side: Side, i: number, n: number): [number, number] {
  const cols = n > 6 ? 4 : 3;
  const rows = Math.ceil(n / cols);
  const inRow = Math.min(cols, n - Math.floor(i / cols) * cols);
  const x = CENTER[side] + ((i % cols) - (inRow - 1) / 2) * 58;
  const y = 232 + (Math.floor(i / cols) - (rows - 1) / 2) * 62;
  return [x, y];
}

function Stage({ question, votes, step }: { question: Question; votes: Vote[]; step: number }) {
  const n = votes.length;
  const opened = votes.slice(0, step).filter((v) => v.side);
  const a = opened.filter((v) => v.side === "A").length;
  const b = opened.length - a;
  const totalA = votes.filter((v) => v.side === "A").length;
  const totalB = votes.filter((v) => v.side === "B").length;
  const done = step >= n;
  const small: Side | null = done && a !== b && a > 0 && b > 0 ? (a < b ? "A" : "B") : null;
  let ia = 0;
  let ib = 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${question.a} ${a}, ${question.b} ${b}`}>
      <line x1={W / 2} y1={130} x2={W / 2} y2={H - 50} stroke="var(--color-board-line)" strokeDasharray="4 6" />
      {small && <ellipse className="crowd-ring" cx={CENTER[small]} cy={232} rx={128} ry={104} fill="none" stroke="var(--color-odd)" strokeWidth={2.5} strokeDasharray="7 7" />}
      {votes.map((v, i) => {
        const open = i < step && v.side;
        const [x, y] = open ? spot(v.side as Side, v.side === "A" ? ia++ : ib++, v.side === "A" ? totalA : totalB) : [W / 2 + (i - (n - 1) / 2) * Math.min(58, 520 / n), 62];
        const fill = v.you && !open ? "var(--color-odd)" : open ? (v.side === "A" ? "var(--color-side-a)" : "var(--color-side-b)") : "#4a4470";
        const ink = open ? (v.side === "A" ? "var(--color-night)" : "#fff") : v.you ? "var(--color-night)" : "var(--color-chalk)";
        return (
          <g key={v.key} className="crowd-dot" style={{ transform: `translate(${x}px, ${y}px)` }}>
            <circle r={23} fill={fill} stroke={v.you ? "var(--color-chalk)" : open ? "none" : "#6a63a0"} strokeWidth={v.you ? 3 : 1.5} strokeDasharray={open || v.you ? undefined : "3 3"} style={{ transition: "fill 400ms ease" }} />
            <text textAnchor="middle" y={v.you ? 4 : 6} fontSize={v.you ? 11 : 17} fontFamily="DM Mono, monospace" fontWeight={500} fill={ink}>
              {v.you ? "YOU" : v.name === "?" ? "·" : v.name[0]}
            </text>
            {open && v.broke && (
              <text textAnchor="middle" y={-30} fontSize={10} fontFamily="DM Mono, monospace" letterSpacing={1} fill="var(--color-odd)">
                BROKE HABIT
              </text>
            )}
          </g>
        );
      })}
      <g fontFamily="DM Mono, monospace" fontSize={13} letterSpacing={1.2} textAnchor="middle">
        {(["A", "B"] as const).map((s) => (
          <text key={s} x={CENTER[s]} y={H - 22} fill={small === s ? "var(--color-odd)" : "var(--color-ink-2)"}>
            {(s === "A" ? question.a : question.b).toUpperCase().slice(0, 16)} · {s === "A" ? a : b}
          </text>
        ))}
        {!done && (
          <text x={W / 2} y={22} fill="var(--color-ink-2)" fontSize={11}>
            {step === 0 ? "ALL SEALED" : "OPENING"}
          </text>
        )}
      </g>
    </svg>
  );
}

function usePlayback(n: number, runKey: number) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setStep(still ? n : 0);
    if (still) return;
    let s = 0;
    let t: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      t = setInterval(() => {
        s++;
        setStep(s);
        if (s >= n) clearInterval(t);
      }, 520);
    }, 900);
    return () => {
      clearTimeout(start);
      clearInterval(t);
    };
  }, [n, runKey]);
  return step;
}

function outcome(votes: Vote[]) {
  const a = votes.filter((v) => v.side === "A").length;
  const b = votes.filter((v) => v.side === "B").length;
  const winner: Side | null = a !== b && a > 0 && b > 0 ? (a < b ? "A" : "B") : null;
  return { a, b, winner };
}

function Shell({ title, tag, onClose, children }: { title: string; tag: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-night/75 backdrop-blur-sm sm:place-items-center sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[94dvh] w-full overflow-y-auto rounded-t-3xl border border-board-line bg-board-2 sm:max-w-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 pt-5">
          <p className="font-mono text-[11px] uppercase tracking-widest text-odd">{tag}</p>
          <button onClick={onClose} className="rounded-full border border-board-line px-3 py-1.5 text-sm text-dim hover:text-chalk">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A finished round, replayed from what the chain recorded. */
export function Replay({ round, regs, config, onClose }: { round: PastTable; regs: Regulars | null; config: Config; onClose: () => void }) {
  const [run, setRun] = useState(0);
  const votes = useMemo(() => {
    const named: Vote[] = Object.entries(round.picks).map(([id, side]) => ({
      key: id,
      name: regs?.regulars.find((r) => r.id === id)?.name ?? id,
      side,
      broke: !!(side && round.leans[id] && round.leans[id] !== side),
    }));
    const extra = (s: Side, total: number) => Array.from({ length: Math.max(0, total - named.filter((v) => v.side === s).length) }, (_, i) => ({ key: `${s}${i}`, name: "?", side: s }) as Vote);
    const shut = Math.max(0, round.commits - round.a - round.b - named.filter((v) => !v.side).length);
    const all = [...named, ...extra("A", round.a), ...extra("B", round.b), ...Array.from({ length: shut }, (_, i) => ({ key: `u${i}`, name: "?", side: null }) as Vote)];
    // a fixed shuffle, so the order of opening doesn't give the ending away
    return all.map((v, i) => [v, (i * 7 + round.id) % all.length] as const).sort((x, y) => x[1] - y[1]).map(([v]) => v);
  }, [round, regs]);
  const step = usePlayback(votes.length, run);
  const done = step >= votes.length;
  const stake = BigInt(config.stake);
  const fee = (stake * BigInt(config.fee_bps)) / 10_000n;
  const winner = round.result === "Void" ? null : round.result;
  const unopened = votes.filter((v) => !v.side).length;
  return (
    <Shell title={`Round ${round.id} replay`} tag={`Round ${round.id} · replay from the chain`} onClose={onClose}>
      <p className="display px-5 pt-3 text-xl font-bold sm:text-2xl">{round.question.text}</p>
      <Stage question={round.question} votes={votes} step={step} />
      <div className="border-t border-board-line px-5 py-4">
        {done ? (
          <>
            <p className="font-semibold">
              {winner ? (
                <>
                  <span className={winner === "A" ? "text-side-a" : "text-side-b"}>{winner === "A" ? round.question.a : round.question.b}</span> was the odd one in: {winner === "A" ? round.a : round.b} against {winner === "A" ? round.b : round.a}.
                </>
              ) : (
                "No smaller side, so the round was void and every stake went back."
              )}
            </p>
            {winner && (
              <p className="mt-1 text-sm text-dim">
                Each winner got +{fmtNear(stake - fee)} NEAR, each of the others lost {fmtNear(stake)}.{unopened > 0 && ` ${unopened} pick${unopened === 1 ? " was" : "s were"} never opened and forfeited stake and bond.`}
              </p>
            )}
            <p className="mt-1 text-xs text-dim">Initials are regulars; a dot is another player.</p>
          </>
        ) : (
          <p className="text-sm text-dim">Every pick was sealed until the round closed. Then they opened, one by one.</p>
        )}
        <button onClick={() => setRun((n) => n + 1)} className="mt-4 rounded-full border border-board-line px-4 py-2 text-sm hover:border-chalk">
          Play it again
        </button>
      </div>
    </Shell>
  );
}

/** A practice round against this round's table: same leans, a fresh roll of who breaks habit. Nothing is sent to the chain. */
export function Practice({ question, table, regs, config, onClose }: { question: Question; table: Seat[]; regs: Regulars; config: Config; onClose: () => void }) {
  const [pick, setPick] = useState<Side | null>(null);
  const [run, setRun] = useState(0);
  const [tally, setTally] = useState({ won: 0, lost: 0, void: 0 });
  const votes = useMemo<Vote[]>(() => {
    if (!pick) return [];
    const house = table.map((s) => {
      const side: Side = s.lean === null ? (Math.random() < 0.5 ? "A" : "B") : Math.random() < FOLLOW ? s.lean : other(s.lean);
      return { key: s.id, name: regs.regulars.find((r) => r.id === s.id)?.name ?? s.id, side, broke: !!s.lean && s.lean !== side };
    });
    const all: Vote[] = [...house, { key: "you", name: "You", side: pick, you: true }];
    return all.sort(() => Math.random() - 0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, run]);
  const step = usePlayback(votes.length, run);
  const done = !!pick && step >= votes.length;
  const { a, b, winner } = outcome(votes);
  const result = !pick ? null : !winner ? "void" : winner === pick ? "won" : "lost";
  useEffect(() => {
    if (done && result) setTally((t) => ({ ...t, [result]: t[result] + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const stake = BigInt(config.stake);
  const fee = (stake * BigInt(config.fee_bps)) / 10_000n;
  const leanCount = (s: Side) => table.filter((t) => t.lean === s).length;
  const again = () => {
    setPick(null);
    setRun((n) => n + 1);
  };
  return (
    <Shell title="Practice round" tag="Practice round · not on chain" onClose={onClose}>
      <p className="display px-5 pt-3 text-xl font-bold sm:text-2xl">{question.text}</p>
      {!pick ? (
        <div className="px-5 pb-6 pt-4">
          <p className="text-dim">
            Same table as the real round: {leanCount("A")} lean orange, {leanCount("B")} lean violet{table.some((t) => t.lean === null) ? ", one flips a coin" : ""}. Each keeps to their habit about {Math.round(FOLLOW * 5)} rounds in 5. Where will the smaller crowd be?
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {(["A", "B"] as const).map((s) => (
              <button key={s} onClick={() => setPick(s)} className={`rounded-2xl p-5 text-left transition hover:-translate-y-0.5 ${s === "A" ? "bg-side-a text-night" : "bg-side-b text-white"}`}>
                <span className="font-mono text-xs tracking-widest opacity-80">PRACTICE {s}</span>
                <span className="display mt-6 block text-xl font-extrabold">{s === "A" ? question.a : question.b}</span>
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-dim">Nothing is sent to the chain and no NEAR moves. The regulars&apos; real picks for this round stay sealed; this rolls new ones.</p>
        </div>
      ) : (
        <>
          <Stage question={question} votes={votes} step={step} />
          <div className="border-t border-board-line px-5 py-4" aria-live="polite">
            {done ? (
              <>
                <p className="display text-xl font-extrabold">{result === "won" ? "You were the odd one in." : result === "lost" ? "You went with the crowd." : "No smaller side. Void."}</p>
                <p className="mt-1 text-sm text-dim">
                  {a} orange, {b} violet. In a real round that is {result === "won" ? `+${fmtNear(stake - fee)}` : result === "lost" ? `−${fmtNear(stake)}` : "±0"} NEAR.
                  {votes.some((v) => v.broke) ? " Someone broke habit: that's the part you can't read." : " Everyone kept to their habit this time."}
                </p>
              </>
            ) : (
              <p className="text-sm text-dim">Opening the picks…</p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button onClick={again} disabled={!done} className="rounded-full bg-odd px-5 py-2.5 text-sm font-semibold text-night disabled:opacity-40">
                Practice again
              </button>
              <button onClick={onClose} className="rounded-full border border-board-line px-4 py-2.5 text-sm hover:border-chalk">
                Play the real round
              </button>
              <span className="ml-auto font-mono text-xs text-dim">
                practice: {tally.won} won · {tally.lost} lost · {tally.void} void
              </span>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
