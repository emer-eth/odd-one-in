# Odd One In: build spec

> **Amendments (2026-11-10), applied in the sections below:**
> 1. Jackpot replaced by a fixed streak bonus paid from a capped pot (3.4–3.6). The old 20%-of-jackpot payout could be farmed risk-free: 2^k hedged wallets guarantee one k-streak at a cost of (2^k − 1)·s·f. The bonus must stay below that cost, and the contract enforces it.
> 2. `commit(round_id, hash)`: a commit that lands after the round boundary fails with `WRONG_PHASE` instead of being stored under the wrong round and forfeiting at reveal.
> 3. Storage: a one-time `storage_fee` on registration, `MAX_PENDING = 10` open rounds per player.
> 4. `play` reports per-step results for commit as well as reveal, so a failed commit never rolls back the claim. `claim` with nothing due is a no-op.
> 5. A round's question index is stored on its first commit, so `add_questions` never changes the question of a round already in play.
> 6. Demo round length: 2 to 3 minutes.

You are building a hackathon entry for the NEAR Hackathon (nearhackathon.com). Read this whole file before writing code. Where this spec and your assumptions differ, follow the spec. Where the spec says "verify", check the current NEAR docs before implementing, because those details were written without doc access.

## 1. What it is

Odd One In is a daily minority game on NEAR. Every round has one question with two answers. Every player sees the same question. Players stake a fixed amount and pick a side in secret. When votes are opened, the side with fewer players wins.

Target track: Games With Real Economies.

Hard constraints from the hackathon:

- Final submission deadline is 14 Nov 2026, 23:59 UTC.
- The repo must be public.
- AI screeners (Claude Code and Codex) check that the project runs and matches its README. Every claim in the README must be true of the code. Do not describe features that are not built.
- A demo video will be recorded from the running app, so the full loop must be playable in minutes using a short round length.

## 2. Scope

In scope:

- One Rust smart contract on NEAR testnet.
- One static single-page web app.
- A seed script that creates test players and plays rounds, for testing and the demo video.
- README with run steps, rules, payout math, sybil analysis, known limits, roadmap.

Out of scope. Do not build these:

- Any backend server, database or indexer.
- Custom user-submitted questions, private rooms, chat, profiles.
- A token, NFTs, USDC stakes, cross-chain deposits.
- Proof of personhood.
- TEE or timelock vote opening.

## 3. Game rules

### 3.1 Rounds and timing

- `round_id = floor((block_timestamp - genesis_ts) / round_duration)`.
- Round `r` has three phases:
  - Commit phase: while the current round is `r`.
  - Reveal phase: while the current round is `r + 1`.
  - Settled: from the moment the current round is `r + 2` or later.
- Rounds overlap. During any given round the player can claim round `r - 2`, reveal round `r - 1`, and commit to round `r`.
- `round_duration` is a config value. Production is 24 hours. Demo uses 2 to 3 minutes, tests use seconds.
- No cron job exists. Settlement is lazy and happens inside the first call that needs it.

### 3.2 Commit and reveal

- Commit: the player submits `hash = sha256(utf8("{round_id}:{account_id}:{choice}:{salt_hex}"))` where `choice` is `"A"` or `"B"` and `salt_hex` is 32 random bytes as lowercase hex. The hash is sent as lowercase hex.
- Commit costs `stake + bond`, taken from the player's internal balance.
- One commit per account per round. No changes after commit.
- Reveal: the player submits `round_id`, `choice`, `salt_hex`. The contract recomputes the hash using `predecessor_account_id` and compares. On success the bond returns to the player's balance and the side tally increases.
- A commit that is not revealed during the reveal phase forfeits both stake and bond.

### 3.3 Outcome

Let `a` and `b` be the revealed counts for each side.

- If `a == b`, or `a == 0`, or `b == 0`, the round is VOID.
- Otherwise the side with fewer reveals is the winner.

### 3.4 Payouts

Let `m` be the minority count, `M` the majority count, `u` the number of unrevealed commits, `s` the stake, `f` the fee rate.

Per player, paid at claim:

| Player state | Credit to balance at claim |
|---|---|
| Revealed, on winning side | `s + s * (1 - f)` |
| Revealed, on losing side | `0` |
| Revealed, round VOID | `s` |
| Not revealed | `0` (bond was never returned) |

Pools, updated once at settlement:

