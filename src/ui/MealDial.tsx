/**
 * The meal selector.
 *
 * A half dial anchored below the bottom of the screen, its slots riding the
 * arc from dawn on the left to night on the right, and the sky behind the
 * whole page cross-fading as it turns. Whatever sits at the apex is selected.
 *
 * Two things make it feel right rather than merely work. The icons are placed
 * by trigonometry and never rotated, so they stay upright as the dial moves —
 * counter-rotating a rotated container produces a visible wobble. And the sky
 * is interpolated continuously from the fractional position rather than
 * switched at each detent, so dragging between lunch and evening actually
 * passes through the colour in between.
 *
 * Geometry note: the arc's centre sits 20px above the bottom of its window,
 * and the icons share that origin. If you change the SVG radius, change R.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SLOTS, type SlotId } from '../domain/slots';
import { SlotIcon } from './SlotIcon';

const R = 210; // arc radius; matches the circle in the SVG below
const SPREAD = 26; // degrees between slots
const OFFSET = ((SLOTS.length - 1) / 2) * SPREAD;

export function MealDial({
  value,
  onChange,
  onConfirm,
}: {
  value: SlotId;
  onChange: (s: SlotId) => void;
  onConfirm: () => void;
}) {
  const startIndex = Math.max(0, SLOTS.findIndex((s) => s.id === value));
  const [frac, setFrac] = useState(startIndex);
  const [animate, setAnimate] = useState(true);
  // Whether a finger is down is something the render reads (it suppresses
  // transitions mid-drag), so it is state, not a ref.
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const settle = useCallback(
    (f: number, smooth: boolean) => {
      setAnimate(smooth);
      setFrac(f);
      const near = Math.round(f);
      const slot = SLOTS[Math.max(0, Math.min(SLOTS.length - 1, near))];
      if (slot.id !== value) onChange(slot.id);
    },
    [onChange, value],
  );

  // Follow an external change (the caller jumped to a different slot).
  useEffect(() => {
    const i = SLOTS.findIndex((s) => s.id === value);
    if (i >= 0 && Math.round(frac) !== i) {
      setAnimate(true);
      setFrac(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, from: frac };
    setDragging(true);
    wrap.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const f = drag.current.from - (e.clientX - drag.current.x) / 62;
    settle(Math.max(0, Math.min(SLOTS.length - 1, f)), false);
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    settle(Math.round(frac), true);
  };

  const selected = Math.round(frac);

  return (
    <>
      {/* Sky layers, one per slot, opacity driven by distance from the
          current position so dragging blends rather than snaps. */}
      {SLOTS.map((s, i) => (
        <div
          key={s.id}
          className="wash"
          style={{
            background: s.sky,
            opacity: Math.max(0, 1 - Math.abs(frac - i)),
            transition: dragging ? 'none' : undefined,
          }}
        />
      ))}

      <p className="dial-hint">Drag the dial, or tap a slot</p>

      <div
        className="dial-wrap"
        ref={wrap}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <svg className="arc" viewBox="0 0 640 640" aria-hidden="true">
          <circle cx="320" cy="320" r={R} />
        </svg>

        <div className="dial-items">
          {SLOTS.map((s, i) => {
            const rot = -(frac * SPREAD - OFFSET);
            const a = ((-OFFSET + i * SPREAD + rot) * Math.PI) / 180;
            const dist = Math.abs(i - frac);
            return (
              <button
                key={s.id}
                className="dial-item"
                aria-label={s.label}
                aria-pressed={selected === i}
                data-sel={selected === i ? '1' : '0'}
                style={{
                  transform: `translate(${R * Math.sin(a)}px, ${-R * Math.cos(a)}px) scale(${Math.max(0.62, 1 - dist * 0.16)})`,
                  opacity: Math.max(0.4, 1 - dist * 0.26),
                  transition: animate && !dragging ? undefined : 'none',
                }}
                onClick={() => {
                  if (selected === i) onConfirm();
                  else settle(i, true);
                }}
              >
                <span className="disc" />
                <SlotIcon slot={s.id} />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
