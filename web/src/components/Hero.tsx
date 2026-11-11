import { Explainer } from "./Explainer";

/** Hand-drawn loop around a word. */
export function Circled({ children }: { children: React.ReactNode }) {
  return (
    <span className="circled">
      {children}
      <svg viewBox="0 0 200 80" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M28 14 C70 2 150 2 186 22 C206 36 192 64 140 72 C88 80 22 74 9 52 C-2 32 24 14 62 9"
          fill="none"
          stroke="#0e0e10"
          strokeWidth="4.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

export function Hero({ roundId, onPlay }: { roundId: number | null; onPlay: () => void }) {
  return (
    <section className="grid items-center gap-10 pt-10 pb-14 sm:pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pb-20">
      <div>
        <span className="stub">
          <span className="flex items-center gap-2">
            <span className="live-dot h-2 w-2 rounded-full bg-side-a" />
            Live
          </span>
          <span>NEAR testnet{roundId !== null && <> · round {roundId}</>}</span>
        </span>
        <h1 className="display mt-7 text-[3.1rem] font-extrabold sm:text-7xl lg:text-[5.6rem]">
          Pick the side <Circled>fewer</Circled>{" "}&nbsp;people pick.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
          One question a round, two answers. Seal your pick with a small stake. When the votes are opened, the smaller side wins, so the
          trick is guessing what everyone else won't.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-5">
          <button onClick={onPlay} className="rounded-full bg-ink px-6 py-3.5 font-semibold text-paper hover:bg-black">
            Play this round
          </button>
          <a href="#how" className="font-semibold underline-offset-4 hover:underline">
            How it works
          </a>
        </div>
      </div>
      <Explainer />
    </section>
  );
}
