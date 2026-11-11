use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const DUR: u64 = 60_000_000_000; // 60 s rounds
const T0: u64 = 1_700_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    format!("{s}.testnet").parse().unwrap()
}

fn set_ctx(who: &AccountId, ts: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("game.testnet".parse().unwrap())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(10_000));
    testing_env!(b.build());
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn salt(name: &str, round: u64) -> String {
    hex(&env::sha256(format!("salt:{name}:{round}").as_bytes()))
}

/// Test harness: tracks time and money deposited, and checks conservation.
struct H {
    c: OddOneIn,
    round: u64,
    deposited: u128,
    storage: u128,
}

fn cfg(fee_bps: u16, target: u32, bonus: u128, cap: u128, storage: u128) -> ConfigInput {
    ConfigInput {
        round_duration_ns: U64(DUR),
        stake: U128(NEAR),
        bond: U128(NEAR),
        fee_bps,
        streak_target: target,
        streak_bonus: U128(bonus),
        pot_cap: U128(cap),
        storage_fee: U128(storage),
    }
}

fn q() -> Vec<Question> {
    vec![
        Question { text: "Cats or dogs?".into(), a: "Cats".into(), b: "Dogs".into() },
        Question { text: "Tea or coffee?".into(), a: "Tea".into(), b: "Coffee".into() },
    ]
}

impl H {
    fn new(config: ConfigInput) -> H {
        let storage = config.storage_fee.0;
        set_ctx(&acc("owner"), T0, 0);
        H { c: OddOneIn::new(config, q()), round: 0, deposited: 0, storage }
    }
    /// Default config for most tests: 2% fee, streak target 7, bonus 1 NEAR (bound is 127 × 0.02 = 2.54).
    fn std() -> H {
        H::new(cfg(200, 7, NEAR, 1_000 * NEAR, 0))
    }
    fn at(&self, who: &str) {
        set_ctx(&acc(who), T0 + self.round * DUR + DUR / 2, 0);
    }
    fn goto(&mut self, round: u64) {
        self.round = round;
    }
    fn deposit(&mut self, who: &str, amount: u128) {
        set_ctx(&acc(who), T0 + self.round * DUR + DUR / 2, amount);
        self.c.deposit();
        self.deposited += amount;
    }
    fn commit(&mut self, who: &str, choice: Choice) -> Res<()> {
        self.at(who);
        let h = commit_hash(self.round, &acc(who), choice, &salt(who, self.round));
        self.c.do_commit(&acc(who), self.round, &hex(&h))
    }
    fn reveal(&mut self, who: &str, choice: Choice) -> Res<()> {
        self.at(who);
        let r = self.round - 1;
        self.c.do_reveal(&acc(who), r, choice, &salt(who, r))
    }
    fn claim(&mut self, who: &str) -> Vec<ClaimItem> {
        self.at(who);
        self.c.claim()
    }
    fn bal(&self, who: &str) -> u128 {
        self.c.get_player(acc(who)).map(|p| p.balance.0).unwrap_or(0)
    }
    fn player(&self, who: &str) -> PlayerView {
        self.c.get_player(acc(who)).unwrap()
    }
    /// Every yoctoNEAR deposited is in a balance, locked, the pot or fees (storage fees excluded).
    fn check_conservation(&self, players: usize) {
        let t = self.c.get_totals();
        assert_eq!(
            t.total_balances.0 + t.locked.0 + t.pot.0 + t.fees.0,
            self.deposited - self.storage * players as u128,
            "conservation"
        );
    }
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}{i}")).collect()
}

