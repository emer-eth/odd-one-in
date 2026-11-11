//! Odd One In: a daily minority game on NEAR.
//!
//! Every round has one question with two answers. Players stake a fixed amount and commit to a side
//! in secret (a salted hash). In the next round they reveal. Once the reveal round is over, the side
//! with fewer reveals wins.
//!
//! Payouts are symmetric: each winner gains exactly one stake (minus the fee) and each loser loses
//! exactly one stake, so a wallet on each side nets minus the fee. What the larger losing side
//! contributes beyond the winners' gains, plus forfeited stakes and bonds from votes never opened,
//! goes to a capped streak pot. A player who wins `streak_target` rounds in a row gets a fixed
//! `streak_bonus` from the pot. The bonus is required to be smaller than the cost of guaranteeing a
//! streak with hedged wallets, `(2^streak_target - 1) * fee_per_stake`, so it cannot be farmed.
//!
//! Rounds are derived from the block clock. Nothing runs on a timer: rounds settle lazily inside the
//! first call that needs them. No method loops over players.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

/// Most rounds a player can have committed but not yet claimed.
pub const MAX_PENDING: usize = 10;
/// Most rounds processed in one `claim`.
pub const MAX_CLAIM_PER_CALL: usize = 10;
/// Upper bound on `fee_bps` (10%).
pub const MAX_FEE_BPS: u16 = 1000;

pub mod err {
    pub const NOT_REGISTERED: &str = "NOT_REGISTERED";
    pub const LOW_BALANCE: &str = "LOW_BALANCE";
    pub const LOW_DEPOSIT: &str = "LOW_DEPOSIT";
    pub const ALREADY_COMMITTED: &str = "ALREADY_COMMITTED";
    pub const WRONG_PHASE: &str = "WRONG_PHASE";
    pub const BAD_REVEAL: &str = "BAD_REVEAL";
    pub const ALREADY_REVEALED: &str = "ALREADY_REVEALED";
    pub const NOT_DUE: &str = "NOT_DUE";
    pub const NOT_OWNER: &str = "NOT_OWNER";
    pub const BAD_HASH: &str = "BAD_HASH";
    pub const TOO_MANY_PENDING: &str = "TOO_MANY_PENDING";
    pub const BAD_CONFIG: &str = "BAD_CONFIG";
}

type Res<T> = Result<T, &'static str>;

fn fail(e: &str) -> ! {
    env::panic_str(e)
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    A,
    B,
}

