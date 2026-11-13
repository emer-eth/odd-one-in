import { useCallback, useEffect, useRef, useState } from "react";
import { WatchRound } from "./components/Hero";
import { BalanceChip, Countdown, Streak } from "./components/Panels";
import { CrowdField, Journey } from "./components/Round";
import { Fairness, Footer, HowItWorks, Logo, Payouts, RecentRounds } from "./components/Sections";
import { ResultCard } from "./components/ResultCard";
import { commitHash, deleteSalt, loadSalt, newSalt, readableError, saveSalt } from "./lib/game";
import {
  GUEST_API,
  accountBalance,
  callWithKey,
  createGuest,
  depositAsGuest,
  fmtNear,
  isGuest,
  savedGuest,
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
/** A guest keeps this much NEAR outside the game for gas. Gas is prepaid and mostly refunded: a full
 *  `play` call can hold about 0.11 NEAR for a moment on testnet, so less than this makes the call bounce. */
const GUEST_GAS_RESERVE = 140_000_000_000_000_000_000_000n; // 0.14 NEAR

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
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!nudge) return;
    g.refresh();
    g.refreshKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);

  useEffect(() => {
    // A connected wallet first; otherwise the guest account this browser made earlier.
    restoreAccount().then((a) => setAccount(a ?? savedGuest()));
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
      setSelected(null);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  };

  const deposit = async (yocto: bigint) => {
    if (!account) return;
    setBusy(isGuest(account) ? "Adding test NEAR" : "Waiting for your wallet");
    setError(null);
    try {
      if (isGuest(account)) {
        const spare = (await accountBalance(account)) - GUEST_GAS_RESERVE;
        if (spare < yocto) throw new Error("This guest account has used up its test NEAR. Connect a NEAR testnet wallet to keep playing.");
        await depositAsGuest(account, yocto);
      } else {
        const active = await sessionKeyActive(account);
        await depositWithWallet(account, yocto, !active);
      }
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

  /** No wallet: make a guest account, put its test NEAR in the game and seal the pick, in one go. */
  const playAsGuest = async () => {
    if (!cur || !cfg || !selected) return;
    const side = selected;
    const round = cur.id;
    setError(null);
    try {
      setBusy("Making you a guest account");
      const acct = savedGuest() ?? (await createGuest());
      setAccount(acct);
      const player = await view<{ balance: string } | null>("get_player", { account_id: acct });
      if (BigInt(player?.balance ?? 0) < cost) {
        setBusy("Adding free test NEAR");
        const spare = (await accountBalance(acct)) - GUEST_GAS_RESERVE;
        if (spare < cost + BigInt(cfg.storage_fee)) throw new Error("This guest account has used up its test NEAR. Connect a NEAR testnet wallet to keep playing.");
        await depositAsGuest(acct, spare);
      }
      setBusy("Sealing your pick");
      const salt_hex = newSalt();
      if (!saveSalt(acct, round, { choice: side, salt_hex })) throw new Error("This browser won't save data, so your pick couldn't be opened later. Allow site storage and try again.");
      const hash = await commitHash(round, acct, side, salt_hex);
      const res = await callWithKey<PlayResult>(acct, "play", { reveal: null, commit: { round_id: round, hash } }, 50);
      if (!res.commit?.ok) {
        deleteSalt(acct, round);
        throw new Error(res.commit?.error || "The pick wasn't sealed.");
      }
      setJustSealed(true);
      setSelected(null);
      setWarnStorage(true);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
      // `g` here still belongs to the render before the guest account existed: refresh from the next render.
      setNudge((n) => n + 1);
    }
  };

  const disconnect = async () => {
    if (isGuest(account)) return; // a guest account lives in this browser; there is nothing to disconnect
    await disconnectWallet();
    setAccount(savedGuest());
  };

  if (!cfg || !cur) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center text-ink-2">
        {g.loadError ? <p>Couldn't reach NEAR testnet. Retrying… ({g.loadError})</p> : <p className="font-mono text-sm">Loading this round's question…</p>}
      </div>
    );
  }

  const guest = isGuest(account);
  const guestOn = !!GUEST_API;
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
                {guest ? (
                  <button onClick={connect} disabled={!!busy} className="hidden text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline sm:block" title={`Guest account ${account}: a free testnet account kept in this browser. Connect a wallet to play from your own account.`}>
                    Guest · use a wallet
                  </button>
                ) : (
                  <button onClick={disconnect} className="hidden max-w-[10rem] truncate text-sm text-ink-2 hover:text-ink sm:block" title="Disconnect">
                    {account}
                  </button>
                )}
              </>
            ) : (
              <button onClick={connect} disabled={!!busy} className="rounded-xl bg-odd px-4 py-2 text-sm font-bold text-night disabled:opacity-50">
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        <section id="play" aria-label="This round" className="grid gap-10 pt-8 pb-10 text-chalk lg:grid-cols-2 lg:gap-12 lg:pt-12">
          <div>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs uppercase tracking-widest text-odd">
              <span className="flex items-center gap-2">
                <span className="live-dot h-2 w-2 rounded-full bg-odd" />
                Round {cur.id}
              </span>
              <span className="text-dim">
                closes in{" "}
                <span className="text-base text-chalk">
                  <Countdown ms={msLeft} />
                </span>
              </span>
            </p>
            <h1 className="display mt-4 text-[2rem] font-extrabold text-chalk sm:text-5xl">{cur.question.text}</h1>
            <p className="mt-4 max-w-md text-[17px] leading-relaxed text-dim">
              Everyone picks in secret. When the picks are opened, <span className="text-chalk">the smaller crowd wins</span>. Be the odd one in.
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
                  One-tap play isn&apos;t set up in this browser.{" "}
                  <button onClick={enable} className="font-semibold underline">
                    Enable it
                  </button>{" "}
                  (one wallet approval; the key can only call this game).
                </p>
              )}
            </div>

            <div className="mt-6">
              {committed ? (
                <div className={`rounded-3xl border border-board-line bg-board-2 p-6 ${justSealed ? "animate-seal" : ""}`}>
                  <div className="flex items-center gap-5">
                    <span className={`grid h-20 w-20 shrink-0 place-items-center rounded-full font-mono text-[11px] tracking-widest ${myCurChoice === "A" ? "bg-side-a text-night" : myCurChoice === "B" ? "bg-side-b text-white" : "bg-board-line text-dim"}`}>
                      SEALED
                    </span>
                    <div>
                      <p className="display text-2xl font-extrabold">Your pick is in.</p>
                      <p className="mt-1 text-dim">
                        {myCurChoice ? <>You picked <span className="text-chalk">{myCurChoice === "A" ? cur.question.a : cur.question.b}</span>. Nobody else can see it.</> : "Nobody can see it until it's opened."}
                      </p>
                    </div>
                  </div>
                  <div className="mt-6">
                    <Journey stage={1} ms={msLeft} label={`Round ${cur.id}`} />
                  </div>
                  <p className="mt-5 text-sm text-dim">{comeBack}</p>
                  <p className="mt-2 text-sm text-side-a">
                    A pick that isn&apos;t opened in that window loses its stake and bond ({fmtNear(cost)} NEAR). It can only be opened from this browser.
                  </p>
                  {warnStorage && <p className="mt-2 text-sm text-side-a">Clearing this browser&apos;s data before then loses the pick.</p>}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["A", "B"] as const).map((side) => {
                    const label = side === "A" ? cur.question.a : cur.question.b;
                    const isSel = selected === side;
                    const dim = selected && !isSel;
                    return (
                      <button
                        key={side}
                        disabled={!canPick}
                        onClick={() => (account || guestOn ? setSelected(isSel ? null : side) : connect())}
                        aria-pressed={isSel}
                        className={`relative flex min-h-[150px] flex-col justify-between rounded-3xl p-5 text-left transition duration-200 sm:min-h-[190px] ${side === "A" ? "bg-side-a text-night" : "bg-side-b text-white"} ${
                          dim ? "opacity-30" : "hover:-translate-y-0.5"
                        } ${isSel ? "ring-4 ring-odd ring-offset-4 ring-offset-paper" : ""} disabled:cursor-not-allowed`}
                      >
                        <span className="font-mono text-xs tracking-widest opacity-80">{isSel ? "SELECTED" : `PICK ${side}`}</span>
                        <span className="display text-2xl font-extrabold sm:text-[1.7rem]">{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {selected && !committed && (
              <div className="sticky bottom-3 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-board-line bg-board-2/95 p-3 pl-5 backdrop-blur">
                <p className="flex-1 text-sm text-dim">
                  Seal <span className="font-semibold text-chalk">{selected === "A" ? cur.question.a : cur.question.b}</span> · {fmtNear(cost)} {account ? "NEAR" : "test NEAR, on us"} (bond{" "}
                  {fmtNear(cfg.bond)} returns when opened)
                  <span className="mt-1 block text-xs">
                    It must be opened {openWindow}. This tab does it for you if it stays open; unopened picks lose stake and bond.
                  </span>
                </p>
                <button
                  onClick={!account ? playAsGuest : needsDeposit ? () => setDepositSignal((n) => n + 1) : needsKey ? enable : seal}
                  disabled={!!busy}
                  className="rounded-full bg-odd px-6 py-3 font-semibold text-night disabled:opacity-40"
                >
                  {!account ? "Seal my pick" : needsDeposit ? "Deposit first" : needsKey ? "Enable one-tap" : "Seal my pick"}
                </button>
              </div>
            )}

            {!account &&
              (guestOn ? (
                <p className="mt-4 text-sm text-dim">
                  No wallet needed: tap an answer and you get a free guest account with test NEAR. Or{" "}
                  <button className="underline" onClick={connect}>
                    connect a NEAR testnet wallet
                  </button>
                  .
                </p>
              ) : (
                <p className="mt-4 text-sm text-dim">
                  Tap an answer to connect a NEAR testnet wallet.{" "}
                  <a className="underline" href="https://testnet.mynearwallet.com" target="_blank" rel="noreferrer">
                    Need one?
                  </a>
                </p>
              ))}

            <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 font-mono text-xs uppercase tracking-widest text-dim">
              <div>
                <dt>Sealed</dt>
                <dd className="display mt-1 text-2xl font-extrabold normal-case tracking-normal text-chalk">{cur.commits}</dd>
              </div>
              <div>
                <dt>Streak pot</dt>
                <dd className="display mt-1 text-2xl font-extrabold normal-case tracking-normal text-chalk">{fmtNear(g.pot)} <span className="text-base text-dim">NEAR</span></dd>
              </div>
              {g.player && (
                <div title={`Win ${cfg.streak_target} in a row for a ${fmtNear(cfg.streak_bonus)} NEAR bonus`}>
                  <dt>Your streak</dt>
                  <dd className="display mt-1 text-2xl font-extrabold normal-case tracking-normal text-chalk">
                    {g.player.streak} <span className="text-base text-dim">/ {cfg.streak_target}</span>
                  </dd>
                </div>
              )}
            </dl>
            {g.player && (
              <div className="mt-4">
                <Streak player={g.player} config={cfg} />
              </div>
            )}
          </div>

          <div className="lg:sticky lg:top-20 lg:self-start">
            <CrowdField
              round={g.prev && g.prev.commits > 0 ? g.prev : g.recent[0] ?? null}
              ms={msLeft}
              sealedNow={cur.commits}
              mine={g.prev && g.prev.commits > 0 ? g.entryPrev?.revealed ?? null : null}
            />
            {g.prev && g.entryPrev?.committed && (
              <div className="mt-4 rounded-2xl border border-board-line bg-board-2 p-5">
                <Journey stage={2} ms={msLeft} label={`Your pick in round ${g.prev.id}`} />
                <p className={`mt-3 text-sm ${!g.entryPrev.revealed && !g.prevSalt ? "text-side-a" : "text-dim"}`}>
                  {g.entryPrev.revealed
                    ? `Your pick is open: ${g.entryPrev.revealed === "A" ? g.prev.question.a : g.prev.question.b}.`
                    : busy === "Opening yesterday's vote"
                      ? "Opening your pick…"
                      : g.prevSalt
                        ? "Your pick is waiting to be opened."
                        : "This pick was sealed on another device, or this browser's data was cleared, so it can't be opened here. Unopened picks lose stake and bond."}
                </p>
              </div>
            )}
          </div>
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
