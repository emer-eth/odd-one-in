import { Explainer } from "./Explainer";

/** The animated walk-through of one round, below the game. */
export function WatchRound() {
  return (
    <section id="watch" className="grid items-center gap-10 py-16 sm:py-20 lg:grid-cols-[0.9fr_1fr] lg:gap-14">
      <div>
        <span className="stub">
          <span>Watch</span>
          <span>One round, start to finish</span>
        </span>
        <h2 className="display mt-5 text-3xl font-extrabold sm:text-4xl">The trick is guessing what everyone else won&apos;t.</h2>
        <p className="mt-4 max-w-md text-ink-2">Fifteen players, one question. Follow their votes from sealed to opened to paid.</p>
      </div>
      <Explainer />
    </section>
  );
}
