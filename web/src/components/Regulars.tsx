// The regulars: who is at the table, which way each one leans, and how they have done.
import { useEffect } from "react";
import { EXPLORER, fmtNear } from "../lib/near";
import { sideWord, type Side } from "../lib/regulars";
import type { RegularInfo, Regulars, Seat } from "../lib/useRegulars";

const sideBg = (s: Side | null | undefined) => (s === "A" ? "bg-side-a text-night" : s === "B" ? "bg-side-b text-white" : "bg-board-line text-chalk");

/** A regular as a round token with their initial. `side` colours it; without one it is a sealed grey. */
export function Token({ name, side, size = 40, you = false }: { name: string; side?: Side | null; size?: number; you?: boolean }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-mono font-medium ${you ? "bg-odd text-night" : sideBg(side)} ${side || you ? "" : "border border-dashed border-[#6a63a0]"}`}
      style={{ width: size, height: size, fontSize: you ? size * 0.26 : size * 0.42 }}
      aria-hidden="true"
    >
      {you ? "YOU" : name[0]}
    </span>
  );
}

/** Signed NEAR with a sign that reads as money. */
export const signed = (yocto: string) => (BigInt(yocto) > 0n ? `+${fmtNear(yocto)}` : fmtNear(yocto));

/** The last few picks as dots: the side's colour, ringed when it won, hollow when the round was void. */
export function Trail({ last, n = 8 }: { last: RegularInfo["last"]; n?: number }) {
  if (!last.length) return <span className="font-mono text-xs text-ink-2">no rounds yet</span>;
  return (
    <span className="flex items-center gap-1.5" aria-label={`Last ${Math.min(n, last.length)} picks, newest first`}>
      {last.slice(0, n).map((l) => {
        const won = l.pick && l.result === l.pick;
        return (
          <span
            key={l.round}
            title={`Round ${l.round}: ${l.pick ? sideWord(l.pick) : "never opened"}, ${l.result === "Void" ? "void" : won ? "won" : "lost"}${l.pick && l.lean ? (l.pick === l.lean ? "" : " (broke habit)") : ""}`}
            className={`h-3 w-3 rounded-full ${l.pick === "A" ? "bg-side-a" : l.pick === "B" ? "bg-side-b" : "bg-board-line"} ${won ? "ring-2 ring-odd ring-offset-2 ring-offset-paper" : ""} ${l.result === "Void" ? "opacity-40" : ""}`}
          />
        );
      })}
    </span>
  );
}

/** The regulars at the table who lean to one side (or have no lean), standing under that answer. */
export function Leaning({ seats, regs, onOpen, you }: { seats: Seat[]; regs: Regulars; onOpen: (id: string) => void; you?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-3">
      {you && (
        <li className="flex w-12 flex-col items-center gap-1.5 text-center">
          <Token name="You" you size={44} />
          <span className="font-mono text-[11px] text-odd">sealed</span>
        </li>
      )}
      {seats.map((s) => {
        const r = regs.regulars.find((x) => x.id === s.id);
        if (!r) return null;
        return (
          <li key={s.id}>
            <button onClick={() => onOpen(s.id)} className="group flex w-12 flex-col items-center gap-1.5 text-center" aria-label={`${r.name}, ${r.habit}: ${s.lean ? `leans ${sideWord(s.lean)}` : "no habit to read"}. Open their record.`}>
              <span className="rounded-full transition group-hover:-translate-y-0.5 group-hover:ring-2 group-hover:ring-chalk">
                <Token name={r.name} side={s.lean} size={44} />
              </span>
              <span className="text-xs text-dim group-hover:text-chalk">{r.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One regular's file: the habit, this round's lean and why, and the record. */
export function Dossier({ id, regs, onClose }: { id: string; regs: Regulars; onClose: () => void }) {
  const r = regs.regulars.find((x) => x.id === id);
  const seat = regs.table.find((s) => s.id === id);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  if (!r) return null;
  const decided = r.won + r.lost;
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-night/70 backdrop-blur-sm sm:place-items-center sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${r.name}'s record`}>
      <div className="max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl border border-board-line bg-board-2 p-6 sm:max-w-md sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4">
          <Token name={r.name} side={seat?.lean} size={64} />
          <div className="min-w-0 flex-1">
            <p className="display text-2xl font-extrabold">{r.name}</p>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-odd">{r.habit}</p>
          </div>
          <button onClick={onClose} className="rounded-full border border-board-line px-3 py-1.5 text-sm text-dim hover:text-chalk" aria-label="Close">
            Close
          </button>
        </div>
        <p className="mt-5 text-[17px] leading-relaxed">{r.rule}</p>
        <p className="mt-2 text-sm text-dim">Keeps to it about {Math.round(regs.follow * 5)} rounds in 5. The other rounds, {r.id === "penny" ? "well, it's a coin" : "they take the other side"}.</p>

        <div className="mt-5 rounded-2xl border border-board-line bg-board p-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-dim">This round</p>
          {seat ? (
            <>
              <p className="mt-2 font-semibold">{seat.lean ? <>Leans <span className={seat.lean === "A" ? "text-side-a" : "text-side-b"}>{sideWord(seat.lean)}</span></> : "No lean"}</p>
              <p className="mt-1 text-sm text-dim">{seat.why}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-dim">{r.out ? "Out of chips: can't cover a stake until the house tops them up." : "Sitting this one out."}</p>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-y-4 text-sm">
          <div>
            <dt className="text-dim">Won / lost</dt>
            <dd className="mt-1 font-mono text-lg">{r.won} / {r.lost}</dd>
          </div>
          <div>
            <dt className="text-dim">Win rate</dt>
            <dd className="mt-1 font-mono text-lg">{decided ? `${Math.round((r.won / decided) * 100)}%` : "n/a"}</dd>
          </div>
          <div>
            <dt className="text-dim">Net</dt>
            <dd className={`mt-1 font-mono text-lg ${BigInt(r.net) > 0n ? "text-odd" : ""}`}>{signed(r.net)}</dd>
          </div>
          <div>
            <dt className="text-dim">Kept habit</dt>
            <dd className="mt-1 font-mono text-lg">{r.keptOf ? `${r.kept} of ${r.keptOf}` : "n/a"}</dd>
          </div>
          <div>
            <dt className="text-dim">Void rounds</dt>
            <dd className="mt-1 font-mono text-lg">{r.void}</dd>
          </div>
          <div>
            <dt className="text-dim">In the game</dt>
            <dd className="mt-1 font-mono text-lg">{fmtNear(r.balance)}</dd>
          </div>
        </dl>
        <div className="mt-5 flex items-center justify-between gap-3">
          <Trail last={r.last} />
          <a className="font-mono text-xs text-dim underline underline-offset-4 hover:text-chalk" href={`${EXPLORER}/address/${r.account}`} target="_blank" rel="noreferrer">
            their wallet
          </a>
        </div>
        <p className="mt-4 text-xs text-dim">Amounts in test NEAR over the last {r.played} rounds {r.name} played. A ringed dot is a win.</p>
      </div>
    </div>
  );
}