- Not VOID: `pot += (M - m) * s + u * (s + bond)` and `fees += m * floor(s * f)`.
- VOID: `pot += u * (s + bond)`.
- If `pot > pot_cap`, the excess moves to `fees` (treasury).

This payout shape is deliberate. Each winner gains exactly one stake and each loser loses exactly one stake, so a player who places one wallet on each side nets zero minus the fee. Do not change it to "minority splits the majority pot". That version lets hedged wallet pairs extract risk-free profit.

Worked example for tests. `s = 1`, `bond = 1`, `f = 2%`, reveals `A = 6`, `B = 8`, unrevealed `u = 1`:

- A wins. Each A player is credited `1.98`. Total `11.88`.
- `fees += 0.12`.
- `pot += 2 + 2 = 4`.
- Conservation check: money in is 15 stakes plus 1 forfeited bond, `16`. Money out is `11.88 + 0.12 + 4 = 16`.

### 3.5 Streaks and streak bonus

- Each player has `streak` and `best_streak`.
- Claims are processed in ascending round order. Win: `streak += 1`. Loss or forfeit: `streak = 0`. VOID: unchanged. Rounds the player skipped do not affect the streak.
- When `streak` reaches `streak_target`, credit the player `min(streak_bonus, pot)`, reduce the pot by the same amount, and reset `streak` to 0. `best_streak` keeps the high-water mark.
- Sybil bound, enforced at init: `streak_bonus < (2^streak_target - 1) * floor(s * f)`. That is the cost of guaranteeing one streak with hedged wallets (and the expected cost of one streak at fair odds), so farming the bonus always loses money.

### 3.6 Default config

| Key | Default | Notes |
|---|---|---|
| `round_duration_ns` | 24h | 10 min for demo, seconds for tests |
| `stake` | 0.1 NEAR | yoctoNEAR in storage |
| `bond` | 0.1 NEAR | |
| `fee_bps` | 200 | |
| `streak_target` | 7 | |
| `streak_bonus` | 0.2 NEAR | must be below 127 × 0.002 = 0.254 NEAR |
| `pot_cap` | 2 NEAR | excess goes to fees |
| `storage_fee` | 0.02 NEAR | taken once on first deposit, not credited |
| `genesis_ts` | set at init | |

## 4. Contract

Rust with `near-sdk`. Verify the current stable `near-sdk` version and its collection types before starting.

### 4.1 State

```
Config        { owner, genesis_ts, round_duration_ns, stake, bond,
                fee_bps, streak_target, streak_bonus, pot_cap, storage_fee }
Question      { text, a, b }
questions     Vector<Question>          // round r uses index r % len
rounds        LookupMap<u64, Round>
Round         { commits: u32, revealed_a: u32, revealed_b: u32,
                settled: bool, outcome: Option<Outcome>, question: Option<u32> }
Outcome       A | B | Void
entries       LookupMap<(AccountId, u64), Entry>
Entry         { hash: [u8; 32], revealed: Option<Choice> }
players       LookupMap<AccountId, Player>
Player        { balance: u128, streak: u32, best_streak: u32,
                pending: Vec<u64> }     // rounds committed, not yet claimed
pot           u128
fees          u128
total_balances u128   // sum of player balances
locked        u128   // stakes and bonds held in open or unclaimed rounds
```

Delete an `Entry` when it is claimed so storage does not grow without bound.

### 4.2 Change methods

| Method | Behavior |
|---|---|
| `new(config, questions)` | Init. Requires at least one question. |
| `deposit()` payable | Credits attached NEAR to the caller's balance. Creates the player if new. Minimum is `stake + bond`. |
| `withdraw(amount)` | Debits balance, transfers NEAR to the caller. Fails if balance is short. |
| `commit(round_id, hash)` | `round_id` must equal the current round, else `WRONG_PHASE`. Fails if already committed, balance is below `stake + bond`, or `pending` already holds `MAX_PENDING` rounds (`TOO_MANY_PENDING`). Pushes the round to `pending`. |
| `reveal(round_id, choice, salt_hex)` | Only when `round_id == current - 1`. Verifies hash. Returns bond. |
| `settle(round_id)` | Anyone. Only when `round_id <= current - 2`. Idempotent. Computes outcome and pool updates in O(1) from tallies. |
| `claim()` | Processes the caller's `pending` rounds in ascending order, for every round that is due. Settles each one lazily if needed. Cap at 10 rounds per call. Nothing due is a no-op, not an error. Returns one result per claimed round. |
| `play(reveal, commit_hash)` | Convenience for the daily visit. Runs `claim()`, then the optional reveal, then the optional commit, in that order, in one call. A failed reveal must not block the commit, and a failed commit must not undo the claim, so return per-step results instead of panicking. |
| `add_questions(list)` | Owner only. |
| `withdraw_fees()` | Owner only. |

