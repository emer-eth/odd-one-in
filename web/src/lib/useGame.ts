import { useCallback, useEffect, useRef, useState } from "react";
import {
  chainTimeNs,
  sessionKeyActive,
  view,
  type Config,
  type CurrentRound,
  type EntryView,
  type Player,
  type RoundView,
} from "./near";
import { loadSalt, type SaltRecord } from "./game";

const POLL_MS = 8_000;

export type GameState = {
  config: Config | null;
  cur: CurrentRound | null;
  prev: RoundView | null; // round in its reveal phase
  recent: RoundView[];
  pot: string;
  player: Player | null;
  entryCur: EntryView | null;
  entryPrev: EntryView | null;
  prevSalt: SaltRecord | null;
  keyActive: boolean | null;
  /** chain clock minus local clock, in ms. Timing comes from the chain; local time only animates. */
  offsetMs: number;
  loadError: string | null;
};

export function useGame(account: string | null) {
  const [s, setS] = useState<GameState>({
    config: null,
    cur: null,
    prev: null,
    recent: [],
    pot: "0",
    player: null,
    entryCur: null,
    entryPrev: null,
    prevSalt: null,
    keyActive: null,
    offsetMs: 0,
    loadError: null,
  });
  const busy = useRef(false);
  // Config never changes and history only changes when the round does: fetch them sparingly.
  const configRef = useRef<Config | null>(null);
  const recentFor = useRef<number | null>(null);
  const recentRef = useRef<RoundView[]>([]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (document.hidden && configRef.current) return;
      const [config, cur, pot, chainNs] = await Promise.all([
        configRef.current ? Promise.resolve(configRef.current) : view<Config>("get_config"),
        view<CurrentRound>("get_current_round"),
        view<string>("get_pot"),
        chainTimeNs(),
      ]);
      configRef.current = config;
      if (recentFor.current !== cur.id) {
        recentRef.current = await view<RoundView[]>("get_recent_rounds", { limit: 8 });
        recentFor.current = cur.id;
      }
      const recent = recentRef.current;
      const prev = cur.id > 0 ? await view<RoundView>("get_round", { id: cur.id - 1 }) : null;
      let player: Player | null = null;
      let entryCur: EntryView | null = null;
      let entryPrev: EntryView | null = null;
      if (account) {
        [player, entryCur, entryPrev] = await Promise.all([
          view<Player | null>("get_player", { account_id: account }),
          view<EntryView>("get_entry", { account_id: account, round_id: cur.id }),
          cur.id > 0 ? view<EntryView>("get_entry", { account_id: account, round_id: cur.id - 1 }) : Promise.resolve(null),
        ]);
      }
      const offsetMs = Number(chainNs / 1_000_000n) - Date.now();
      setS((old) => ({
        ...old,
        config,
        cur,
        prev,
        recent,
        pot,
        player,
        entryCur,
        entryPrev,
        prevSalt: account && cur.id > 0 ? loadSalt(account, cur.id - 1) : null,
        offsetMs,
        loadError: null,
      }));
    } catch (e) {
      setS((old) => ({ ...old, loadError: e instanceof Error ? e.message : String(e) }));
    } finally {
      busy.current = false;
    }
  }, [account]);

  const refreshKey = useCallback(async () => {
    if (!account) return setS((old) => ({ ...old, keyActive: null }));
    const keyActive = await sessionKeyActive(account);
    setS((old) => ({ ...old, keyActive }));
  }, [account]);

  useEffect(() => {
    setS((old) => ({ ...old, player: null, entryCur: null, entryPrev: null, prevSalt: null, keyActive: null }));
    refresh();
    refreshKey();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, refreshKey]);

  return { ...s, refresh, refreshKey };
}

/** Milliseconds until the chain timestamp `ns`, using the chain/local offset. */
export function msUntil(ns: string, offsetMs: number): number {
  return Number(BigInt(ns) / 1_000_000n) - (Date.now() + offsetMs);
}