impl Choice {
    fn as_str(&self) -> &'static str {
        match self {
            Choice::A => "A",
            Choice::B => "B",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    A,
    B,
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub text: String,
    pub a: String,
    pub b: String,
}

/// Config passed to `new`. Amounts are yoctoNEAR strings.
#[near(serializers = [json])]
pub struct ConfigInput {
    pub round_duration_ns: U64,
    pub stake: U128,
    pub bond: U128,
    pub fee_bps: u16,
    pub streak_target: u32,
    pub streak_bonus: U128,
    pub pot_cap: U128,
    pub storage_fee: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub genesis_ts: U64,
    pub round_duration_ns: U64,
    pub stake: U128,
    pub bond: U128,
    pub fee_bps: u16,
    pub streak_target: u32,
    pub streak_bonus: U128,
    pub pot_cap: U128,
    pub storage_fee: U128,
}

impl Config {
    /// Fee taken from each winner's gain, rounded down.
    fn fee_per_winner(&self) -> u128 {
        self.stake.0 * self.fee_bps as u128 / 10_000
    }
    /// Cost of guaranteeing one streak with a tree of hedged wallets. The bonus must stay below it.
    pub fn sybil_bound(&self) -> u128 {
        ((1u128 << self.streak_target) - 1) * self.fee_per_winner()
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Round {
    pub commits: u32,
    pub revealed_a: u32,
    pub revealed_b: u32,
    pub settled: bool,
    pub outcome: Option<Outcome>,
    /// Question index, fixed on the round's first commit.
    pub question: Option<u32>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Entry {
    pub hash: [u8; 32],
    pub revealed: Option<Choice>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Player {
    pub balance: u128,
    pub streak: u32,
    pub best_streak: u32,
    /// Rounds committed and not yet claimed.
    pub pending: Vec<u64>,
}

// ---------- JSON views and results ----------

#[near(serializers = [json])]
pub struct PlayerView {
    pub balance: U128,
    pub streak: u32,
    pub best_streak: u32,
    pub pending: Vec<u64>,
}

#[near(serializers = [json])]
pub struct EntryView {
    pub committed: bool,
    pub revealed: Option<Choice>,
}

#[near(serializers = [json])]
pub struct CurrentRound {
    pub id: u64,
    pub commit_ends_at: U64,
    pub question: Question,
    pub commits: u32,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub enum Phase {
    Future,
    Commit,
    Reveal,
    Settled,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub id: u64,
    pub phase: Phase,
    pub question: Question,
    pub commits: u32,
    /// Revealed counts. Zero during the commit phase, so the current round never shows who is ahead.
    pub revealed_a: u32,
    pub revealed_b: u32,
    /// Final once the phase is Settled (computed from the tallies even before `settle` is called).
    pub outcome: Option<Outcome>,
    pub settled: bool,
    pub starts_at: U64,
}

#[near(serializers = [json])]
pub struct Totals {
    pub total_balances: U128,
    pub locked: U128,
    pub pot: U128,
    pub fees: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClaimResult {
    Win,
    Lose,
    Void,
    Forfeit,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClaimItem {
    pub round_id: u64,
    pub outcome: Outcome,
    pub choice: Option<Choice>,
    pub result: ClaimResult,
    /// Credited to balance for this round, excluding the bonus.
    pub credited: U128,
    pub bonus: U128,
    pub streak: u32,
}

#[near(serializers = [json])]
pub struct RevealArgs {
    pub round_id: u64,
    pub choice: Choice,
    pub salt_hex: String,
}

#[near(serializers = [json])]
pub struct CommitArgs {
    pub round_id: u64,
    pub hash: String,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct StepResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl From<Res<()>> for StepResult {
    fn from(r: Res<()>) -> Self {
        match r {
            Ok(()) => StepResult { ok: true, error: None },
            Err(e) => StepResult { ok: false, error: Some(e.to_string()) },
        }
    }
}

#[near(serializers = [json])]
pub struct PlayResult {
    pub claimed: Vec<ClaimItem>,
    pub reveal: Option<StepResult>,
    pub commit: Option<StepResult>,
}

// ---------- helpers ----------

fn decode_hash(hex: &str) -> Res<[u8; 32]> {
    let b = hex.as_bytes();
    if b.len() != 64 {
        return Err(err::BAD_HASH);
    }
    let nib = |c: u8| -> Res<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            _ => Err(err::BAD_HASH),
        }
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = nib(b[2 * i])? << 4 | nib(b[2 * i + 1])?;
    }
    Ok(out)
}

/// sha256(utf8("{round_id}:{account_id}:{choice}:{salt_hex}"))
pub fn commit_hash(round_id: u64, account: &AccountId, choice: Choice, salt_hex: &str) -> [u8; 32] {
    let pre = format!("{}:{}:{}:{}", round_id, account, choice.as_str(), salt_hex);
    env::sha256_array(pre.as_bytes())
}

fn outcome_of(a: u32, b: u32) -> Outcome {
    if a == b || a == 0 || b == 0 {
        Outcome::Void
    } else if a < b {
        Outcome::A
    } else {
        Outcome::B
    }
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OddOneIn {
    config: Config,
    questions: Vector<Question>,
    rounds: LookupMap<u64, Round>,
    entries: LookupMap<(AccountId, u64), Entry>,
    players: LookupMap<AccountId, Player>,
    pot: u128,
    fees: u128,
    /// Sum of all player balances.
    total_balances: u128,
    /// Stakes and bonds held for open rounds and for settled rounds not yet claimed.
    locked: u128,
}

#[near]
impl OddOneIn {
    #[init]
    pub fn new(config: ConfigInput, questions: Vec<Question>) -> Self {
        let config = Config {
            owner: env::predecessor_account_id(),
            genesis_ts: U64(env::block_timestamp()),
            round_duration_ns: config.round_duration_ns,
            stake: config.stake,
            bond: config.bond,
            fee_bps: config.fee_bps,
            streak_target: config.streak_target,
            streak_bonus: config.streak_bonus,
            pot_cap: config.pot_cap,
            storage_fee: config.storage_fee,
        };
        let ok = !questions.is_empty()
            && config.round_duration_ns.0 > 0
            && config.stake.0 > 0
            && config.fee_bps <= MAX_FEE_BPS
            && (2..=30).contains(&config.streak_target)
            && (config.streak_bonus.0 == 0 || config.streak_bonus.0 < config.sybil_bound());
        if !ok {
            fail(err::BAD_CONFIG);
        }
        let mut q = Vector::new(b"q");
        for item in questions {
            q.push(item);
        }
        Self {
            config,
            questions: q,
            rounds: LookupMap::new(b"r"),
            entries: LookupMap::new(b"e"),
            players: LookupMap::new(b"p"),
            pot: 0,
            fees: 0,
            total_balances: 0,
            locked: 0,
        }
    }

    // ----- money in and out -----

    /// Credits the attached NEAR to the caller's balance. A new player pays `storage_fee` once.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let min = self.config.stake.0 + self.config.bond.0;
        let mut p = match self.players.get(&who) {
            Some(p) => {
                if amount < min {
                    fail(err::LOW_DEPOSIT);
                }
                p.clone()
            }
            None => {
                if amount < min + self.config.storage_fee.0 {
                    fail(err::LOW_DEPOSIT);
                }
                Player { balance: 0, streak: 0, best_streak: 0, pending: vec![] }
            }
        };
        let is_new = !self.players.contains_key(&who);
        let credit = if is_new { amount - self.config.storage_fee.0 } else { amount };
        p.balance += credit;
        self.total_balances += credit;
        self.players.insert(who, p.clone());
        U128(p.balance)
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let mut p = self.players.get(&who).cloned().unwrap_or_else(|| fail(err::NOT_REGISTERED));
        if amount.0 == 0 || p.balance < amount.0 {
            fail(err::LOW_BALANCE);
        }
        p.balance -= amount.0;
        self.total_balances -= amount.0;
        self.players.insert(who.clone(), p);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ----- game -----

    pub fn commit(&mut self, round_id: u64, hash: String) {
        let who = env::predecessor_account_id();
        self.do_commit(&who, round_id, &hash).unwrap_or_else(|e| fail(e));
    }

    pub fn reveal(&mut self, round_id: u64, choice: Choice, salt_hex: String) {
        let who = env::predecessor_account_id();
        self.do_reveal(&who, round_id, choice, &salt_hex).unwrap_or_else(|e| fail(e));
    }

    /// Settles a round whose reveal phase is over. Anyone can call it. Idempotent.
    pub fn settle(&mut self, round_id: u64) -> Outcome {
        self.settle_round(round_id).unwrap_or_else(|e| fail(e))
    }

    /// Pays out the caller's due rounds in ascending order, up to 10 per call. Nothing due is a no-op.
    pub fn claim(&mut self) -> Vec<ClaimItem> {
        let who = env::predecessor_account_id();
        self.do_claim(&who)
    }

    /// The daily visit in one call: claim, then the optional reveal, then the optional commit.
    /// A failed reveal or commit is reported, never panics, so it can't undo the other steps.
    pub fn play(&mut self, reveal: Option<RevealArgs>, commit: Option<CommitArgs>) -> PlayResult {
        let who = env::predecessor_account_id();
        let claimed = self.do_claim(&who);
        let reveal = reveal.map(|r| self.do_reveal(&who, r.round_id, r.choice, &r.salt_hex).into());
        let commit = commit.map(|c| self.do_commit(&who, c.round_id, &c.hash).into());
        PlayResult { claimed, reveal, commit }
    }

    // ----- owner -----

    pub fn add_questions(&mut self, list: Vec<Question>) {
        self.assert_owner();
        for q in list {
            self.questions.push(q);
        }
    }

    pub fn withdraw_fees(&mut self) -> Promise {
        self.assert_owner();
        let amount = self.fees;
        if amount == 0 {
            fail(err::LOW_BALANCE);
        }
        self.fees = 0;
        Promise::new(self.config.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ----- views -----

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_current_round(&self) -> CurrentRound {
        let id = self.current_round();
        let commits = self.rounds.get(&id).map(|r| r.commits).unwrap_or(0);
        CurrentRound {
            id,
            commit_ends_at: U64(self.round_start(id + 1)),
            question: self.question_for(id),
            commits,
        }
    }

    pub fn get_round(&self, id: u64) -> RoundView {
        let cur = self.current_round();
        let r = self.rounds.get(&id).cloned().unwrap_or_default();
        let phase = if id > cur {
            Phase::Future
        } else if id == cur {
            Phase::Commit
        } else if id + 1 == cur {
            Phase::Reveal
        } else {
            Phase::Settled
        };
        let outcome = if phase == Phase::Settled {
            Some(r.outcome.unwrap_or_else(|| outcome_of(r.revealed_a, r.revealed_b)))
        } else {
            None
        };
        RoundView {
            id,
            phase,
            question: self.question_for(id),
            commits: r.commits,
            revealed_a: r.revealed_a,
            revealed_b: r.revealed_b,
            outcome,
            settled: r.settled,
            starts_at: U64(self.round_start(id)),
        }
    }

    pub fn get_player(&self, account_id: AccountId) -> Option<PlayerView> {
        self.players.get(&account_id).map(|p| PlayerView {
            balance: U128(p.balance),
            streak: p.streak,
            best_streak: p.best_streak,
            pending: p.pending.clone(),
        })
    }

    /// Whether the account committed to a round and what it revealed. Never returns the hash.
    pub fn get_entry(&self, account_id: AccountId, round_id: u64) -> EntryView {
        match self.entries.get(&(account_id, round_id)) {
            Some(e) => EntryView { committed: true, revealed: e.revealed },
            None => EntryView { committed: false, revealed: None },
        }
    }

    pub fn get_pot(&self) -> U128 {
        U128(self.pot)
    }

    pub fn get_totals(&self) -> Totals {
        Totals {
            total_balances: U128(self.total_balances),
            locked: U128(self.locked),
            pot: U128(self.pot),
            fees: U128(self.fees),
        }
    }

    /// Latest settled-phase rounds that had at least one commit, newest first. Scans at most 200 rounds.
    pub fn get_recent_rounds(&self, limit: u32) -> Vec<RoundView> {
        let limit = limit.min(20) as usize;
        let cur = self.current_round();
        let mut out = vec![];
        if cur < 2 {
            return out;
        }
        let mut id = cur - 2;
        let mut scanned = 0;
        loop {
            if self.rounds.get(&id).map(|r| r.commits > 0).unwrap_or(false) {
                out.push(self.get_round(id));
                if out.len() >= limit {
                    break;
                }
            }
            scanned += 1;
            if id == 0 || scanned >= 200 {
                break;
            }
            id -= 1;
        }
        out
    }
}

impl OddOneIn {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.config.owner {
            fail(err::NOT_OWNER);
        }
    }

    fn current_round(&self) -> u64 {
        (env::block_timestamp() - self.config.genesis_ts.0) / self.config.round_duration_ns.0
    }

    fn round_start(&self, id: u64) -> u64 {
        self.config.genesis_ts.0 + id * self.config.round_duration_ns.0
    }

    fn question_for(&self, id: u64) -> Question {
        let len = self.questions.len();
        let idx = self
            .rounds
            .get(&id)
            .and_then(|r| r.question)
            .unwrap_or((id % len as u64) as u32);
        self.questions[idx.min(len - 1)].clone()
    }

    fn add_to_pot(&mut self, amount: u128) {
        self.pot += amount;
        let cap = self.config.pot_cap.0;
        if self.pot > cap {
            self.fees += self.pot - cap;
            self.pot = cap;
        }
    }

    /// Validates everything first, then mutates, so an Err leaves state untouched.
    fn do_commit(&mut self, who: &AccountId, round_id: u64, hash_hex: &str) -> Res<()> {
        let cur = self.current_round();
        if round_id != cur {
            return Err(err::WRONG_PHASE);
        }
        let hash = decode_hash(hash_hex)?;
        let mut p = self.players.get(who).cloned().ok_or(err::NOT_REGISTERED)?;
        let key = (who.clone(), round_id);
        if self.entries.contains_key(&key) {
            return Err(err::ALREADY_COMMITTED);
        }
        if p.pending.len() >= MAX_PENDING {
            return Err(err::TOO_MANY_PENDING);
        }
        let cost = self.config.stake.0 + self.config.bond.0;
        if p.balance < cost {
            return Err(err::LOW_BALANCE);
        }
        p.balance -= cost;
        p.pending.push(round_id);
        self.total_balances -= cost;
        self.locked += cost;
        let mut r = self.rounds.get(&round_id).cloned().unwrap_or_default();
        if r.question.is_none() {
            r.question = Some((round_id % self.questions.len() as u64) as u32);
        }
        r.commits += 1;
        self.rounds.insert(round_id, r);
        self.entries.insert(key, Entry { hash, revealed: None });
        self.players.insert(who.clone(), p);
        Ok(())
    }

    fn do_reveal(&mut self, who: &AccountId, round_id: u64, choice: Choice, salt_hex: &str) -> Res<()> {
        let cur = self.current_round();
        if cur == 0 || round_id + 1 != cur {
            return Err(err::WRONG_PHASE);
        }
        let key = (who.clone(), round_id);
        let mut e = self.entries.get(&key).cloned().ok_or(err::BAD_REVEAL)?;
        if e.revealed.is_some() {
            return Err(err::ALREADY_REVEALED);
        }
        if commit_hash(round_id, who, choice, salt_hex) != e.hash {
            return Err(err::BAD_REVEAL);
        }
        let bond = self.config.bond.0;
        let mut p = self.players.get(who).cloned().ok_or(err::NOT_REGISTERED)?;
        p.balance += bond;
        self.total_balances += bond;
        self.locked -= bond;
        self.players.insert(who.clone(), p);
        e.revealed = Some(choice);
        self.entries.insert(key, e);
        let mut r = self.rounds.get(&round_id).cloned().unwrap_or_default();
        match choice {
            Choice::A => r.revealed_a += 1,
            Choice::B => r.revealed_b += 1,
        }
        self.rounds.insert(round_id, r);
        Ok(())
    }

    /// O(1) from the tallies. Moves what losers and non-revealers left behind into the pot and fees;
    /// what stays in `locked` is exactly what the claims of this round will pay out.
    fn settle_round(&mut self, round_id: u64) -> Res<Outcome> {
        if round_id + 2 > self.current_round() {
            return Err(err::NOT_DUE);
        }
        let mut r = match self.rounds.get(&round_id) {
            Some(r) => r.clone(),
            None => return Ok(Outcome::Void), // nobody played: nothing to store
        };
        if r.settled {
            return Ok(r.outcome.unwrap_or(Outcome::Void));
        }
        let s = self.config.stake.0;
        let bond = self.config.bond.0;
        let (a, b) = (r.revealed_a, r.revealed_b);
        let u = (r.commits - a - b) as u128;
        let outcome = outcome_of(a, b);
        let to_pot = match outcome {
            Outcome::Void => u * (s + bond),
            _ => {
                let (m, big) = (a.min(b) as u128, a.max(b) as u128);
                let fee_total = m * self.config.fee_per_winner();
                self.fees += fee_total;
                self.locked -= fee_total;
                (big - m) * s + u * (s + bond)
            }
        };
        self.locked -= to_pot;
        self.add_to_pot(to_pot);
        r.settled = true;
        r.outcome = Some(outcome);
        self.rounds.insert(round_id, r);
        Ok(outcome)
    }

    fn do_claim(&mut self, who: &AccountId) -> Vec<ClaimItem> {
        let mut p = match self.players.get(who) {
            Some(p) => p.clone(),
            None => return vec![],
        };
        let cur = self.current_round();
        let mut pending = p.pending.clone();
        pending.sort_unstable();
        let (due, rest): (Vec<u64>, Vec<u64>) = pending.into_iter().partition(|r| r + 2 <= cur);
        let (now, later) = due.split_at(due.len().min(MAX_CLAIM_PER_CALL));
        if now.is_empty() {
            return vec![];
        }
        let s = self.config.stake.0;
        let fee = self.config.fee_per_winner();
        let mut items = vec![];
        for &round_id in now {
            let outcome = self.settle_round(round_id).expect("due");
            let entry = match self.entries.remove(&(who.clone(), round_id)) {
                Some(e) => e,
                None => continue,
            };
            let (result, credited) = match (entry.revealed, outcome) {
                (None, _) => (ClaimResult::Forfeit, 0),
                (Some(_), Outcome::Void) => (ClaimResult::Void, s),
                (Some(Choice::A), Outcome::A) | (Some(Choice::B), Outcome::B) => (ClaimResult::Win, 2 * s - fee),
                (Some(_), _) => (ClaimResult::Lose, 0),
            };
            let mut bonus = 0;
            match result {
                ClaimResult::Win => {
                    p.streak += 1;
                    p.best_streak = p.best_streak.max(p.streak);
                    if p.streak >= self.config.streak_target {
                        bonus = self.config.streak_bonus.0.min(self.pot);
                        self.pot -= bonus;
                        p.streak = 0;
                    }
                }
                ClaimResult::Lose | ClaimResult::Forfeit => p.streak = 0,
                ClaimResult::Void => {}
            }
            self.locked -= credited;
            p.balance += credited + bonus;
            self.total_balances += credited + bonus;
            items.push(ClaimItem {
                round_id,
                outcome,
                choice: entry.revealed,
                result,
                credited: U128(credited),
                bonus: U128(bonus),
                streak: p.streak,
            });
        }
        p.pending = later.iter().copied().chain(rest).collect();
        self.players.insert(who.clone(), p);
        items
    }
}

#[cfg(test)]
mod tests;
