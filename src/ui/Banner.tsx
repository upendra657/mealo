/**
 * The line under the home grid.
 *
 * A small deck rather than one sentence: what is short, how the day is going,
 * where the weight has drifted are separate observations and someone watching
 * would mention them separately. Swipe across it, or leave it and it moves on
 * its own every five seconds.
 *
 * The auto-advance is the part that makes it feel alive rather than posted,
 * and the part most likely to feel restless if it is wrong — five seconds is
 * long enough to finish reading and short enough that the panel is clearly
 * paying attention. Touching it stops the timer and restarts it, so it never
 * slides out from under a finger.
 *
 * Words come from domain/banner.ts. Nothing here decides what to say.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Phrase } from '../domain/banner';

const DWELL = 5000;

export function Banner({ cards }: { cards: Phrase[] }) {
  const [i, setI] = useState(0);
  const [fading, setFading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const down = useRef<number | null>(null);

  // A shorter deck than last render must not leave the index off the end.
  const idx = cards.length > 0 ? i % cards.length : 0;

  const goto = useCallback(
    (next: number) => {
      if (cards.length < 2) return;
      setFading(true);
      window.setTimeout(() => {
        setI((next + cards.length) % cards.length);
        setFading(false);
      }, 190);
    },
    [cards.length],
  );

  const restart = useCallback(() => {
    window.clearInterval(timer.current);
    if (cards.length < 2) return;
    timer.current = window.setInterval(() => {
      setFading(true);
      window.setTimeout(() => {
        setI((n) => (n + 1) % cards.length);
        setFading(false);
      }, 190);
    }, DWELL);
  }, [cards.length]);

  useEffect(() => {
    restart();
    return () => window.clearInterval(timer.current);
  }, [restart]);

  if (cards.length === 0) return null;
  const card = cards[idx];

  const onDown = (e: React.PointerEvent) => {
    down.current = e.clientX;
  };
  const onUp = (e: React.PointerEvent) => {
    if (down.current === null) return;
    const dx = e.clientX - down.current;
    down.current = null;
    if (Math.abs(dx) > 34) {
      goto(idx + (dx < 0 ? 1 : -1));
      restart();
    }
  };

  return (
    <div
      className="banner"
      data-hue={card.hue}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={() => (down.current = null)}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* One wash per hue, cross-faded — a hard colour cut between cards
          reads as two panels rather than one thing changing its mind. */}
      {cards.map((c, n) => (
        <span key={c.tpl + n} className="bwash" data-hue={c.hue} data-on={n === idx ? '1' : undefined} />
      ))}

      <div className="binner">
        <div className="beyebrow" data-hue={card.hue}>
          <i />
          {card.who}
        </div>
        <p className="bsay" data-out={fading ? '1' : undefined}>
          {card.text}
        </p>
      </div>

      {cards.length > 1 && (
        <div className="bdots">
          {cards.map((c, n) => (
            <span key={c.tpl + n} data-on={n === idx ? '1' : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