`play` exists because a transaction signed with a function-call access key can carry only one function-call action. Verify this in the access key docs. If it turns out batches are allowed, `play` is still the simplest path.

### 4.3 View methods

- `get_config()`
- `get_current_round()` returns `{ id, commit_ends_at, question, commits }`
- `get_round(id)` returns the Round plus its question and phase
- `get_player(account_id)` returns balance, streak, best_streak, pending
- `get_entry(account_id, round_id)` returns `{ committed, revealed }`. Never return the hash preimage.
- `get_pot()`
- `get_totals()` returns balances, locked, pot, fees, for the invariant check
- `get_recent_rounds(limit)` returns the latest settled rounds for the history strip

### 4.4 Errors

Use short stable error strings the frontend can map to messages: `NOT_REGISTERED`, `LOW_BALANCE`, `ALREADY_COMMITTED`, `WRONG_PHASE`, `BAD_REVEAL`, `ALREADY_REVEALED`, `NOT_DUE`, `NOT_OWNER`, `BAD_HASH`, `TOO_MANY_PENDING`, `BAD_CONFIG`.

### 4.5 Invariants

- Contract NEAR balance is always at least the sum of player balances, plus pot, plus fees, plus stakes and bonds locked in open rounds.
- All money math is integer yoctoNEAR. Round fee down, and leave dust in `fees`.
- No method loops over all players.

### 4.6 Tests

Unit tests are required for:

1. The worked example in 3.4, including the conservation check.
2. VOID cases: tie, all on one side, zero reveals.
3. Unrevealed commit forfeits stake and bond to the pot.
4. Reveal with wrong salt, wrong choice, wrong account, wrong phase.
5. Hedged pair: two accounts on opposite sides net exactly `-fee` in a non-VOID round.
6. Streak reaching target pays `min(streak_bonus, pot)` and resets. Init rejects a bonus at or above the sybil bound.
9. A commit for a past round fails with `WRONG_PHASE`.
10. Pot overflow above `pot_cap` moves to fees.
7. Claim order and idempotency. Claiming twice pays once.
8. `play` where the reveal fails still commits.

## 5. Frontend

### 5.1 Stack

- Vite, React, TypeScript, Tailwind. Static build, deployable to Vercel or Netlify.
- NEAR wallet connection library: verify which one NEAR currently recommends before choosing. Candidates are `@near-wallet-selector` and the newer NEAR Connect.
- Views go straight to the RPC. No backend.
- Config through env vars: `VITE_NETWORK`, `VITE_CONTRACT_ID`.

### 5.2 NEAR integration

1. Connect. On sign-in, request a function-call access key scoped to the contract with methods `play, commit, reveal, claim, settle, withdraw`. After this the daily actions sign without a wallet popup.
2. Deposit. Function-call keys cannot attach NEAR, so `deposit()` is the one action that goes through a full wallet approval. The player does this once and tops up when low. Verify the no-deposit rule and the key's gas allowance behavior in the docs.
3. Daily play. One `play` call does claim, reveal and commit.
4. Show named accounts such as `emer.testnet` everywhere a player appears.
5. Derive all timing from `get_config` and the chain, never from the local clock alone. Use local time only to animate the countdown between polls.

### 5.3 Salt handling

- On commit, generate 32 random bytes with `crypto.getRandomValues`.
- Before sending the transaction, save `{ choice, salt_hex }` to localStorage under `ooi:{network}:{contract}:{account}:{round_id}`.
- On the next visit, read it back and pass it to `play` as the reveal.
- Delete the record after a successful reveal.
- If the record is missing for a committed round, show a clear message that the vote cannot be opened from this device.

### 5.4 Screen states

One page, mobile first, four states driven by chain data.

