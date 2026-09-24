/**
 * The calendar behind the date.
 *
 * Stepping back a fortnight one tap at a time is the kind of small friction
 * that stops you looking at your own history at all. This drops a month grid
 * under the date, remembers nothing, and closes the moment you pick.
 *
 * Two marks, and only two:
 *   - today wears a blue bubble, so you always know where you are
 *   - a day with anything logged carries a blue dot beneath it
 * A day with nothing gets no decoration at all. An empty square that looks
 * the same as a full one is the only thing this view has to get right.
 *
 * Days after today are shown but not selectable — there is nothing to see
 * there, and hiding them would make the grid jump shape at the month's end.
 */

import { useEffect, useMemo, useState } from 'react';
import { loggedDays, localDayKey } from '../domain/day';
import { startOfToday } from '../domain/meals';
import { Chevron } from './bits';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Monday-first offset for a month starting on `first`. */
function leadingBlanks(first: Date): number {
  return (first.getDay() + 6) % 7;
}

function monthStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function DatePicker({
  selected,
  onPick,
  onClose,
}: {
  /** Local midnight of the day being viewed. */
  selected: number;
  onPick: (dayStart: number) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState<Date>(() => monthStart(selected));
  const [marked, setMarked] = useState<Set<string>>(new Set());

  const today = startOfToday();
  const todayKey = localDayKey(today);
  const selectedKey = localDayKey(selected);

  const { days, blanks, from, to } = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const count = Math.round((next.getTime() - first.getTime()) / 86_400_000);
    return {
      days: Array.from({ length: count }, (_, i) =>
        new Date(cursor.getFullYear(), cursor.getMonth(), i + 1),
      ),
      blanks: leadingBlanks(first),
      from: first.getTime(),
      to: next.getTime(),
    };
  }, [cursor]);

  useEffect(() => {
    let live = true;
    void loggedDays(from, to).then((s) => {
      if (live) setMarked(s);
    });
    return () => {
      live = false;
    };
  }, [from, to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // There is nothing above today, so stop the forward arrow there.
  const atCurrentMonth =
    cursor.getFullYear() === new Date(today).getFullYear() &&
    cursor.getMonth() === new Date(today).getMonth();

  const step = (n: number) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));

  return (
    <>
      <div className="scrim scrim--dim" onClick={onClose} />
      <div className="calendar" role="dialog" aria-label="Pick a day">
        <div className="cal-head">
          <button className="arrow" onClick={() => step(-1)} aria-label="Previous month">
            <Chevron size={15} />
          </button>
          <div className="cal-month">
            {cursor.toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric',
            })}
          </div>
          <button
            className="arrow"
            onClick={() => step(1)}
            disabled={atCurrentMonth}
            aria-label="Next month"
          >
            <Chevron size={15} dir="right" />
          </button>
        </div>

        <div className="cal-grid cal-dow" aria-hidden="true">
          {WEEKDAYS.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>

        <div className="cal-grid">
          {Array.from({ length: blanks }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {days.map((d) => {
            const ms = d.getTime();
            const key = localDayKey(ms);
            const future = ms > today;
            return (
              <button
                key={key}
                className="cal-day"
                data-today={key === todayKey ? '1' : undefined}
                data-on={key === selectedKey ? '1' : undefined}
                data-logged={marked.has(key) ? '1' : undefined}
                disabled={future}
                aria-current={key === selectedKey ? 'date' : undefined}
                aria-label={d.toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                onClick={() => {
                  onPick(ms);
                  onClose();
                }}
              >
                <span className="n">{d.getDate()}</span>
                <span className="mark" />
              </button>
            );
          })}
        </div>

        <div className="cal-foot">
          <button
            className="link"
            onClick={() => {
              onPick(today);
              onClose();
            }}
          >
            Jump to today
          </button>
          <span className="muted small">
            <i className="cal-key-dot" /> has entries
          </span>
        </div>
      </div>
    </>
  );
}
