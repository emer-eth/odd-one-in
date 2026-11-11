import { useCallback, useEffect, useRef, useState } from "react";
import { Masthead, WatchRound } from "./components/Hero";
import { BalanceChip, Countdown, Streak } from "./components/Panels";
import { Crowd, Journey, Opening } from "./components/Round";
import { Fairness, Footer, HowItWorks, Logo, Payouts, RecentRounds } from "./components/Sections";
import { ResultCard } from "./components/ResultCard";
import { commitHash, deleteSalt, loadSalt, newSalt, readableError, saveSalt } from "./lib/game";
import {
  callWithKey,
  fmtNear,
  sessionKey,
  sessionKeyActive,
  view,
  type Choice,
  type ClaimItem,
  type PlayResult,
  type RoundView,
} from "./lib/near";
import { msUntil, useGame } from "./lib/useGame";
import { connectWallet, depositWithWallet, disconnectWallet, enableOneTap, restoreAccount } from "./lib/wallet";

type Result = { item: ClaimItem; round: RoundView };

const WARNED_KEY = "ooi:warned-storage";

export default function App() {
  const [account, setAccount] = useState<string | null>(null);
  const g = useGame(account);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Choice | null>(null);
  const [justSealed, setJustSealed] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [warnStorage, setWarnStorage] = useState(false);
  const [, tick] = useState(0);
  const autoTried = useRef(new Set<string>());
  const [depositSignal, setDepositSignal] = useState(0);

  useEffect(() => {
    restoreAccount().then((a) => a && setAccount(a));
  }, []);

  // Countdown animation between polls; refresh as soon as the round rolls over.
  const msLeft = g.cur ? msUntil(g.cur.commit_ends_at, g.offsetMs) : 0;
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const rolled = useRef<number | null>(null);
  useEffect(() => {
    if (g.cur && msLeft <= 0 && rolled.current !== g.cur.id) {
      rolled.current = g.cur.id;
      g.refresh();
    }
  });
  useEffect(() => {
    setJustSealed(false);
    setSelected(null);
  }, [g.cur?.id]);

  const cfg = g.config;
  const cur = g.cur;
  const cost = cfg ? BigInt(cfg.stake) + BigInt(cfg.bond) : 0n;
  const balance = BigInt(g.player?.balance ?? 0);
  const committed = !!g.entryCur?.committed;
  const myCurChoice = account && cur ? loadSalt(account, cur.id)?.choice ?? null : null;
  const revealDue = !!(g.entryPrev?.committed && !g.entryPrev.revealed && g.prevSalt);
  const claimsDue = !!(cur && g.player?.pending.some((r) => r + 2 <= cur.id));
  const roundMinutes = cfg ? Number(BigInt(cfg.round_duration_ns) / 60_000_000_000n) : 0;
  // When this round's votes can be opened: the whole of the next round. Shown in the visitor's local time.
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const opensAt = cur ? Number(BigInt(cur.commit_ends_at) / 1_000_000n) - g.offsetMs : 0;
  const opensUntil = cfg ? opensAt + Number(BigInt(cfg.round_duration_ns) / 1_000_000n) : 0;
  const openWindow = roundMinutes >= 1440 ? "tomorrow" : `between ${clock(opensAt)} and ${clock(opensUntil)}`;
  const comeBack = `Keep this tab open, or come back ${openWindow}: your vote opens by itself then.`;

  const showClaims = useCallback(async (items: ClaimItem[]) => {
    const rounds = await Promise.all(items.map((i) => view<RoundView>("get_round", { id: i.round_id })));
    setResults((r) => [...r, ...items.map((item, k) => ({ item, round: rounds[k] }))]);
  }, []);

  /** One `play` call signed by the session key: claim, then optional reveal, then optional commit. */
  const runPlay = useCallback(
    async (label: string, commit: { round_id: number; hash: string } | null) => {
      if (!account || !cur) return null;
      const reveal = revealDue && g.prevSalt ? { round_id: cur.id - 1, ...g.prevSalt } : null;
      const dueClaims = g.player?.pending.filter((r) => r + 2 <= cur.id).length ?? 0;
      setBusy(label);
      setError(null);
      try {
        const gas = Math.min(30 + 6 * Math.min(dueClaims, 10) + (reveal ? 10 : 0) + (commit ? 10 : 0), 120);
        const res = await callWithKey<PlayResult>(account, "play", { reveal, commit }, gas);
        if (reveal && res.reveal?.ok) deleteSalt(account, reveal.round_id);
        if (reveal && res.reveal && !res.reveal.ok) setError(readableError(res.reveal.error));
        if (commit && res.commit && !res.commit.ok) {
          deleteSalt(account, commit.round_id);
          setError(readableError(res.commit.error));
        }
        if (res.claimed.length) await showClaims(res.claimed);
        return res;
      } catch (e) {
        if (commit) deleteSalt(account, commit.round_id);
        setError(readableError(e));
        if (/allowance|AccessKey/i.test(String(e))) g.refreshKey();
        return null;
      } finally {
        setBusy(null);
        g.refresh();
      }
    },
    [account, cur, revealDue, g, showClaims],
  );

  // Return visit: open yesterday's vote and claim finished rounds automatically, once per round.
  useEffect(() => {
    if (!account || !cur || !g.keyActive || busy) return;
    if (!revealDue && !claimsDue) return;
    const key = `${account}:${cur.id}:${revealDue}:${claimsDue}`;
    if (autoTried.current.has(key)) return;
    autoTried.current.add(key);
    runPlay(revealDue ? "Opening yesterday's vote" : "Collecting results", null);
  }, [account, cur, g.keyActive, busy, revealDue, claimsDue, runPlay]);

  const connect = async () => {
    setError(null);
    try {
      setBusy("Connecting wallet");
      setAccount(await connectWallet());
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  };

  const deposit = async (yocto: bigint) => {
    if (!account) return;
    setBusy("Waiting for your wallet");
    setError(null);
    try {
      const active = await sessionKeyActive(account);
      await depositWithWallet(account, yocto, !active);
      await g.refreshKey();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
      g.refresh();
    }
  };

  const withdraw = async (yocto: bigint) => {
    if (!account) return;
    setBusy("Withdrawing");
    setError(null);
    try {
      await callWithKey(account, "withdraw", { amount: yocto.toString() }, 30);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
      g.refresh();
    }
  };

  const enable = async () => {
    if (!account) return;
    setBusy("Waiting for your wallet");
    setError(null);
    try {
      // An on-chain key that still fails has run out of allowance: replace it.
      const onChain = await sessionKeyActive(account);
      await enableOneTap(account, onChain ? sessionKey(account).getPublicKey().toString() : null);
      await g.refreshKey();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  };

  const seal = async () => {
    if (!account || !cur || !selected) return;
    const salt_hex = newSalt();
    if (!saveSalt(account, cur.id, { choice: selected, salt_hex })) {
      setError("This browser won't save data, so your vote couldn't be opened later. Allow site storage and try again.");
      return;
    }
    const hash = await commitHash(cur.id, account, selected, salt_hex);
    const res = await runPlay("Sealing your vote", { round_id: cur.id, hash });
    if (res?.commit?.ok) {
      setJustSealed(true);
      setSelected(null);
      try {
        if (!localStorage.getItem(WARNED_KEY)) {
          setWarnStorage(true);
          localStorage.setItem(WARNED_KEY, "1");
        }
      } catch {
        setWarnStorage(true);
      }
    }
  };

  const disconnect = async () => {
    await disconnectWallet();
    setAccount(null);
  };

  if (!cfg || !cur) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center text-ink-2">
        {g.loadError ? <p>Couldn't reach NEAR testnet. Retrying… ({g.loadError})</p> : <p className="font-mono text-sm">Loading this round's question…</p>}
      </div>
    );
  }

  const needsDeposit = account && !committed && balance < cost;
  const needsKey = account && g.player && g.keyActive === false;
  const canPick = !committed && !busy;

  return (
    <>
      <nav className="sticky top-0 z-30 border-b border-rule/70 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a href="#" aria-label="Odd One In, top of page">
            <Logo />
          </a>
          <div className="hidden items-center gap-7 text-sm text-ink-2 md:flex">
            <a href="#play" className="hover:text-ink">Play</a>
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#payouts" className="hover:text-ink">Payouts</a>
            <a href="#fair" className="hover:text-ink">Fair play</a>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {account ? (
              <>
                <BalanceChip player={g.player} config={cfg} busy={!!busy} onDeposit={deposit} onWithdraw={withdraw} openSignal={depositSignal} />
                <button onClick={disconnect} className="hidden max-w-[10rem] truncate text-sm text-ink-2 hover:text-ink sm:block" title="Disconnect">
                  {account}
                </button>
              </>
            ) : (
              <button onClick={connect} disabled={!!busy} className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50">
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        <Masthead roundId={cur.id} />

        <section
          id="play"
          aria-label="This round"
          className="rounded-[2rem] bg-board p-5 text-chalk shadow-[0_40px_80px_-40px_rgba(14,14,16,0.6)] sm:p-8"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="stub stub-dark">
              <span>No. 01</span>
              <span className="flex items-center gap-2">
                <span className="live-dot h-2 w-2 rounded-full bg-odd" />
                Round {cur.id} · sealing
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {g.player && <Streak player={g.player} config={cfg} />}
              <span className="font-mono text-xs text-dim">
                POT <span className="text-odd">{fmtNear(g.pot)} NEAR</span>
              </span>
              <span className="flex items-baseline gap-2 text-sm text-dim">
                closes in <span className="text-2xl text-chalk sm:text-3xl"><Countdown ms={msLeft} /></span>
              </span>
            </span>
          </div>

          <h2 className="display mt-6 text-[2.5rem] font-extrabold text-chalk sm:text-6xl">{cur.question.text}</h2>
          <p className="mt-3 font-mono text-xs text-dim">
            {cur.commits} {cur.commits === 1 ? "vote" : "votes"} sealed · sides stay hidden until opening
            {g.player && <> · {g.player.streak}/{cfg.streak_target} wins in a row toward a {fmtNear(cfg.streak_bonus)} NEAR bonus</>}
          </p>

          <div aria-live="polite" className="mt-5 space-y-2 empty:hidden">
            {busy && <p className="rounded-xl bg-board-2 px-4 py-3 text-sm">⏳ {busy}…</p>}
            {error && (
              <p className="rounded-xl border border-side-a/40 bg-side-a/10 px-4 py-3 text-sm">
                {error}{" "}
                <button className="ml-2 underline" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </p>
            )}
            {needsDeposit && !busy && (
              <p className="rounded-xl bg-board-2 px-4 py-3 text-sm">
                Add at least {fmtNear(cost + (g.player ? 0n : BigInt(cfg.storage_fee)))} NEAR to play.{" "}
                <button onClick={() => setDepositSignal((n) => n + 1)} className="font-semibold underline">
                  Deposit
                </button>{" "}
                — your wallet asks once, then play needs no popups.
              </p>
            )}
            {needsKey && !needsDeposit && !busy && (
              <p className="rounded-xl bg-board-2 px-4 py-3 text-sm">
                One-tap play isn't set up in this browser.{" "}
                <button onClick={enable} className="font-semibold underline">
                  Enable it
                </button>{" "}
                (one wallet approval; the key can only call this game).
              </p>
            )}
          </div>

          <div className="mt-6">
            {committed ? (
              <div className={`grid min-h-[300px] place-items-center rounded-3xl border border-board-line bg-board-2 p-6 text-center sm:min-h-[360px] ${justSealed ? "animate-seal" : ""}`}>
                <div>
                  <div className="mx-auto h-28 w-40 [perspective:600px]">
                    <div className={`relative h-full w-full rounded-xl ${myCurChoice === "A" ? "bg-side-a" : myCurChoice === "B" ? "bg-side-b" : "bg-board-line"}`}>
                      <div className={`absolute inset-x-0 top-0 h-1/2 origin-top bg-black/25 [clip-path:polygon(0_0,100%_0,50%_100%)] ${justSealed ? "animate-flap" : ""}`} />
                    </div>
                  </div>
                  <p className="display mt-6 text-3xl font-extrabold">Sealed.</p>
                  <div className="mt-5">
                    <Journey stage={1} ms={msLeft} label="Your vote in this round" />
                  </div>
                  <div className="mt-6">
                    <Crowd n={cur.commits} mine />
                  </div>
                  <p className="mt-2 text-dim">
                    {comeBack} {myCurChoice && <span>You picked {myCurChoice === "A" ? cur.question.a : cur.question.b}.</span>}
                  </p>
                  <p className="mx-auto mt-3 max-w-md text-sm text-side-a">
                    A vote that isn&apos;t opened in that window loses its stake and bond ({fmtNear(cost)} NEAR). It can only be opened from this browser.
                  </p>
                  {warnStorage && <p className="mt-2 text-sm text-side-a">Clearing this browser&apos;s data before then loses the vote.</p>}
                </div>
              </div>
            ) : (
              <div className="grid grid-rows-2 gap-3 sm:h-[360px] sm:grid-cols-2 sm:grid-rows-1">
                {(["A", "B"] as const).map((side) => {
                  const label = side === "A" ? cur.question.a : cur.question.b;
                  const isSel = selected === side;
                  const dim = selected && !isSel;
                  return (
                    <button
                      key={side}
                      disabled={!canPick}
                      onClick={() => (account ? setSelected(isSel ? null : side) : connect())}
                      aria-pressed={isSel}
                      className={`relative flex min-h-[170px] items-end rounded-3xl p-6 text-left transition duration-200 ${side === "A" ? "bg-side-a" : "bg-side-b"} ${
                        dim ? "opacity-30" : "hover:-translate-y-0.5"
                      } ${isSel ? "ring-4 ring-chalk ring-offset-4 ring-offset-board" : ""} disabled:cursor-not-allowed`}
                    >
                      <span className="display text-4xl font-extrabold text-board sm:text-5xl">{label}</span>
                      <span className="absolute right-5 top-5 font-mono text-sm text-board/70">{isSel ? "selected" : side}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selected && !committed && (
            <div className="sticky bottom-3 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-board-line bg-board-2/95 p-3 pl-5 backdrop-blur">
              <p className="flex-1 text-sm text-dim">
                Seal <span className="font-semibold text-chalk">{selected === "A" ? cur.question.a : cur.question.b}</span> · {fmtNear(cost)} NEAR (bond{" "}
                {fmtNear(cfg.bond)} returns when opened)
                <span className="mt-1 block text-xs">
                  It must be opened {openWindow}. This tab does it for you if it stays open; unopened votes lose stake and bond.
                </span>
              </p>
              <button
                onClick={needsDeposit ? () => setDepositSignal((n) => n + 1) : needsKey ? enable : seal}
                disabled={!!busy}
                className="rounded-full bg-chalk px-6 py-3 font-semibold text-board disabled:opacity-40"
              >
                {needsDeposit ? "Deposit first" : needsKey ? "Enable one-tap" : "Seal vote"}
              </button>
            </div>
          )}

          {!account && (
            <p className="mt-4 text-sm text-dim">
              Tap an answer to connect a NEAR testnet wallet.{" "}
              <a className="underline" href="https://testnet.mynearwallet.com" target="_blank" rel="noreferrer">
                Need one?
              </a>
            </p>
          )}

          {g.prev && (g.prev.commits > 0 || g.entryPrev?.committed) && (
            <div className="mt-6">
              <Opening round={g.prev} entry={g.entryPrev} salt={g.prevSalt} opening={busy === "Opening yesterday's vote"} ms={msLeft} />
              {g.entryPrev?.committed && (
                <div className="mt-4 text-center">
                  <Journey stage={2} ms={msLeft} label={`Your vote in round ${g.prev.id}`} />
                </div>
              )}
            </div>
          )}
        </section>

        <RecentRounds rounds={g.recent} />
        <WatchRound />
        {/* Section numbers follow what is on the page: "Recent rounds" only shows once a round has been played. */}
        <HowItWorks config={cfg} n={g.recent.length ? "03" : "02"} />
        <Payouts config={cfg} n={g.recent.length ? "04" : "03"} />
        <Fairness config={cfg} pot={g.pot} n={g.recent.length ? "05" : "04"} />
        <Footer />
      </main>

      {results[0] && (
        <ResultCard key={results[0].item.round_id} item={results[0].item} round={results[0].round} stake={cfg.stake} onClose={() => setResults((r) => r.slice(1))} />
      )}
    </>
  );
}
