// The round as a journey on the board: where your vote is (sealed, opening, result), the crowd forming as
// sealed envelopes, and the opening itself, envelope by envelope.
import type { SaltRecord } from "../lib/game";
import type { EntryView, RoundView } from "../lib/near";
import { Tally } from "./Explainer";
import { Countdown } from "./Panels";

/** A small envelope. `side` colours an opened one; `mine` rings the player's own. */
function Envelope({ side, mine, delay = 0 }: { side?: "A" | "B"; mine?: boolean; delay?: number }) {
  const fill = side === "A" ? "var(--color-side-a)" : side === "B" ? "var(--color-side-b)" : "var(--color-board-line)";
  return (
    <svg viewBox="0 0 34 24" className={`h-8 w-[45px] shrink-0 ${side ? "env-open" : "env-in"}`} style={{ animationDelay: `${delay}ms` }} aria-hidden="true">
      <rect x="1" y="1" width="32" height="22" rx="4" fill={fill} stroke={mine ? "var(--color-chalk)" : "transparent"} strokeWidth="2" />
      {side ? (
        <path d="M3 3 L17 1 L31 3" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M3 4 L17 14 L31 4" fill="none" stroke="rgba(245,242,234,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** Sealed votes in the current round, arriving one by one. Nobody's side shows. */
export function Crowd({ n, mine }: { n: number; mine: boolean }) {
  const shown = Math.min(n, 40);
  return (
    <div>
      <div className="flex flex-wrap justify-center gap-1.5" role="img" aria-label={`${n} sealed ${n === 1 ? "vote" : "votes"} in this round`}>
        {Array.from({ length: shown }, (_, i) => (
          <Envelope key={i} mine={mine && i === 0} />
        ))}
      </div>
      <p className="mt-3 font-mono text-xs text-dim">
        {n} sealed{n > shown ? ` (showing ${shown})` : ""} · {n <= 1 ? "others can still join before the round closes" : "nobody can see a side until opening"}
      </p>
    </div>
  );
}

/** Where a vote is on its way: sealed in one round, opened in the next, result after that. */
export function Journey({ stage, ms, label }: { stage: 1 | 2; ms: number; label: string }) {
  const steps = ["Sealed", "Opening", "Result"];
  return (
    <div aria-label={`${label}: step ${stage} of 3`}>
      <ol className="mx-auto grid max-w-md grid-cols-3 text-left">
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
        {stage === 1 ? "Opens in " : "Result in "}
        <span className="text-chalk">
          <Countdown ms={ms} />
        </span>
      </p>
    </div>
  );
}

/** The round being opened right now: every vote as an envelope, opened ones in their side's colour, and the count. */
export function Opening({ round, entry, salt, opening, ms }: { round: RoundView; entry: EntryView | null; salt: SaltRecord | null; opening: boolean; ms: number }) {
  const { revealed_a: a, revealed_b: b, commits } = round;
  const opened = a + b;
  const lostVote = entry?.committed && !entry.revealed && !salt && !opening;
  let status: string | null = null;
  if (entry?.committed) {
    if (entry.revealed) status = `Your vote is open: ${entry.revealed === "A" ? round.question.a : round.question.b}.`;
    else if (opening) status = "Opening your vote…";
    else if (!salt) status = "This vote was sealed on another device, or this browser's data was cleared, so it can't be opened here. Unopened votes forfeit stake and bond.";
    else status = "Your vote is waiting to be opened.";
  }
  // Which side is smaller so far. Not final: votes are still being opened.
  const lead = opened < 2 || a === b || a === 0 || b === 0 ? null : a < b ? "A" : "B";
  const shown = Math.min(commits, 40);
  const cells: Array<"A" | "B" | undefined> = Array.from({ length: shown }, (_, i) => (i < a ? "A" : i < a + b ? "B" : undefined));
  return (
    <div className="rounded-3xl border border-board-line bg-board-2 p-5 sm:p-7" aria-label="The round being opened">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-xs uppercase tracking-widest text-odd">
          <span className="live-dot mr-2 inline-block h-2 w-2 rounded-full bg-odd align-middle" />
          Round {round.id} · opening now
        </p>
        <p className="font-mono text-xs text-dim">
          final in{" "}
          <span className="text-chalk">
            <Countdown ms={ms} />
          </span>
        </p>
      </div>
      <p className="display mt-3 text-2xl font-extrabold text-chalk sm:text-3xl">{round.question.text}</p>

      <div className="mt-5 flex flex-wrap gap-1.5" role="img" aria-label={`${opened} of ${commits} votes opened`}>
        {cells.map((side, i) => (
          <Envelope key={`${i}-${side ?? "sealed"}`} side={side} delay={side ? (i % 8) * 70 : 0} />
        ))}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(["A", "B"] as const).map((side) => {
          const n = side === "A" ? a : b;
          const color = side === "A" ? "var(--color-side-a)" : "var(--color-side-b)";
          return (
            <div key={side} className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${lead === side ? "border-odd" : "border-board-line"}`}>
              <span className="min-w-0">
                <span className="block truncate font-semibold text-chalk">{side === "A" ? round.question.a : round.question.b}</span>
                <span className="mt-1 block min-h-[20px]">
                  <Tally n={n} color={color} h={18} />
                </span>
              </span>
              <span className="text-right">
                <span className="block font-mono text-3xl text-chalk">{n}</span>
                {lead === side && <span className="font-mono text-[10px] uppercase tracking-widest text-odd">smaller so far</span>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-mono text-xs text-dim">
        {opened}/{commits} opened · the smaller side wins when opening closes{commits - opened > 0 ? " · votes left sealed forfeit stake and bond" : ""}
      </p>
      {status && <p className={`mt-2 text-sm ${lostVote ? "text-side-a" : "text-chalk"}`}>{status}</p>}
    </div>
  );
}
