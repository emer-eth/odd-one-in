import { useEffect, useRef, useState } from "react";

/** Tally marks: groups of four strokes crossed by a fifth. */
export function Tally({ n, color = "currentColor", h = 22 }: { n: number; color?: string; h?: number }) {
  const groups = Math.floor(n / 5);
  const rest = n % 5;
  const gw = h * 1.05; // width of a full group
  const sw = h * 0.22; // stroke spacing
  const w = Math.max(1, groups * (gw + h * 0.35) + rest * sw + 4);
  const strokes: React.ReactNode[] = [];
  let x = 2;
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < 4; i++) strokes.push(<line key={`${g}-${i}`} x1={x + i * sw} y1={2} x2={x + i * sw + 1} y2={h - 2} />);
    strokes.push(<line key={`${g}-x`} x1={x - 3} y1={h - 5} x2={x + 3 * sw + 4} y2={4} />);
    x += gw + h * 0.35;
  }
  for (let i = 0; i < rest; i++) strokes.push(<line key={`r-${i}`} x1={x + i * sw} y1={2} x2={x + i * sw + 1} y2={h - 2} />);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label={`${n}`} role="img" className="inline-block align-middle">
      <g stroke={color} strokeWidth={2.2} strokeLinecap="round">
        {strokes}
      </g>
    </svg>
  );
}

