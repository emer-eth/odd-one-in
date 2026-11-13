// The regulars: the house players, each with a public habit.
//
// This file has no imports on purpose. The house process (scripts/house.ts) uses it to pick sides, the web
// app uses it to explain them, and the judge script (scripts/judge.ts) uses it to recompute every lean from
// chain data alone. A habit only ever reads public, finished history, so anyone can work out which way a
// regular is leaning before the round closes. What nobody can work out is whether this is one of the rounds
// where they break habit.

export type Side = "A" | "B";
export type Result = "A" | "B" | "Void";

/** How often a regular keeps to their habit. The rest of the time they take the other side. */
export const FOLLOW = 0.8;
/** Regulars at the table in a round a person plays. A fifth joins a round nobody else is in, so it can't tie. */
export const TABLE_SIZE = 4;

export type Regular = {
  /** Position in the house key list: regular `i` plays from house account `i`. */
  index: number;
  id: string;
  name: string;
  /** Two or three words for the habit. */
  habit: string;
  /** The habit as one sentence. */
  rule: string;
};

export const REGULARS: Regular[] = [
  { index: 0, id: "mabel", name: "Mabel", habit: "Creature of habit", rule: "Always takes the orange side." },
  { index: 1, id: "otis", name: "Otis", habit: "Copycat", rule: "Takes the side that won the last round." },
  { index: 2, id: "bea", name: "Bea", habit: "Follows the herd", rule: "Goes where the bigger crowd went last round." },
  { index: 3, id: "zig", name: "Zig", habit: "Switcher", rule: "Switches sides every round they play." },
  { index: 4, id: "rex", name: "Rex", habit: "Sore loser", rule: "Stays put after a win, switches after a loss." },
  { index: 5, id: "tess", name: "Tess", habit: "Short and sweet", rule: "Takes the shorter answer." },
  { index: 6, id: "penny", name: "Penny", habit: "Coin flipper", rule: "Flips a coin. There is no habit to read." },
  { index: 7, id: "sage", name: "Sage", habit: "Reads the table", rule: "Works out where the others lean and takes the emptier side." },
];

export const other = (s: Side): Side => (s === "A" ? "B" : "A");
export const sideWord = (s: Side) => (s === "A" ? "orange" : "violet");

/** Everything a habit may look at. All of it is public and final before the round opens for picks. */
export type Ctx = {
  /** This round's two answers. */
  question: { a: string; b: string };
  /** The winning (smaller) side of the latest finished round that had a winner, if any. */
  lastWinner: Side | null;
  /** This regular's own pick in the latest finished round they played, and how that round ended. */
  own: { pick: Side; result: Result } | null;
  /** The leans of the other regulars at the table (those that have one). Only Sage reads this. */
  others: Side[];
};

/** The side the habit points to, or null when there is no habit to read (Penny). */
export function lean(id: string, c: Ctx): Side | null {
  switch (id) {
    case "mabel":
      return "A";
    case "otis":
      return c.lastWinner ?? "A";
    case "bea":
      return c.lastWinner ? other(c.lastWinner) : "B";
    case "zig":
      return c.own ? other(c.own.pick) : "B";
    case "rex":
      if (!c.own) return "A";
      return c.own.result === "Void" || c.own.result === c.own.pick ? c.own.pick : other(c.own.pick);
    case "tess":
      return c.question.b.trim().length < c.question.a.trim().length ? "B" : "A";
    case "sage": {
      const a = c.others.filter((s) => s === "A").length;
      const b = c.others.length - a;
      return a === b ? "A" : a < b ? "A" : "B";
    }
    default:
      return null;
  }
}

/** Why the habit points that way this round, in plain words. */
export function reason(id: string, c: Ctx): string {
  const l = lean(id, c);
  switch (id) {
    case "mabel":
      return "Orange, every time.";
    case "otis":
      return c.lastWinner ? `${cap(sideWord(c.lastWinner))} won the last round, so that's the one to copy.` : "No winner to copy yet, so orange.";
    case "bea":
      return c.lastWinner ? `The bigger crowd was on ${sideWord(other(c.lastWinner))} last round.` : "No crowd to follow yet, so violet.";
    case "zig":
      return c.own ? `Took ${sideWord(c.own.pick)} last time, so it's ${sideWord(other(c.own.pick))}'s turn.` : "First round at the table: starts on violet.";
    case "rex":
      if (!c.own) return "First round at the table: starts on orange.";
      if (c.own.result === "Void") return `Last round was void, so staying on ${sideWord(c.own.pick)}.`;
      return c.own.result === c.own.pick ? `Won on ${sideWord(c.own.pick)} last time, so staying.` : `Lost on ${sideWord(c.own.pick)} last time, so switching.`;
    case "tess":
      return c.question.a.trim().length === c.question.b.trim().length ? "Both answers are the same length, so orange." : `“${l === "A" ? c.question.a : c.question.b}” is the shorter answer.`;
    case "sage": {
      const a = c.others.filter((s) => s === "A").length;
      const b = c.others.length - a;
      return a === b ? "The others lean evenly, so orange." : `The others lean ${a} orange, ${b} violet: ${sideWord(l as Side)} looks emptier.`;
    }
    default:
      return "A coin flip. Your guess is as good as anyone's.";
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** One finished round, as far as the regulars are concerned. */
export type PastRound = { id: number; result: Result; picks: Record<string, Side | null> };

/** Builds the context for one regular from finished rounds (any order). `tableIds` is who sits in this round. */
export function contextFor(id: string, round: number, question: { a: string; b: string }, past: PastRound[], tableIds: string[]): Ctx {
  const before = past.filter((r) => r.id <= round - 2).sort((x, y) => y.id - x.id);
  const decided = before.find((r) => r.result !== "Void");
  const mine = before.find((r) => r.picks[id]);
  const base: Ctx = {
    question,
    lastWinner: decided ? (decided.result as Side) : null,
    own: mine ? { pick: mine.picks[id] as Side, result: mine.result } : null,
    others: [],
  };
  if (id !== "sage") return base;
  const others = tableIds
    .filter((t) => t !== "sage")
    .map((t) => lean(t, contextFor(t, round, question, past, tableIds)))
    .filter((s): s is Side => s !== null);
  return { ...base, others };
}