/** Every regular with their habit and record: the form guide. */
export function RegularsSection({ regs, n, onOpen, label, scrawl }: { regs: Regulars; n: string; onOpen: (id: string) => void; label: (n: string, text: string) => React.ReactNode; scrawl: (text: string) => React.ReactNode }) {
  const atTable = new Set(regs.table.map((s) => s.id));
  return (
    <section id="regulars" className="py-16 sm:py-20" aria-labelledby="regulars-h">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {label(n, "The regulars")}
          <h2 id="regulars-h" className="display mt-5 max-w-2xl text-3xl font-extrabold sm:text-4xl">
            Eight habits you can {scrawl("read")}
          </h2>
        </div>
        <p className="max-w-sm text-ink-2">
          The house players each have their own wallet and one public habit. They keep to it about {Math.round(regs.follow * 5)} rounds in 5. Four sit in every round; which round they break habit is the part you can&apos;t see.
        </p>
      </div>
      <ul className="mt-10 grid gap-x-8 border-t border-ink md:grid-cols-2">
        {regs.regulars.map((r) => {
          const seat = regs.table.find((s) => s.id === r.id);
          return (
            <li key={r.id} className="border-b border-rule">
              <button onClick={() => onOpen(r.id)} className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 py-5 text-left">
                <Token name={r.name} side={seat?.lean} size={48} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-3">
                    <span className="display text-xl font-bold group-hover:underline group-hover:underline-offset-4">{r.name}</span>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-ink-2">{r.habit}</span>
                  </span>
                  <span className="mt-1 block text-sm text-ink-2">{r.rule}</span>
                </span>
                <span className="text-right font-mono text-sm">
                  <span className="block">{r.won}–{r.lost}</span>
                  <span className={`block text-xs ${BigInt(r.net) > 0n ? "text-odd" : "text-ink-2"}`}>{signed(r.net)}</span>
                </span>
                <span className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Trail last={r.last} n={6} />
                  <span className="font-mono text-[11px] uppercase tracking-widest text-ink-2">
                    {atTable.has(r.id) ? <span className="text-odd">at the table</span> : r.out ? "out of chips" : "sitting out"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 max-w-3xl text-sm text-ink-2">
        Won–lost and net (test NEAR) cover each regular&apos;s last rounds. Tap one for their full record and why they lean the way they do this round.
        {regs.since > 0 && ` Habits started at round ${regs.since}; older rounds were picked at random.`}
      </p>
    </section>
  );
}
