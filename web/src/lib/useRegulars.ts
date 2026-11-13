// The regulars' table, leans and records, as reported by the house service (GET /regulars).
// Everything here can be recomputed from the chain: `npm run judge` does exactly that.
import { useEffect, useRef, useState } from "react";
import { GUEST_API, type Question } from "./near";
import type { Result, Side } from "./regulars";

export type Seat = { id: string; lean: Side | null; why: string };
export type RegularInfo = {
  id: string;
  name: string;
  habit: string;
  rule: string;
  account: string;
  balance: string;
  out: boolean;
  streak: number;
  played: number;
  won: number;
  lost: number;
  void: number;
  unopened: number;
  kept: number;
  keptOf: number;
  net: string;
  last: Array<{ round: number; pick: Side | null; lean: Side | null; result: Result }>;
};
export type PastTable = { id: number; result: Result; a: number; b: number; commits: number; question: Question; picks: Record<string, Side | null>; leans: Record<string, Side | null> };
export type Regulars = {
  round: number | null;
  follow: number;
  since: number;
  showcaseEvery: number;
  table: Seat[];
  opening: { id: number; picks: Record<string, Side | null> } | null;
  regulars: RegularInfo[];
  rounds: PastTable[];
};

/** Polls the house service. Returns null when it is off or unreachable: the game still works without it. */
export function useRegulars(round: number | undefined): Regulars | null {
  const [data, setData] = useState<Regulars | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!GUEST_API) return;
    let stop = false;
    const load = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const res = await fetch(`${GUEST_API}/regulars`);
        if (res.ok && !stop) setData((await res.json()) as Regulars);
      } catch {
        /* keep the last answer */
      } finally {
        busy.current = false;
      }
    };
    load();
    // The table is set a few seconds into each round, so look often.
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [round]);
  return data;
}

/** The table for `round`, or null while the service is still on an older round. */
export const tableFor = (r: Regulars | null, round: number | undefined): Seat[] | null => (r && r.round === round && r.table.length ? r.table : null);
