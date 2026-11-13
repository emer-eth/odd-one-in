# Odd One In

A daily minority game on NEAR. Every round has one question with two answers, and everyone sees the same one. You stake a fixed amount and pick a side in secret. When the votes are opened, **the side with fewer players wins**.

Track: **Games With Real Economies** (NEAR Hackathon).

- Contract (testnet): [`ooi.yourname-swarm.testnet`](https://testnet.nearblocks.io/address/ooi.yourname-swarm.testnet), with 3-minute rounds for the demo
- Live app: https://odd-one-in-zeta.vercel.app
- Source: https://github.com/emer-eth/odd-one-in
- Runs on NEAR testnet with test NEAR. No real money is at stake.

## Try it in 10 minutes

No wallet, no sign-up:

1. Open https://odd-one-in-zeta.vercel.app. See the question, the countdown and the streak pot, read live from the contract.
2. Tap an answer (orange or purple), then **Seal my pick**. See three short steps ("Making you a guest account", "Adding free test NEAR", "Sealing your pick"), then "Your pick is in" with a three-step tracker (Sealed, Opening, Result). This takes about 10 to 20 seconds and no wallet opens. The top bar now shows your game balance and "Guest".
3. Within about 20 seconds the "Sealed" count rises from 1 to 5 or 7 as the house players join your round.
4. Keep the tab open. When the next round starts (3 minutes at most), watch the crowd picture on the right: each opened pick becomes a circle in its side's colour and glides to its side, yours is marked "YOU", and the smaller crowd gets a dashed ring.
5. One round later, see the result card: you won a stake, lost it, or the round was void, with **Save card** and **Post on X**. The crowd picture keeps the last result, and the round appears under "Recent rounds".

With your own wallet instead: tap **connect a NEAR testnet wallet** under the answers (free at https://testnet.mynearwallet.com), pick an answer and deposit 0.5 NEAR. One wallet approval deposits and adds a play key that can only call this game; after that there are no popups.

Is it up? `GET <service URL>/health` (the URL is `VITE_GUEST_API` in the deployed app) reports the house players' last round and how many guest accounts are left today. No browser? `npm run test:contract` runs the unit tests, and `npm run seed -- status` reads the live contract.

## How a round works

1. **Commit.** While round `r` is current, you seal a vote: `sha256("{round_id}:{account_id}:{choice}:{salt_hex}")`, where the salt is 32 random bytes made in your browser. Sealing costs `stake + bond` from your game balance. Nobody, including the contract owner, can see your side.
2. **Reveal.** During round `r + 1` you open it by sending the choice and salt. The contract recomputes the hash with your account ID and, if it matches, counts the vote and returns your bond. The web app does this automatically when you visit.
3. **Settle.** From round `r + 2` the outcome is final. If the counts are tied, or one side has no votes, the round is **VOID**. Otherwise the smaller side wins.

Rounds overlap, so one visit can claim round `r − 2`, open round `r − 1` and seal round `r`. The contract's `play` method does all three in one transaction. There is no cron job: a round settles lazily inside the first call that needs it (`claim`, `play` or the public `settle`).

## Payouts

`s` is the stake, `f` the fee rate (2%), `m` the minority count, `M` the majority count and `u` the number of votes never opened.

| Your vote | Credited at claim |
|---|---|
| Opened, on the winning (smaller) side | `s + s·(1 − f)` |
| Opened, on the losing side | `0` |
| Opened, round VOID | `s` |
| Never opened | `0` (the bond was never returned either) |

At settlement, `(M − m)·s + u·(s + bond)` goes to the **streak pot** and `m·floor(s·f)` to fees. In a VOID round only `u·(s + bond)` goes to the pot. The pot is capped (`pot_cap`, 2 NEAR), and anything above the cap goes to fees.

**Streak bonus.** Each win adds 1 to your streak and each loss or unopened vote resets it to 0. VOID rounds and rounds you skip leave it unchanged. When the streak reaches `streak_target` (7) you get `min(streak_bonus, pot)` (0.2 NEAR) and the streak resets. `best_streak` keeps your high-water mark.

**Worked example** (`s = 1`, `bond = 1`, `f = 2%`; 6 open on A, 8 on B, 1 never opened). A wins, and each A player is credited 1.98 (11.88 in total). Fees get 0.12 and the pot gets `2·1 + 1·2 = 4`. In: 15 stakes plus 1 forfeited bond = 16. Out: 11.88 + 0.12 + 4 = 16. This is a unit test (`worked_example`), and the seed script checks the same accounting on testnet.

## House players (NPCs with wallets)

A minority game needs a crowd: alone in a round, one side has no votes and the round is void. So a small always-on script (`scripts/house.ts`, `npm run house`) runs **house players**: ordinary testnet accounts, each with its own wallet and game balance.

- **When they play.** They join any round in which a person has sealed a vote (within about 15 seconds, if at least 25 seconds of the round are left), and they play a showcase round of their own every 40 rounds (2 hours), so "Recent rounds" always has a result.
- **How they play.** Four or six of them seal votes split 1 to 3 or 2 to 4. A split that differs by two means one more vote on either side still leaves a winner, so a single visitor wins on one side and loses on the other: a coin flip, as the game intends. Which side is the smaller one is decided by a keyed random number per round.
- **What they can't do.** They use the same public methods as everyone (`commit`, `reveal`, `claim`), pay the same stake and bond, and can't see a visitor's vote: nobody can until it is opened. The contract has no special case for them.
- **What it costs.** In every round they play, the house's bigger side loses more than its smaller side wins, about 0.2 NEAR a round, which goes to the streak pot and fees. `npm run house -- fund 0.6` tops them up; `npm run house -- status` shows their balances.
- **Restart-safe.** Salts are derived from a secret and the round, and a vote's side is recovered by checking which of the two matches the sealed hash, so a restart between sealing and opening doesn't forfeit a vote.

If the house script isn't running, the game still works between people; a lone visitor's round is void and their stake comes back.

## Sybil analysis

- **Stacking one side defeats itself.** Extra wallets on a side make that side bigger, which makes it more likely to lose.
- **Hedging nets minus the fee.** Each winner gains exactly one stake (less the fee) and each loser loses exactly one stake, so a wallet on each side always loses `s·f`. That is why the excess goes to the pot instead of being split among the minority: a "minority splits the majority's stakes" payout would let hedged pairs take risk-free profit.
- **The streak bonus can't be farmed.** With `2^k` wallets an attacker can guarantee one `k`-win streak: split them evenly, keep the winners, split again. Every split is a hedged pair, so a guaranteed streak costs `(2^k − 1)·s·f`. That is also the expected cost of one streak at fair odds. `new` rejects any config where `streak_bonus` is at or above this bound. With the defaults (0.1 stake, 2%, target 7) the bound is `127 × 0.002 = 0.254` NEAR and the bonus is 0.2.
- **Known limit: withholding reveals.** Reveals happen in public during the reveal round. A large group of wallets on one side can watch the tally and leave some votes unopened to flip a thin margin. Each withheld vote forfeits its stake and bond, which raises the cost but does not rule it out.

## Known limits

- **The contract can still be upgraded by its owner.** The contract account keeps a full-access key during the hackathon so bugs can be fixed, which means the owner could replace the code. Through the contract's own methods the owner can only add questions and withdraw fees, never touch a player's balance. For real money the key would be deleted so the code can't change.
- **Three-minute rounds are for the demo.** A vote sealed in one round must be opened in the next, so with 3-minute rounds you need the tab open (it opens the vote for you) or to come back within that window. The app shows the exact times before and after you seal. The design is a daily round, where the window is a whole day.
- House players are run by the project (see above). They are disclosed in the app's Fair play section.
- Guest accounts are custodial testnet accounts (see "Guest accounts"). They would not exist in this form with real money.

- A missed reveal round forfeits that vote's stake and bond.
- Salts live in one browser's localStorage. A vote sealed on one device can't be opened from another, and clearing site data before the reveal loses it. The app warns about this after your first vote.
- A player can have at most 10 committed rounds waiting to be claimed (`TOO_MANY_PENDING`), and `claim` processes at most 10 rounds per call.
- The session key is limited to 2 NEAR of gas allowance. When that runs out, the app asks for one wallet approval to replace it.

## Guest accounts (play without a wallet)

Tapping an answer without a wallet makes a **guest account**, so a first-time player never sees a seed phrase, a wallet popup or a gas prompt.

- The browser generates an ed25519 key and sends only the **public** key to the guest service (`scripts/guest.ts`, the same always-on process as the house players).
- The service creates a throwaway testnet account `g-<random>.<funder>.testnet` with that key and 0.5 test NEAR. The browser then deposits and plays by itself; the service never sees a pick, a salt or the private key.
- The funder's own key is also added to each guest account, so unused test NEAR can be reclaimed. That makes a guest account **custodial and for testnet only**. To play from an account only you control, connect a wallet.
- Limits: 40 guest accounts a day in total and 3 a day per address (`GUEST_DAILY`, `GUEST_PER_IP`), and the service refuses when the funder runs low. When guests run out, the app falls back to "connect a wallet".
- A guest keeps 0.14 NEAR outside the game for gas, because gas is prepaid and refunded.
- The guest account lives in that browser's storage. Clearing site data loses it.

## Wallet and session key

The app generates an ed25519 key in the browser. On your first deposit, one wallet approval does two things: it adds that key to your account as a **function-call access key** scoped to this contract's `play, commit, reveal, claim, settle, withdraw`, and it deposits. Function-call keys can't attach NEAR, so deposits always go through the wallet. Everything else is signed in the browser with the session key, with no popups. `withdraw` can only pay the account that calls it. Wallet connection uses [NEAR Connect](https://github.com/hot-dao/near-selector) (`@hot-labs/near-connect`).

## Contract API

Change methods: `new(config, questions)`, `deposit()` (payable; the first deposit includes a one-time `storage_fee`), `withdraw(amount)`, `commit(round_id, hash)`, `reveal(round_id, choice, salt_hex)`, `settle(round_id)`, `claim()`, `play(reveal?, commit?)`, `add_questions(list)` (owner only), `withdraw_fees()` (owner only).

View methods: `get_config`, `get_current_round`, `get_round(id)`, `get_player(account_id)`, `get_entry(account_id, round_id)` (never returns the hash), `get_pot`, `get_totals`, `get_recent_rounds(limit)`.

`play` runs claim, then the optional reveal, then the optional commit, and reports each step's result instead of panicking, so a bad reveal never blocks the commit and a failed commit never undoes the claim. `commit` takes the `round_id` the hash was built for and fails with `WRONG_PHASE` if the transaction lands after the round has ended, so a late vote is rejected instead of being filed under the wrong round.

Error strings: `NOT_REGISTERED`, `LOW_BALANCE`, `LOW_DEPOSIT`, `ALREADY_COMMITTED`, `WRONG_PHASE`, `BAD_REVEAL`, `ALREADY_REVEALED`, `NOT_DUE`, `NOT_OWNER`, `BAD_HASH`, `TOO_MANY_PENDING`, `BAD_CONFIG`.

The contract keeps running totals (`get_totals`: player balances, locked stakes and bonds, pot, fees). No method loops over players, and settlement is O(1) from the tallies. A round's question index is fixed at its first commit, so `add_questions` never changes a round already in play.

## Run it

Needs Rust (the version is pinned in `contract/rust-toolchain.toml`), [`cargo-near`](https://github.com/near/cargo-near), Node 22+ and a funded **testnet** account.

```bash
# contract
npm install
npm run test:contract         # unit tests
npm run build:contract        # → contract/target/near/odd_one_in.wasm

# deploy to ooi.<your account> (creates it with 2.5 NEAR and calls new)
cp .env.example .env          # fill in NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY (testnet only)
npm run deploy                # ROUND_MINUTES=3 by default; --update redeploys code only

# seed players and play a round (also an integration test)
npm run seed -- setup --players 15
npm run seed -- loop --a 6 --b 8 --unrevealed 1   # commit → reveal → claim, then checks the payout math
npm run seed -- status

# house players and guest accounts (one always-on process)
npm run house -- fund 0.6     # top up their game balances from the owner account
npm run house                 # joins rounds people play; --now also plays the current round
# with GUEST_FUNDER (or GUEST_FUNDER_FILE) set, the same process serves POST /guest and GET /health on PORT

# web app
cd web
npm install
cp .env.example .env          # VITE_NETWORK, VITE_CONTRACT_ID, VITE_GUEST_API (the service above; empty = wallet only)
npm run dev                   # or: npm run build → static files in web/dist
```

Keys never go in the repo: `.env`, `.keys/` and `.contract-keys/` are git-ignored.

## Layout

```
contract/   Rust contract (near-sdk 5.30) and unit tests (src/tests.rs)
web/        Vite + React + TypeScript + Tailwind single-page app, no backend
scripts/    deploy.ts, seed.ts (integration test), house.ts (house players), guest.ts (guest accounts), questions.json
docs/       SPEC.md, the build spec with amendments
```

## Roadmap

- Open all votes at once with a TEE or a timelock, so there is no public reveal race (this closes the withholding limit).
- Stablecoin stakes.
- Cross-chain deposits.
- Private rooms on the shared daily question.

## Disclosure

Built for the NEAR Hackathon with Claude Code. Uses `near-sdk`, `near-api-js`, `@hot-labs/near-connect`, React, Vite and Tailwind. The same builder also entered **Assay**, a marketplace where AI agents compete for jobs on NEAR (https://github.com/emer-eth/assay). The two projects are independent: separate code, contracts and deployments.

## License

MIT
