import { CONTRACT_ID, EXPLORER, fmtNear, type Config, type RoundView } from "../lib/near";
import { Stamp, Tally } from "./Explainer";

export function Label({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <span className="stub">
      <span>No. {n}</span>
      <span>{children}</span>
    </span>
  );
}

/** Scribbled underline under a heading word. */
export function Scrawl({ children }: { children: React.ReactNode }) {
  return (
    <span className="scrawl">
      {children}
      <svg viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M3 13 C40 4 70 17 104 9 C140 2 168 15 197 7" fill="none" stroke="var(--color-side-b)" strokeWidth="9" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

function roundLength(config: Config) {
  const min = Number(BigInt(config.round_duration_ns) / 60_000_000_000n);
  return min >= 1440 ? { word: "a day", short: "24 h" } : { word: `${min} minutes`, short: `${min} min` };
}

export function RecentRounds({ rounds, n, onReplay }: { rounds: RoundView[]; n: string; onReplay: (r: RoundView) => void }) {
  if (!rounds.length) return null;
  return (
    <section id="rounds" className="py-16 sm:py-20" aria-labelledby="rounds-h">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label n={n}>Recent rounds</Label>
          <h2 id="rounds-h" className="display mt-5 text-3xl font-extrabold sm:text-4xl">
            The crowd, <Scrawl>after</Scrawl> the fact
          </h2>
        </div>
        <p className="max-w-sm text-ink-2">Every settled round, counted the old way. The stamped answer is the one fewer people picked. Replay any of them to watch the picks open.</p>
      </div>
      <div className="mt-10 grid gap-x-8 border-t border-ink sm:grid-cols-2 lg:grid-cols-4">
        {rounds.slice(0, 8).map((r) => (
          <article key={r.id} className="relative border-b border-rule py-6">
            <p className="font-mono text-xs text-ink-2">Round {String(r.id).padStart(3, "0")}</p>
            <h3 className="mt-2 min-h-[3rem] font-semibold leading-snug">{r.question.text}</h3>
            <div className="mt-3 space-y-2.5">
              {(["A", "B"] as const).map((side) => {
                const n = side === "A" ? r.revealed_a : r.revealed_b;
                const won = r.outcome === side;
                return (
                  <div key={side} className={`flex items-center gap-3 ${!won && r.outcome !== "Void" ? "text-ink-2" : ""}`}>
                    <span className={`w-24 shrink-0 truncate text-sm ${won ? "font-semibold" : ""}`}>{side === "A" ? r.question.a : r.question.b}</span>
                    <span className="min-w-0 flex-1 overflow-hidden"><Tally n={n} h={18} /></span>
                    <span className="font-mono text-sm">{n}</span>
                  </div>
                );
              })}
            </div>
            {r.outcome === "Void" ? (
              <Stamp className="mt-4 text-ink-2">void · stakes back</Stamp>
            ) : (
              <Stamp className="mt-4 bg-odd text-night">{r.outcome === "A" ? r.question.a : r.question.b} · odd one in</Stamp>
            )}
            <button onClick={() => onReplay(r)} className="mt-4 block font-mono text-xs uppercase tracking-widest text-ink-2 underline underline-offset-4 hover:text-ink">
              ▶ Replay
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Three overlapping rounds on a timeline: each round is sealed in one slot and opened in the next. */
export function HowItWorks({ config, n }: { config: Config; n: string }) {
  const len = roundLength(config);
  const steps = [
    {
      n: "01",
      title: "Seal",
      body: `Pick an answer. The app hashes it with a random salt that never leaves your browser, so nobody can see your side, not even the contract owner. It costs a ${fmtNear(config.stake)} NEAR stake plus a ${fmtNear(config.bond)} NEAR bond.`,
      code: "sha256(round:account:choice:salt)",
    },
    {
      n: "02",
      title: "Open",
      body: "In the next round, your vote is opened: the contract checks it against the hash and counts it, and your bond comes back. The app does this for you when you visit. A vote that is never opened forfeits stake and bond.",
      code: "reveal → bond returned",
    },
    {
      n: "03",
      title: "Settle",
      body: "When opening closes, the side with fewer votes wins. A tie, or a side with no votes, makes the round void and everyone gets their stake back. Your next visit collects the result.",
      code: "fewer votes → wins",
    },
  ];
  const lanes = [
    { r: "r", cells: ["Seal", "Open", "Settle"] },
    { r: "r+1", cells: ["", "Seal", "Open"] },
    { r: "r+2", cells: ["", "", "Seal"] },
  ];
  const cellStyle: Record<string, string> = {
    Seal: "bg-ink text-paper",
    Open: "bg-paper-2 text-ink border border-rule",
    Settle: "bg-odd text-night",
    "": "",
  };
  return (
    <section id="how" className="py-16 sm:py-20" aria-labelledby="how-h">
      <Label n={n}>How it works</Label>
      <h2 id="how-h" className="display mt-5 max-w-3xl text-3xl font-extrabold sm:text-4xl">
        Sealed now, opened <Scrawl>next round</Scrawl>
      </h2>
      <p className="mt-4 max-w-2xl text-ink-2">
        Each round lasts {len.word}. Rounds overlap, so one visit can collect an old result, open your last vote and seal a new one, all in
        a single transaction.
      </p>

      <div className="mt-10">
        <div className="rounded-3xl border border-rule p-3 sm:p-5">
          <div className="grid grid-cols-[3.2rem_repeat(3,minmax(0,1fr))] gap-1.5 font-mono text-[11px] text-ink-2 sm:grid-cols-[4.5rem_repeat(3,1fr)] sm:gap-2 sm:text-xs">
            <span />
            {["slot 1", "slot 2", "slot 3"].map((s) => (
              <span key={s} className="truncate px-1 sm:px-2">
                {s}<span className="hidden sm:inline"> · {len.short}</span>
              </span>
            ))}
            {lanes.map((l) => (
              <div key={l.r} className="contents">
                <span className="self-center">round {l.r}</span>
                {l.cells.map((c, i) => (
                  <span key={i} className={`rounded-lg px-2 py-2 text-xs font-semibold sm:rounded-xl sm:px-3 sm:py-2.5 sm:text-sm ${cellStyle[c]}`}>
                    {c}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <p className="mt-4 font-mono text-xs text-ink-2">In slot 3 a single visit settles r, opens r+1 and seals r+2.</p>
        </div>
      </div>

      <ol className="mt-12 grid gap-x-10 border-t border-ink md:grid-cols-3">
        {steps.map((s) => (
          <li key={s.n} className="border-b border-rule py-7 md:border-b-0">
            <span className="font-mono text-sm text-ink-2">{s.n}</span>
            <h3 className="display mt-2 text-2xl font-bold">{s.title}</h3>
            <p className="mt-3 leading-relaxed text-ink-2">{s.body}</p>
            <p className="mt-4 font-mono text-xs">{s.code}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Payouts({ config, n }: { config: Config; n: string }) {
  const s = BigInt(config.stake);
  const fee = (s * BigInt(config.fee_bps)) / 10_000n;
  const rows = [
    { label: "You picked the smaller side", value: `+${fmtNear(s - fee)}`, note: `your ${fmtNear(s)} stake back, plus one stake minus the ${config.fee_bps / 100}% fee`, win: true },
    { label: "You picked the bigger side", value: `−${fmtNear(s)}`, note: "you lose the stake" },
    { label: "Tie, or a side with no votes", value: "±0", note: "the round is void and the stake comes back" },
    { label: "Your vote was never opened", value: `−${fmtNear(s + BigInt(config.bond))}`, note: "stake and bond are forfeited" },
  ];
  return (
    <section id="payouts" className="py-16 sm:py-20" aria-labelledby="pay-h">
      <Label n={n}>Payouts</Label>
      <h2 id="pay-h" className="display mt-5 max-w-3xl text-3xl font-extrabold sm:text-4xl">
        Win one stake, or lose <Scrawl>one stake</Scrawl>
      </h2>
      <div className="mt-10 grid border-t border-ink sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label} className="border-b border-rule py-6 pr-6">
            <p className="text-sm text-ink-2">{r.label}</p>
            <p className={`mt-3 font-mono text-4xl font-medium tracking-tight sm:text-5xl ${r.win ? "" : ""}`}>
              {r.win ? <Scrawl>{r.value}</Scrawl> : r.value}
            </p>
            <p className="mt-3 text-sm text-ink-2">{r.note}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-3xl text-sm text-ink-2">
        Amounts in NEAR per round. Whatever the bigger side loses beyond what the winners gain, plus forfeited votes, fills the streak pot
        (capped at {fmtNear(config.pot_cap)} NEAR, with any excess going to fees).
      </p>
    </section>
  );
}

export function Fairness({ config, pot, n }: { config: Config; pot: string; n: string }) {
  const fee = (BigInt(config.stake) * BigInt(config.fee_bps)) / 10_000n;
  const bound = ((1n << BigInt(config.streak_target)) - 1n) * fee;
  return (
    <section id="fair" className="py-16 sm:py-20" aria-labelledby="fair-h">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <Label n={n}>Fair play</Label>
          <h2 id="fair-h" className="display mt-5 text-3xl font-extrabold sm:text-4xl">
            More wallets <Scrawl>don't</Scrawl> help
          </h2>
          <p className="mt-4 text-ink-2">
            The payout rules were picked so that splitting yourself across many accounts never pays. Here is the maths, and the one case
            it doesn't cover.
          </p>
        </div>
        <dl className="border-t border-ink">
          {[
            ["Stacking one side", "Extra wallets on a side make it bigger, and the bigger side loses."],
            ["Voting both sides", `One wallet on each side always nets −${fmtNear(fee)} NEAR, the fee, because winners gain exactly what losers lose.`],
            [
              "Farming the streak bonus",
              `Win ${config.streak_target} in a row for ${fmtNear(config.streak_bonus)} NEAR from the pot (now ${fmtNear(pot)}). Forcing a streak with a tree of wallets costs ${fmtNear(bound)} NEAR in fees, and the contract refuses any bonus at or above that cost.`,
            ],
            [
              "House players",
              "A minority game needs a crowd, so the regulars (house accounts, each with its own wallet) join any round a person plays, and play a round of their own every couple of hours. They use the same public methods, stake and bond as you. Each one's habit reads only finished rounds, so their leans are public; a keyed coin decides the rounds they break habit. They can't see your pick: nobody can until it's opened. The repo's `npm run judge` recomputes every lean from the chain.",
            ],
            [
              "Guest accounts",
              "Playing without a wallet uses a free testnet account made for your browser: the key is generated here and only its public half is sent. The project's guest funder keeps a key to it too, so unused test NEAR can be reclaimed. It is for trying the game on testnet; connect a wallet to play from an account only you control.",
            ],
            ["Known limit", "Votes are opened in public. A big group of wallets on one side can watch the count and leave some unopened to flip a thin margin. Each one forfeits its stake and bond, which makes it costly but doesn't rule it out."],
          ].map(([t, d]) => (
            <div key={t} className="grid gap-2 border-b border-rule py-5 sm:grid-cols-[12rem_1fr] sm:gap-6">
              <dt className="font-semibold">{t}</dt>
              <dd className="text-ink-2">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="mt-8 border-t border-ink py-10 text-sm text-ink-2">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-3">A daily minority game. Runs on NEAR testnet with test NEAR, so no real money is at stake.</p>
        </div>
        <div className="font-mono text-xs">
          <p>Contract</p>
          <a className="mt-1 block text-ink underline underline-offset-4" href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
            {CONTRACT_ID}
          </a>
          <p className="mt-4">Source</p>
          <a className="mt-1 block text-ink underline underline-offset-4" href="https://github.com/emer-eth/odd-one-in" target="_blank" rel="noreferrer">
            github.com/emer-eth/odd-one-in
          </a>
        </div>
      </div>
    </footer>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 44 28" className="h-6 w-auto" aria-hidden="true">
        <circle cx="7" cy="9" r="5.5" fill="var(--color-side-a)" />
        <circle cx="16" cy="18" r="7" fill="var(--color-side-a)" />
        <circle cx="5" cy="21" r="3.5" fill="var(--color-side-a)" />
        <circle cx="34" cy="14" r="5.5" fill="var(--color-side-b)" />
        <circle cx="34" cy="14" r="9" fill="none" stroke="var(--color-odd)" strokeWidth="1.6" strokeDasharray="3 2.5" />
      </svg>
      <span className="display text-lg font-extrabold text-ink">odd one in</span>
    </span>
  );
}