/** A rubber stamp, slightly rotated. */
export function Stamp({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block -rotate-6 rounded-md border-[2.5px] border-current px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] ${className}`}
    >
      {children}
    </span>
  );
}

// ---------- the animated round ----------

const STEPS = [
  { key: "pick", title: "Pick", caption: "Fifteen players each pick an answer to the same question." },
  { key: "seal", title: "Seal", caption: "Every pick is sealed with a secret salt. Nobody can see the split, not even the owner." },
  { key: "open", title: "Open", caption: "Next round the votes are opened. One player never comes back to open theirs." },
  { key: "count", title: "Count", caption: "Only opened votes count: 6 said Yes, 8 said No." },
  { key: "win", title: "Win", caption: "The smaller side wins. Picking what everyone else picks loses." },
  { key: "pay", title: "Pay", caption: "Each winner gains one stake minus a 2% fee, each loser loses one. The rest fills the streak pot." },
] as const;

const W = 600;
const H = 400;
// 15 players: 6 pick A ("Yes"), 8 pick B ("No"), 1 picks B but never opens.
const SIDES: Array<"A" | "B"> = ["B", "A", "B", "B", "A", "B", "A", "B", "A", "B", "B", "A", "B", "A", "B"];
const GHOST = 9; // index of the player who never opens

function crowdPos(i: number): [number, number] {
  const c = i % 5;
  const r = Math.floor(i / 5);
  return [110 + c * 95 + (r % 2) * 22, 92 + r * 82];
}

function columnPos(i: number): [number, number] {
  if (i === GHOST) return [300, 300];
  const side = SIDES[i];
  const k = SIDES.slice(0, i).filter((s, j) => s === side && j !== GHOST).length;
  const cx = side === "A" ? 150 : 450;
  const c = k % 2;
  const r = Math.floor(k / 2);
  return [cx - 30 + c * 60, 98 + r * 50];
}

function Token({ i, step }: { i: number; step: number }) {
  const side = SIDES[i];
  const ghost = i === GHOST;
  const [x, y] = step >= 3 ? columnPos(i) : crowdPos(i);
  const sealed = step === 1 || (ghost && step >= 2);
  const fill = sealed ? "#8f8b80" : side === "A" ? "#ff5a3c" : "#3cc8ff";
  const lit = step >= 4 && !ghost && side === "A";
  const dim = step >= 4 && !ghost && side === "B";
  const inPot = ghost && step >= 5;
  return (
    <g
      className="tok"
      style={{
        transform: `translate(${inPot ? 300 : x}px, ${inPot ? 346 : y}px) scale(${inPot ? 0.6 : 1})`,
        opacity: dim ? 0.38 : 1,
        transitionDelay: `${(i % 5) * 45 + Math.floor(i / 5) * 25}ms`,
      }}
    >
      <rect x={-22} y={-15} width={44} height={30} rx={5} fill={fill} stroke={lit ? "#0e0e10" : ghost && step >= 2 ? "#55555e" : "none"} strokeWidth={lit ? 2 : 1.5} strokeDasharray={ghost && step >= 2 ? "4 3" : undefined} className="tok-fill" />
      {/* envelope flap, shown while sealed */}
      <path d="M-22 -15 L0 3 L22 -15" fill="none" stroke="#f4f2ec" strokeWidth={1.6} strokeLinejoin="round" style={{ opacity: sealed ? 0.9 : 0 }} className="tok-fill" />
      <circle cx={0} cy={3} r={3.2} fill="#0e0e10" style={{ opacity: sealed ? 1 : 0 }} className="tok-fill" />
      <text x={0} y={5} textAnchor="middle" fontSize={13} fontWeight={700} fill="#0e0e10" fontFamily="JetBrains Mono, monospace" style={{ opacity: sealed ? 0 : 1 }} className="tok-fill">
        {side === "A" ? "Y" : "N"}
      </text>
      {lit && <circle cx={18} cy={-12} r={5} fill="#c8ff3c" stroke="#0e0e10" strokeWidth={1.5} />}
    </g>
  );
}

export function Explainer() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible || reduce) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), step === STEPS.length - 1 ? 4200 : 2700);
    return () => clearTimeout(t);
  }, [step, playing, visible, reduce]);

  const s = STEPS[step];

  return (
    <div ref={root} className="relative">
      <div className="relative overflow-hidden rounded-[1.75rem] border-[1.5px] border-ink bg-paper-2/60">
        {/* ruled counting-sheet lines */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_31px,rgba(14,14,16,0.06)_31px,rgba(14,14,16,0.06)_32px)]" />
        <div className="relative flex items-center justify-between px-5 pt-4 font-mono text-[11px] uppercase tracking-widest text-ink-2">
          <span>Watch one round</span>
          <span>
            {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="relative block h-auto w-full" role="img" aria-label={`Step ${step + 1} of ${STEPS.length}: ${s.title}. ${s.caption}`}>
          {/* question card */}
          <g style={{ opacity: step >= 3 ? 0 : 1 }} className="tok-fill">
            <text x={W / 2} y={34} textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontWeight={800} fontSize={22} fill="#0e0e10">
              “Pineapple on pizza?”
            </text>
          </g>
          {/* column headers, tallies and results */}
          <g style={{ opacity: step >= 3 ? 1 : 0 }} className="tok-fill">
            <text x={150} y={40} textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontWeight={800} fontSize={22} fill="#0e0e10">Yes</text>
            <text x={450} y={40} textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontWeight={800} fontSize={22} fill="#0e0e10" style={{ opacity: step >= 4 ? 0.4 : 1 }}>No</text>
            <foreignObject x={95} y={238} width={120} height={30}>
              <div className="flex justify-center text-ink"><Tally n={6} /></div>
            </foreignObject>
            <foreignObject x={380} y={286} width={140} height={30}>
              <div className="flex justify-center text-ink" style={{ opacity: step >= 4 ? 0.4 : 1 }}><Tally n={8} /></div>
            </foreignObject>
            <text x={150} y={286} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={15} fill="#0e0e10">6</text>
            <text x={450} y={334} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={15} fill="#55555e">8</text>
          </g>
          {/* stamp on the winning column */}
          <g style={{ opacity: step >= 4 ? 1 : 0, transform: step >= 4 ? "translate(150px, 334px) rotate(-8deg) scale(1)" : "translate(150px, 334px) rotate(-8deg) scale(1.7)" }} className="stamp">
            <rect x={-74} y={-17} width={148} height={34} rx={6} fill="#c8ff3c" stroke="#0e0e10" strokeWidth={2.5} />
            <text x={0} y={6} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontWeight={700} fontSize={15} letterSpacing={2.5} fill="#0e0e10">ODD ONE IN</text>
          </g>
          {/* payouts */}
          <g style={{ opacity: step >= 5 ? 1 : 0 }} className="tok-fill" fontFamily="JetBrains Mono, monospace" fontSize={14}>
            <text x={150} y={64} textAnchor="middle" fill="#0e0e10" fontWeight={700}>+0.098 each</text>
            <text x={450} y={64} textAnchor="middle" fill="#c9362a" fontWeight={700}>−0.1 each</text>
          </g>
          {/* streak pot */}
          <g style={{ opacity: step >= 5 ? 1 : step >= 3 ? 0.5 : 0 }} className="tok-fill">
            <path d="M268 322 h64 v40 a8 8 0 0 1 -8 8 h-48 a8 8 0 0 1 -8 -8 z" fill="none" stroke="#0e0e10" strokeWidth={2} />
            <text x={300} y={392} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={12} fill="#55555e">
              {step >= 5 ? "pot +0.4" : "never opened"}
            </text>
          </g>
          {SIDES.map((_, i) => (
            <Token key={i} i={i} step={step} />
          ))}
        </svg>
        <p aria-live="polite" className="relative min-h-[4.5rem] px-5 pb-5 text-[15px] leading-snug">
          <span className="font-semibold">{s.title}.</span> <span className="text-ink-2">{s.caption}</span>
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-[1.5px] border-ink text-sm hover:bg-ink hover:text-paper"
          aria-label={playing && !reduce ? "Pause" : "Play"}
        >
          {playing && !reduce ? "❚❚" : "▶"}
        </button>
        <div className="flex flex-1 gap-1.5" role="tablist" aria-label="Steps">
          {STEPS.map((st, i) => (
            <button
              key={st.key}
              role="tab"
              aria-selected={i === step}
              onClick={() => {
                setStep(i);
                setPlaying(false);
              }}
              className={`flex-1 rounded-full py-1.5 font-mono text-[10px] uppercase tracking-wider transition sm:text-[11px] ${
                i === step ? "bg-ink text-paper" : i < step ? "bg-ink/15 text-ink" : "bg-paper-2 text-ink-2 hover:text-ink"
              }`}
            >
              {st.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
