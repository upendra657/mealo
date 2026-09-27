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

const STEP = 0.01;
const DEG = 1.25; // degrees of arc per step
const R = 252; // arc radius; matches the circle in the SVG below
// 46 was too narrow for the labels: at 0.01 a step, only one half-kilo
// mark ever fell inside the window, which left the arc reading as texture
// rather than as a scale. 64 puts two or three on screen.
const SPAN = 64; // ticks drawn each side of the needle
/** Pixels of horizontal travel per step. Fine enough to land exactly. */
const PX_PER_STEP = 3.2;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function WeightDial({
  value,
  onChange,
  min = 20,
  max = 250,
}: {
  value: number;
  onChange: (kg: number) => void;
  min?: number;
  max?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const set = (v: number) => onChange(Math.min(max, Math.max(min, round2(v))));

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, from: value };
    setDragging(true);
    wrap.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    set(drag.current.from - ((e.clientX - drag.current.x) * STEP) / PX_PER_STEP);
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };

  // Arrow keys, because a dial that can only be dragged is unreachable from a
  // keyboard and this is the only way to enter the number without typing it.
  const onKey = (e: React.KeyboardEvent) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(value + STEP * big); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(value - STEP * big); }
  };

  const centre = Math.round(value / STEP);
  const ticks = [];
  for (let k = -SPAN; k <= SPAN; k++) {
    const kg = (centre + k) * STEP;
    if (kg < min || kg > max) continue;
    const a = (k * DEG * Math.PI) / 180;
    const hundredths = Math.round(kg * 100);
    const isTenth = hundredths % 10 === 0;
    const isHalf = hundredths % 50 === 0;
    const len = isHalf ? 22 : isTenth ? 15 : 9;
    const opacity = 1 - Math.min(0.8, Math.abs(k) / 58);
    const tx = R * Math.sin(a);
    const ty = -R * Math.cos(a);
    ticks.push(
      <i
        key={hundredths}
        className={isTenth ? 'major' : undefined}
        style={{
          height: len,
          opacity,
          transform: `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${(k * DEG).toFixed(2)}deg)`,
        }}
      />,
    );
    if (isHalf) {
      const lr = R - 30;
      ticks.push(
        <b
          key={`l${hundredths}`}
          style={{
            opacity,
            transform: `translate(${(lr * Math.sin(a)).toFixed(1)}px, ${(-lr * Math.cos(a)).toFixed(1)}px) rotate(${(k * DEG).toFixed(2)}deg) translate(-50%, 0)`,
          }}
        >
          {(kg).toFixed(1)}
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
      aria-label="Weight"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value.toFixed(2)} kilograms`}
      data-dragging={dragging ? '1' : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
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
}: {
  value: number;
  onChange: (kg: number) => void;
  unit?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(2));
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!typing) setDraft(value.toFixed(2));
  }, [value, typing]);

  useEffect(() => {
    if (typing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [typing]);

  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v) && v > 0) onChange(round2(v));
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
        aria-label="Weight in kilograms"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(value.toFixed(2)); setTyping(false); }
        }}
      />
    );
  }

  return (
    <button className="bignum" onClick={() => setTyping(true)} title="Type it instead">
      <span className="n">{value.toFixed(2)}</span>
      <span className="u">{unit}</span>
    </button>
  );
}
