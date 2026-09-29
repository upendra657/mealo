/**
 * The weight dial.
 *
 * A half dial anchored below the bottom of the screen, the same shape as the
 * meal selector, moving in hundredths of a kilo. It opens on your last reading
 * rather than on nothing, which is the whole argument for it: a normal day is
 * a few hundred grams either way, so recording one is a nudge rather than a
 * number you have to type out.
 *
 * The first entry is the exception — there is no last reading to start from —
 * so the number itself is a button that swaps in a text field. That path stays
 * one tap away forever, because some mornings the scale says something the
 * dial would take a long drag to reach.
 *
 * Ticks are drawn as a window around the current value rather than all of
 * them: at 0.01 steps a full scale would be tens of thousands of elements.
 * Geometry note — the ticks hang off an origin 20px above the bottom of the
 * window at radius R, so the apex lands at 20 + R and the window has to be
 * taller than that. The SVG circle is positioned to share that same origin,
 * not the window's. Change R and you change both, in styles.css.
 */

import { useEffect, useRef, useState } from 'react';

const DEG = 1.25; // degrees of arc per step
const R = 252; // arc radius; matches the circle in the SVG below
// 46 was too narrow for the labels: at 0.01 a step, only one half-kilo
// mark ever fell inside the window, which left the arc reading as texture
// rather than as a scale. 64 puts two or three on screen.
const SPAN = 64; // ticks drawn each side of the needle
/** Pixels of horizontal travel per step. Fine enough to land exactly. */
const PX_PER_STEP = 3.2;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The dial takes its scale as props so the burn sheet can use the same
 * geometry without a second copy of it.
 *
 * Every default is the weight behaviour it shipped with — hundredths of a kilo
 * from 20 to 250, a label every half kilo, one decimal on the labels — so
 * WeightScreen passes nothing and renders exactly as before. Calories come in
 * at `step={10} min={0} max={3000} labelEvery={250} majorEvery={50} decimals={0}`.
 *
 * `step` being a prop is why `snap` exists: rounding to the step has to happen
 * in the step's own units, and 0.01 and 10 round differently.
 */
export function WeightDial({
  value,
  onChange,
  min = 20,
  max = 250,
  step = 0.01,
  /** Ticks at multiples of this get the long treatment and a number. */
  labelEvery = 0.5,
  /** Ticks at multiples of this are drawn heavier. */
  majorEvery = 0.1,
  /** Decimal places on the tick labels. */
  decimals = 1,
  label = 'Weight',
  unitWord = 'kilograms',
  /** Recolours the needle and ticks. Undefined keeps the weight cyan. */
  hue,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  labelEvery?: number;
  majorEvery?: number;
  decimals?: number;
  label?: string;
  unitWord?: string;
  hue?: 'burn';
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Snap in the step's own units. Working in hundredths regardless would land
  // a 10-calorie step on 423 and the needle would sit between two ticks.
  const snap = (v: number) => round2(Math.round(v / step) * step);
  const set = (v: number) => onChange(Math.min(max, Math.max(min, snap(v))));

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, from: value };
    setDragging(true);
    wrap.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    set(drag.current.from - ((e.clientX - drag.current.x) * step) / PX_PER_STEP);
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };

  // Arrow keys, because a dial that can only be dragged is unreachable from a
  // keyboard and this is the only way to enter the number without typing it.
  const onKey = (e: React.KeyboardEvent) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(value + step * big); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(value - step * big); }
  };

  // Multiples are tested in integer units of the step rather than with a
  // modulo on the float: 0.3 % 0.1 is 0.09999999999999998, and every tenth
  // label would have gone missing.
  const perMajor = Math.max(1, Math.round(majorEvery / step));
  const perLabel = Math.max(1, Math.round(labelEvery / step));

  const centre = Math.round(value / step);
  const ticks = [];
  for (let k = -SPAN; k <= SPAN; k++) {
    const n = centre + k;
    const v = round2(n * step);
    if (v < min || v > max) continue;
    const a = (k * DEG * Math.PI) / 180;
    const isMajor = n % perMajor === 0;
    const isLabel = n % perLabel === 0;
    const len = isLabel ? 22 : isMajor ? 15 : 9;
    const opacity = 1 - Math.min(0.8, Math.abs(k) / 58);
    const tx = R * Math.sin(a);
    const ty = -R * Math.cos(a);
    ticks.push(
      <i
        key={n}
        className={isMajor ? 'major' : undefined}
        style={{
          height: len,
          opacity,
          transform: `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${(k * DEG).toFixed(2)}deg)`,
        }}
      />,
    );
    if (isLabel) {
      const lr = R - 30;
      ticks.push(
        <b
          key={`l${n}`}
          style={{
            opacity,
            transform: `translate(${(lr * Math.sin(a)).toFixed(1)}px, ${(-lr * Math.cos(a)).toFixed(1)}px) rotate(${(k * DEG).toFixed(2)}deg) translate(-50%, 0)`,
          }}
        >
          {v.toFixed(decimals)}
        </b>,
      );
    }
  }

  return (
    <div
      className="dialwrap"
      ref={wrap}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value.toFixed(decimals)} ${unitWord}`}
      data-dragging={dragging ? '1' : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      data-hue={hue}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      <span className="needle" />
      <svg className="arc" viewBox="0 0 640 640" aria-hidden="true">
        <circle cx="320" cy="320" r={R} />
      </svg>
      <div className="ticks">{ticks}</div>
    </div>
  );
}

/**
 * The big number above the dial, which is also the way past it.
 *
 * Controlled by a draft string while it is being typed, for the reason the
 * quantity box needed one: bound straight to the number you cannot clear it,
 * because the empty field parses to zero and gets rejected and the old value
 * snaps back.
 */
export function WeightNumber({
  value,
  onChange,
  unit = 'kg',
  /** 2 for kilos, 0 for calories. Also what the typed value is rounded to. */
  decimals = 2,
  label = 'Weight in kilograms',
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  decimals?: number;
  label?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(decimals));
  const input = useRef<HTMLInputElement>(null);

  // Calories are shown with a thousands separator when they are just sitting
  // there, and without one the moment you start typing, because a comma in a
  // field you are editing is something you then have to delete.
  const shown = decimals === 0 ? Math.round(value).toLocaleString() : value.toFixed(decimals);

  useEffect(() => {
    if (!typing) setDraft(value.toFixed(decimals));
  }, [value, typing, decimals]);

  useEffect(() => {
    if (typing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [typing]);

  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v) && v > 0) {
      onChange(decimals === 0 ? Math.round(v) : round2(v));
    }
    setTyping(false);
  };

  if (typing) {
    return (
      <input
        ref={input}
        className="numbox"
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(value.toFixed(decimals)); setTyping(false); }
        }}
      />
    );
  }

  return (
    <button className="bignum" onClick={() => setTyping(true)} title="Type it instead">
      <span className="n">{shown}</span>
      <span className="u">{unit}</span>
    </button>
  );
}