// 1. Worked example from the spec, with the conservation check.
#[test]
fn worked_example() {
    let mut h = H::std();
    let a = names("a", 6);
    let b = names("b", 8);
    let lazy = "lazy";
    for n in a.iter().chain(b.iter()).map(|s| s.as_str()).chain([lazy]) {
        h.deposit(n, 10 * NEAR);
    }
    for n in &a {
        h.commit(n, Choice::A).unwrap();
    }
    for n in b.iter().map(|s| s.as_str()).chain([lazy]) {
        h.commit(n, Choice::B).unwrap();
    }
    h.goto(1);
    for n in &a {
        h.reveal(n, Choice::A).unwrap();
    }
    for n in &b {
        h.reveal(n, Choice::B).unwrap();
    }
    h.goto(2);
    let mut paid = 0;
    for n in &a {
        let before = h.bal(n);
        let items = h.claim(n);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].result, ClaimResult::Win);
        assert_eq!(items[0].credited.0, 1_980 * MILLI);
        paid += h.bal(n) - before;
    }
    assert_eq!(paid, 11_880 * MILLI);
    for n in b.iter().map(|s| s.as_str()).chain([lazy]) {
        let before = h.bal(n);
        h.claim(n);
        assert_eq!(h.bal(n), before);
    }
    let t = h.c.get_totals();
    assert_eq!(t.fees.0, 120 * MILLI);
    assert_eq!(t.pot.0, 4 * NEAR);
    assert_eq!(t.locked.0, 0);
    // Money in: 15 stakes + 1 forfeited bond = 16. Out: 11.88 + 0.12 + 4 = 16.
    assert_eq!(paid + t.fees.0 + t.pot.0, 16 * NEAR);
    h.check_conservation(15);
}

fn void_round(a_count: usize, b_count: usize, unrevealed: usize) -> H {
    let mut h = H::std();
    let a = names("a", a_count);
    let b = names("b", b_count);
    let u = names("u", unrevealed);
    for n in a.iter().chain(&b).chain(&u) {
        h.deposit(n, 10 * NEAR);
    }
    for n in &a {
        h.commit(n, Choice::A).unwrap();
    }
    for n in b.iter().chain(&u) {
        h.commit(n, Choice::B).unwrap();
    }
    h.goto(1);
    for n in &a {
        h.reveal(n, Choice::A).unwrap();
    }
    for n in &b {
        h.reveal(n, Choice::B).unwrap();
    }
    h.goto(2);
    for n in a.iter().chain(&b) {
        let items = h.claim(n);
        assert_eq!(items[0].outcome, Outcome::Void);
        assert_eq!(items[0].result, ClaimResult::Void);
        assert_eq!(h.bal(n), 10 * NEAR, "void returns the stake, reveal returned the bond");
    }
    for n in &u {
        assert_eq!(h.claim(n)[0].result, ClaimResult::Forfeit);
    }
    assert_eq!(h.c.get_totals().pot.0, unrevealed as u128 * 2 * NEAR);
    assert_eq!(h.c.get_totals().fees.0, 0);
    assert_eq!(h.c.get_totals().locked.0, 0);
    h.check_conservation(a_count + b_count + unrevealed);
    h
}

// 2. VOID cases.
#[test]
fn void_on_tie() {
    void_round(3, 3, 1);
}

#[test]
fn void_when_all_on_one_side() {
    void_round(0, 4, 0);
}

#[test]
fn void_with_zero_reveals() {
    void_round(0, 0, 3);
}