1. Landing. Today's question, the two answers as the two halves of the screen, countdown to round close, streak pot size, number of sealed votes so far. A connect button. After connect, a deposit prompt if balance is below `stake + bond`.
2. Pick. Tapping a half selects it, a confirm button seals it. After the transaction succeeds, the chosen half folds into a sealed envelope. Copy: "Sealed. Come back tomorrow to open it." Warn once that clearing browser data loses the vote.
3. Return visit. On load, if a reveal is due and the salt exists, call `play` automatically with the reveal and show "Opening yesterday's vote". Then show yesterday's question with its live reveal tally next to today's question, which is in state 1 or 2.
4. Result. For each newly settled round the player was in: two bars grow from zero to their final counts over about 1.2 seconds, the smaller bar lights up, then the player's outcome, balance change and streak appear. A share button renders a PNG card with the question, both counts and the result, sized for X.

Also on the page:

- Balance chip with deposit and withdraw.
- Streak indicator showing progress to the target.
- History strip of recent rounds with their counts.
- A short "How it works" section with the rules and payout table.

### 5.5 Visual direction

| Token | Value |
|---|---|
| Background | `#0B0B0F` |
| Surface | `#16161D` |
| Side A | `#FF5A3C` |
| Side B | `#3CC8FF` |
| Text | `#F5F2EA` |
| Muted | `#8A8A94` |
| Win accent | `#C8FF3C` |

- Display type: a heavy grotesque such as Bricolage Grotesque. Numbers and countdown in a monospace such as JetBrains Mono.
- The question is the largest thing on screen. The two halves fill the viewport below it, stacked on mobile and side by side on desktop.
- Before the reveal, never show which side is ahead for the current round. Only the total count of sealed votes.
- Motion is limited to the seal, the bar reveal and the countdown. Respect `prefers-reduced-motion`.
- Every transaction has a visible pending state and a readable error mapped from the contract error strings.

## 6. Seed script

`scripts/seed.ts`, run with a funded testnet account.

- Creates N sub-accounts, deposits for each.
- For a given round, commits a chosen split such as 6 on A and 8 on B, with an option to leave some unrevealed.
- Reveals in the next round.
- Stores salts in a local JSON file.

This is how the demo video gets a populated round, and it doubles as an integration test.

## 7. Repo layout

```
contract/         Rust contract and unit tests
web/              Vite app
scripts/          deploy.sh, seed.ts
README.md
LICENSE
```

## 8. README requirements

- One paragraph on what it is, and the track.
- Run steps that work from a clean clone: build and test the contract, deploy to testnet, configure and run the web app, run the seed script.
- The deployed testnet contract ID and the live URL.
- Rules and the payout table from section 3.
- Sybil analysis, stated plainly:
  - Stacking one side is self-defeating.
  - Hedging both sides nets zero minus the fee because of the symmetric payout.
  - Farming the streak bonus with a tree of hedged wallets costs `(2^target - 1) * s * f`, and the contract requires the bonus to be smaller.
  - Known limit: a large one-sided group of wallets can still profit by withholding reveals when the margin is thin. The bond raises the cost and does not close it.
- Known limits: a missed reveal day forfeits that vote, and salts live in one browser.
- Roadmap: votes opened all at once by a TEE or timelock, stablecoin stakes, cross-chain deposits, private rooms on the shared daily question.
- The build runs on testnet with test NEAR, so no real money is at stake.

## 9. Build order

1. Contract with all unit tests passing. Deploy to testnet with a 3 minute round.
2. Web states 1 and 2: connect, deposit, commit.
3. `play` on return visit, reveal, claim, result screen.
4. Seed script, then a full loop played end to end with seeded players.
5. History strip, share card, error states, README.

## 10. Definition of done

- From a clean clone, the README steps produce a running app against testnet.
- A new account can connect, deposit once, and then commit, reveal and claim across three consecutive rounds with no wallet popup after the deposit.
- The worked example in 3.4 reproduces on testnet through the seed script, and the balances match to the yoctoNEAR.
- All contract unit tests pass.
- Nothing in the README describes a feature that is not in the code.

## 11. Verify before implementing

- Current stable `near-sdk` version and collection APIs.
- The recommended wallet connection library and how it requests a function-call access key.
- Function-call access key rules: no attached deposit, one function-call action per transaction, gas allowance.
- Storage cost per entry, and whether the owner account needs extra balance to cover storage.
- Testnet sub-account creation for the seed script.
