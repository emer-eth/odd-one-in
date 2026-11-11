import { useEffect, useRef, useState } from "react";
import { fmtNear, parseNear, type Config, type EntryView, type Player, type RoundView } from "../lib/near";
import type { SaltRecord } from "../lib/game";

export function Countdown({ ms }: { ms: number }) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="font-mono tabular-nums" aria-label={`${h} hours ${m} minutes ${sec} seconds left`}>
      {h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`}
    </span>
  );
}

/** Streak progress as a row of dots (on the dark board). */
export function Streak({ player, config }: { player: Player; config: Config }) {
  const n = config.streak_target;
  return (
    <div className="flex items-center gap-3" title={`Win ${n} in a row for a ${fmtNear(config.streak_bonus)} NEAR bonus`}>
      <span className="font-mono text-xs text-dim">STREAK</span>
      <div className="flex gap-1.5" aria-label={`Streak ${player.streak} of ${n}`}>
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < player.streak ? "bg-odd" : "bg-board-line"}`} />
        ))}
      </div>
      <span className="font-mono text-xs text-dim">best {player.best_streak}</span>
    </div>
  );
}

/** Balance with deposit and withdraw (in the light nav). Deposit goes through the wallet; withdraw uses the session key. */
export function BalanceChip({
  player,
  config,
  busy,
  onDeposit,
  onWithdraw,
  openSignal,
}: {
  player: Player | null;
  config: Config;
  busy: boolean;
  onDeposit: (yocto: bigint) => void;
  onWithdraw: (yocto: bigint) => void;
  /** Incrementing this opens the deposit panel (used by "Deposit first" on the board). */
  openSignal: number;
}) {
  const roundCost = BigInt(config.stake) + BigInt(config.bond);
  const min = roundCost + (player ? 0n : BigInt(config.storage_fee));
  const [open, setOpen] = useState<null | "deposit" | "withdraw">(null);
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const show = (k: "deposit" | "withdraw") => {
    setOpen(k);
    setAmount(k === "withdraw" ? fmtNear(player?.balance ?? "0", 24) : fmtNear(min * 5n));
    setErr(null);
  };
  useEffect(() => {
    if (openSignal > 0) show("deposit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const submit = () => {
    try {
      const v = parseNear(amount || "0");
      if (open === "deposit" && v < min) throw new Error(`Minimum deposit is ${fmtNear(min)} NEAR`);
      if (open === "withdraw" && (v <= 0n || v > BigInt(player?.balance ?? 0))) throw new Error("More than your balance");
      setErr(null);
      if (open === "deposit") onDeposit(v);
      else onWithdraw(v);
      setOpen(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => (open ? setOpen(null) : show("deposit"))}
        className="rounded-full border border-rule bg-paper px-3.5 py-2 font-mono text-sm hover:border-ink"
        aria-expanded={open !== null}
        aria-label="Game balance: deposit or withdraw"
      >
        {player ? fmtNear(player.balance) : "0"} <span className="text-ink-2">NEAR</span>
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-rule bg-paper p-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35)]">
          <div className="flex gap-1 rounded-full bg-paper-2 p-1 text-sm">
            {(["deposit", "withdraw"] as const).map((k) => (
              <button
                key={k}
                onClick={() => show(k)}
                disabled={k === "withdraw" && !player}
                className={`flex-1 rounded-full py-1.5 capitalize ${open === k ? "bg-ink font-semibold text-paper" : "text-ink-2 disabled:opacity-40"}`}
              >
                {k}
              </button>
            ))}
          </div>
          <label className="mt-4 block text-xs text-ink-2" htmlFor="amt">
            Amount (NEAR)
          </label>
          <input
            id="amt"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="mt-1 w-full rounded-xl border border-rule bg-white/60 px-3 py-2.5 font-mono"
          />
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            {open === "deposit"
              ? `One round costs ${fmtNear(roundCost)} (stake + bond; the bond comes back when your vote is opened).${player ? "" : ` Your first deposit includes a ${fmtNear(config.storage_fee)} storage fee.`} Your wallet asks once; after that, play needs no popups.`
              : "Sent back to your wallet. No popup."}
          </p>
          {err && <p className="mt-2 text-xs text-alert">{err}</p>}
          <button onClick={submit} disabled={busy} className="mt-3 w-full rounded-full bg-ink py-2.5 font-semibold text-paper disabled:opacity-50">
            {open === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The round in its opening phase (on the dark board): live opened tally and this player's status. */
export function Yesterday({ round, entry, salt, opening }: { round: RoundView; entry: EntryView | null; salt: SaltRecord | null; opening: boolean }) {
  const opened = round.revealed_a + round.revealed_b;
  const lost = entry?.committed && !entry.revealed && !salt && !opening;
  let status: string | null = null;
  if (entry?.committed) {
    if (entry.revealed) status = `Your vote is open: ${entry.revealed === "A" ? round.question.a : round.question.b}.`;
    else if (opening) status = "Opening your vote…";
    else if (!salt)
      status = "This vote was sealed on another device, or this browser's data was cleared, so it can't be opened here. Unopened votes forfeit stake and bond.";
    else status = "Your vote is waiting to be opened.";
  }
  return (
    <div className="grid gap-3 border-t border-board-line pt-5 sm:grid-cols-[1fr_auto] sm:items-center" aria-label="Previous round">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-dim">Round #{round.id} · opening now</p>
        <p className="mt-1 font-semibold text-chalk">{round.question.text}</p>
        {status && <p className={`mt-1 text-sm ${lost ? "text-side-a" : "text-dim"}`}>{status}</p>}
      </div>
      <div className="flex items-center gap-4 font-mono text-sm">
        <span className="text-side-a">{round.question.a} {round.revealed_a}</span>
        <span className="text-side-b">{round.question.b} {round.revealed_b}</span>
        <span className="text-dim">
          {opened}/{round.commits} opened
        </span>
      </div>
    </div>
  );
}