// 3. Unrevealed commit forfeits stake and bond to the pot.
#[test]
fn unrevealed_forfeits_stake_and_bond() {
    let mut h = H::std();
    for n in ["x", "y", "z", "ghost"] {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("x", Choice::A).unwrap();
    h.commit("y", Choice::B).unwrap();
    h.commit("z", Choice::B).unwrap();
    h.commit("ghost", Choice::A).unwrap();
    h.goto(1);
    h.reveal("x", Choice::A).unwrap();
    h.reveal("y", Choice::B).unwrap();
    h.reveal("z", Choice::B).unwrap();
    h.goto(2);
    let items = h.claim("ghost");
    assert_eq!(items[0].result, ClaimResult::Forfeit);
    assert_eq!(h.bal("ghost"), 8 * NEAR);
    // Pot: (2 - 1) × 1 from the majority + 1 × (1 + 1) from the ghost.
    assert_eq!(h.c.get_totals().pot.0, 3 * NEAR);
    for n in ["x", "y", "z"] {
        h.claim(n);
    }
    h.check_conservation(4);
}

// 4. Bad reveals.
#[test]
fn reveal_rejections() {
    let mut h = H::std();
    h.deposit("alice", 10 * NEAR);
    h.deposit("bob", 10 * NEAR);
    h.commit("alice", Choice::A).unwrap();
    h.commit("bob", Choice::B).unwrap();
    // Wrong phase: still the commit round.
    h.at("alice");
    let s = salt("alice", 0);
    assert_eq!(h.c.do_reveal(&acc("alice"), 0, Choice::A, &s), Err(err::WRONG_PHASE));
    h.goto(1);
    h.at("alice");
    // Wrong salt.
    assert_eq!(h.c.do_reveal(&acc("alice"), 0, Choice::A, &salt("other", 0)), Err(err::BAD_REVEAL));
    // Wrong choice.
    assert_eq!(h.c.do_reveal(&acc("alice"), 0, Choice::B, &s), Err(err::BAD_REVEAL));
    // Wrong account: bob replays alice's choice and salt against his own commit.
    h.at("bob");
    assert_eq!(h.c.do_reveal(&acc("bob"), 0, Choice::A, &s), Err(err::BAD_REVEAL));
    // Correct, then twice.
    h.at("alice");
    assert_eq!(h.c.do_reveal(&acc("alice"), 0, Choice::A, &s), Ok(()));
    assert_eq!(h.c.do_reveal(&acc("alice"), 0, Choice::A, &s), Err(err::ALREADY_REVEALED));
    // Wrong phase: reveal window over.
    h.goto(2);
    h.at("bob");
    assert_eq!(h.c.do_reveal(&acc("bob"), 0, Choice::B, &salt("bob", 0)), Err(err::WRONG_PHASE));
}

// 5. A wallet on each side nets exactly minus the fee.
#[test]
fn hedged_pair_nets_minus_fee() {
    let mut h = H::std();
    for n in ["hedge_a", "hedge_b", "c", "d"] {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("hedge_a", Choice::A).unwrap();
    h.commit("hedge_b", Choice::B).unwrap();
    h.commit("c", Choice::B).unwrap();
    h.commit("d", Choice::B).unwrap();
    h.goto(1);
    h.reveal("hedge_a", Choice::A).unwrap();
    for n in ["hedge_b", "c", "d"] {
        h.reveal(n, Choice::B).unwrap();
    }
    h.goto(2);
    h.claim("hedge_a");
    h.claim("hedge_b");
    let net = (h.bal("hedge_a") + h.bal("hedge_b")) as i128 - (20 * NEAR) as i128;
    assert_eq!(net, -(20 * MILLI as i128), "minus 2% of one stake");
}

// 6. Streak bonus pays min(bonus, pot) and resets; init enforces the sybil bound.
#[test]
fn streak_bonus_pays_and_resets() {
    // Target 2: bound is (2^2 - 1) × 0.02 = 0.06 NEAR, so 0.05 is allowed.
    let mut h = H::new(cfg(200, 2, 50 * MILLI, 1_000 * NEAR, 0));
    for n in ["alice", "bob", "carol"] {
        h.deposit(n, 10 * NEAR);
    }
    let play_round = |h: &mut H| {
        h.commit("alice", Choice::A).unwrap();
        h.commit("bob", Choice::B).unwrap();
        h.commit("carol", Choice::B).unwrap();
    };
    play_round(&mut h); // round 0
    h.goto(1);
    for (n, c) in [("alice", Choice::A), ("bob", Choice::B), ("carol", Choice::B)] {
        h.reveal(n, c).unwrap();
    }
    play_round(&mut h); // round 1
    h.goto(2);
    for (n, c) in [("alice", Choice::A), ("bob", Choice::B), ("carol", Choice::B)] {
        h.reveal(n, c).unwrap();
    }
    h.goto(3);
    let items = h.claim("alice");
    assert_eq!(items.iter().map(|i| i.round_id).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(items[0].bonus.0, 0);
    assert_eq!(items[0].streak, 1);
    assert_eq!(items[1].bonus.0, 50 * MILLI);
    assert_eq!(items[1].streak, 0, "reset after the bonus");
    let p = h.player("alice");
    assert_eq!(p.streak, 0);
    assert_eq!(p.best_streak, 2);
    // Pot got 1 NEAR per round from the majority, minus the bonus.
    assert_eq!(h.c.get_totals().pot.0, 2 * NEAR - 50 * MILLI);
    h.claim("bob");
    h.claim("carol");
    assert_eq!(h.player("bob").streak, 0);
    h.check_conservation(3);
}

#[test]
fn streak_bonus_limited_by_pot() {
    // Pot capped at 0.01 NEAR, bonus 0.05: the payout is whatever the pot holds.
    let mut h = H::new(cfg(200, 2, 50 * MILLI, 10 * MILLI, 0));
    for n in ["alice", "bob", "carol"] {
        h.deposit(n, 10 * NEAR);
    }
    let mut p = h.c.players.get(&acc("alice")).unwrap().clone();
    p.streak = 1; // one win already
    h.c.players.insert(acc("alice"), p);
    h.commit("alice", Choice::A).unwrap();
    h.commit("bob", Choice::B).unwrap();
    h.commit("carol", Choice::B).unwrap();
    h.goto(1);
    h.reveal("alice", Choice::A).unwrap();
    h.reveal("bob", Choice::B).unwrap();
    h.reveal("carol", Choice::B).unwrap();
    h.goto(2);
    let items = h.claim("alice");
    assert_eq!(items[0].bonus.0, 10 * MILLI);
    assert_eq!(h.c.get_totals().pot.0, 0);
    h.claim("bob");
    h.claim("carol");
    h.check_conservation(3);
}

#[test]
#[should_panic(expected = "BAD_CONFIG")]
fn init_rejects_farmable_bonus() {
    H::new(cfg(200, 2, 60 * MILLI, 1_000 * NEAR, 0)); // exactly the bound: rejected
}

#[test]
fn default_config_is_within_bound() {
    // Spec defaults: stake 0.1, fee 2%, target 7, bonus 0.2. Bound = 127 × 0.002 = 0.254.
    set_ctx(&acc("owner"), T0, 0);
    let c = OddOneIn::new(
        ConfigInput {
            round_duration_ns: U64(DUR),
            stake: U128(100 * MILLI),
            bond: U128(100 * MILLI),
            fee_bps: 200,
            streak_target: 7,
            streak_bonus: U128(200 * MILLI),
            pot_cap: U128(2 * NEAR),
            storage_fee: U128(20 * MILLI),
        },
        q(),
    );
    assert_eq!(c.get_config().sybil_bound(), 254 * MILLI);
}

// 7. Claims run in order and pay once.
#[test]
fn claim_twice_pays_once() {
    let mut h = H::std();
    for n in ["alice", "bob", "carol"] {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("alice", Choice::A).unwrap();
    h.commit("bob", Choice::B).unwrap();
    h.commit("carol", Choice::B).unwrap();
    h.goto(1);
    h.reveal("alice", Choice::A).unwrap();
    h.reveal("bob", Choice::B).unwrap();
    h.reveal("carol", Choice::B).unwrap();
    // Not due yet: no-op, not an error.
    assert!(h.claim("alice").is_empty());
    h.goto(2);
    assert_eq!(h.claim("alice").len(), 1);
    let after = h.bal("alice");
    assert!(h.claim("alice").is_empty());
    assert_eq!(h.bal("alice"), after);
    h.at("anyone");
    assert_eq!(h.c.settle(0), Outcome::A, "settle stays idempotent after claims");
    assert_eq!(h.c.get_totals().pot.0, NEAR);
}

// 8. play: a failed reveal still commits; a failed commit keeps the claim.
#[test]
fn play_failed_reveal_still_commits() {
    let mut h = H::std();
    h.deposit("alice", 10 * NEAR);
    h.commit("alice", Choice::A).unwrap();
    h.goto(1);
    h.at("alice");
    let hash = hex(&commit_hash(1, &acc("alice"), Choice::B, &salt("alice", 1)));
    let res = h.c.play(
        Some(RevealArgs { round_id: 0, choice: Choice::A, salt_hex: "00".repeat(32) }),
        Some(CommitArgs { round_id: 1, hash }),
    );
    assert_eq!(res.reveal.as_ref().unwrap().error.as_deref(), Some(err::BAD_REVEAL));
    assert!(res.commit.as_ref().unwrap().ok);
    assert!(h.c.get_entry(acc("alice"), 1).committed);
}

#[test]
fn play_failed_commit_keeps_claim() {
    let mut h = H::std();
    for n in ["alice", "bob", "carol"] {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("alice", Choice::A).unwrap();
    h.commit("bob", Choice::B).unwrap();
    h.commit("carol", Choice::B).unwrap();
    h.goto(1);
    h.reveal("alice", Choice::A).unwrap();
    h.reveal("bob", Choice::B).unwrap();
    h.reveal("carol", Choice::B).unwrap();
    h.goto(2);
    h.at("alice");
    let res = h.c.play(None, Some(CommitArgs { round_id: 1, hash: "ab".repeat(32) }));
    assert_eq!(res.claimed.len(), 1);
    assert_eq!(res.commit.as_ref().unwrap().error.as_deref(), Some(err::WRONG_PHASE));
    assert_eq!(h.bal("alice"), 10 * NEAR + 980 * MILLI);
}

// 9. A commit that lands after the round boundary is rejected, not misfiled.
#[test]
fn late_commit_is_wrong_phase() {
    let mut h = H::std();
    h.deposit("alice", 10 * NEAR);
    h.goto(1);
    h.at("alice");
    let stale = hex(&commit_hash(0, &acc("alice"), Choice::A, &salt("alice", 0)));
    assert_eq!(h.c.do_commit(&acc("alice"), 0, &stale), Err(err::WRONG_PHASE));
    assert_eq!(h.bal("alice"), 10 * NEAR);
    assert!(!h.c.get_entry(acc("alice"), 1).committed);
}

// 10. Pot overflow goes to fees.
#[test]
fn pot_overflow_goes_to_fees() {
    let mut h = H::new(cfg(200, 7, NEAR, NEAR, 0)); // cap 1 NEAR
    let b = names("b", 4);
    h.deposit("alice", 10 * NEAR);
    for n in &b {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("alice", Choice::A).unwrap();
    for n in &b {
        h.commit(n, Choice::B).unwrap();
    }
    h.goto(1);
    h.reveal("alice", Choice::A).unwrap();
    for n in &b {
        h.reveal(n, Choice::B).unwrap();
    }
    h.goto(2);
    h.claim("alice");
    let t = h.c.get_totals();
    assert_eq!(t.pot.0, NEAR);
    // 3 NEAR surplus: 1 to the pot, 2 overflow, plus 0.02 fee.
    assert_eq!(t.fees.0, 2 * NEAR + 20 * MILLI);
    for n in &b {
        h.claim(n);
    }
    h.check_conservation(5);
}

// Extra checks.
#[test]
fn commit_rejections() {
    let mut h = H::new(cfg(200, 7, NEAR, 1_000 * NEAR, 0));
    h.at("nobody");
    let any = "ab".repeat(32);
    assert_eq!(h.c.do_commit(&acc("nobody"), 0, &any), Err(err::NOT_REGISTERED));
    h.deposit("alice", 2 * NEAR);
    h.at("alice");
    assert_eq!(h.c.do_commit(&acc("alice"), 0, "XYZ"), Err(err::BAD_HASH));
    assert_eq!(h.c.do_commit(&acc("alice"), 0, &"AB".repeat(32)), Err(err::BAD_HASH));
    assert_eq!(h.c.do_commit(&acc("alice"), 0, &any), Ok(()));
    assert_eq!(h.c.do_commit(&acc("alice"), 0, &any), Err(err::ALREADY_COMMITTED));
    h.goto(1);
    h.at("alice");
    assert_eq!(h.c.do_commit(&acc("alice"), 1, &any), Err(err::LOW_BALANCE));
}

#[test]
fn pending_is_capped() {
    let mut h = H::std();
    h.deposit("alice", 100 * NEAR);
    for r in 0..MAX_PENDING as u64 {
        h.goto(r);
        h.commit("alice", Choice::A).unwrap();
        // Skip claims on purpose: alice never visits on a claimable round via play.
    }
    h.goto(MAX_PENDING as u64);
    assert_eq!(h.commit("alice", Choice::A), Err(err::TOO_MANY_PENDING));
    // Claiming frees slots.
    let n = h.claim("alice").len();
    assert_eq!(n, MAX_PENDING - 1);
    assert_eq!(h.commit("alice", Choice::A), Ok(()));
}

#[test]
fn storage_fee_and_withdraw() {
    let mut h = H::new(cfg(200, 7, NEAR, 1_000 * NEAR, 20 * MILLI));
    set_ctx(&acc("alice"), T0 + 1, 2 * NEAR + 20 * MILLI);
    h.c.deposit();
    h.deposited += 2 * NEAR + 20 * MILLI;
    assert_eq!(h.bal("alice"), 2 * NEAR, "storage fee taken once");
    h.deposit("alice", 2 * NEAR);
    assert_eq!(h.bal("alice"), 4 * NEAR);
    h.at("alice");
    let _ = h.c.withdraw(U128(NEAR));
    h.deposited -= NEAR;
    assert_eq!(h.bal("alice"), 3 * NEAR);
    h.check_conservation(1);
}

#[test]
#[should_panic(expected = "LOW_DEPOSIT")]
fn first_deposit_must_cover_storage() {
    let mut h = H::new(cfg(200, 7, NEAR, 1_000 * NEAR, 20 * MILLI));
    h.deposit("alice", 2 * NEAR); // stake + bond but no storage fee
}

#[test]
#[should_panic(expected = "LOW_BALANCE")]
fn cannot_withdraw_more_than_balance() {
    let mut h = H::std();
    h.deposit("alice", 2 * NEAR);
    h.at("alice");
    let _ = h.c.withdraw(U128(3 * NEAR));
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn only_owner_adds_questions() {
    let h = H::std();
    let mut h = h;
    h.at("mallory");
    h.c.add_questions(q());
}

#[test]
fn question_is_fixed_at_first_commit() {
    let mut h = H::std();
    h.deposit("alice", 10 * NEAR);
    h.goto(1);
    h.commit("alice", Choice::A).unwrap(); // round 1 → index 1 of 2: "Tea or coffee?"
    h.at("owner");
    h.c.add_questions(vec![Question { text: "Sun or moon?".into(), a: "Sun".into(), b: "Moon".into() }]);
    h.at("alice");
    assert_eq!(h.c.get_current_round().question.text, "Tea or coffee?");
}

#[test]
fn views_hide_current_tally_and_list_history() {
    let mut h = H::std();
    for n in ["alice", "bob", "carol"] {
        h.deposit(n, 10 * NEAR);
    }
    h.commit("alice", Choice::A).unwrap();
    h.commit("bob", Choice::B).unwrap();
    h.commit("carol", Choice::B).unwrap();
    h.at("viewer");
    let r = h.c.get_round(0);
    assert_eq!(r.phase, Phase::Commit);
    assert_eq!((r.revealed_a, r.revealed_b, r.commits), (0, 0, 3));
    assert_eq!(h.c.get_current_round().commits, 3);
    h.goto(1);
    h.reveal("alice", Choice::A).unwrap();
    h.reveal("bob", Choice::B).unwrap();
    h.reveal("carol", Choice::B).unwrap();
    h.goto(2);
    h.at("viewer");
    let r = h.c.get_round(0);
    assert_eq!(r.phase, Phase::Settled);
    assert_eq!(r.outcome, Some(Outcome::A));
    assert!(!r.settled, "outcome computed before anyone settles");
    let recent = h.c.get_recent_rounds(5);
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].id, 0);
}
