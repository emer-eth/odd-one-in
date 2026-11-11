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

/** The page's opening line, kept short so the round itself is the first thing on screen. */
export function Masthead({ roundId }: { roundId: number | null }) {
  return (
    <section className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 pt-8 pb-7 sm:pt-10">
      <div>
        <span className="stub">
          <span className="flex items-center gap-2">
            <span className="live-dot h-2 w-2 rounded-full bg-side-a" />
            Live
          </span>
          <span>NEAR testnet{roundId !== null && <> · round {roundId}</>}</span>
        </span>
        <h1 className="display mt-5 text-[2.4rem] font-extrabold sm:text-6xl">
          Pick the side{" "}
          <span className="mx-[0.12em] inline-block">
            <Circled>fewer</Circled>
          </span>{" "}
          people pick.
        </h1>
      </div>
      <p className="max-w-sm text-ink-2">
        One question a round, two answers. Seal your pick with a small stake. When the votes are opened, the smaller side wins.{" "}
        <a href="#watch" className="font-semibold text-ink underline underline-offset-4">Watch a round</a>
      </p>
    </section>
  );
}

/** The animated walk-through of one round, below the game. */
export function WatchRound() {
  return (
    <section id="watch" className="grid items-center gap-10 py-16 sm:py-20 lg:grid-cols-[0.9fr_1fr] lg:gap-14">
      <div>
        <span className="stub">
          <span>Watch</span>
          <span>One round, start to finish</span>
        </span>
        <h2 className="display mt-5 text-4xl font-extrabold sm:text-5xl">The trick is guessing what everyone else won&apos;t.</h2>
        <p className="mt-4 max-w-md text-ink-2">Fifteen players, one question. Follow their votes from sealed to opened to paid.</p>
      </div>
      <Explainer />
    </section>
  );
}
