/**
 * The time between meals overnight, as a fact.
 *
 * Approved 15 Oct 2026, with intermittent fasting allowed since 11 Oct: one
 * line on the Day screen, no goal, no streak, no praise. Worked out from
 * the times of eaten meals only; a plan counts once it is ticked.
 *
 * Two choices carry the safety of it:
 *
 *   The night runs to NIGHT_ENDS (05:00), the same hour planning uses. A
 *   snack at 00:30 belongs to the night before, so it neither ends the
 *   fast nor starts the day; reported as "first meal 00:30" it would make a
 *   normal late night look like a three-hour gap.
 *
 *   Over GAP_HOURS the app shows no number. A gap that long is almost
 *   always a meal nobody logged, and a large figure on screen would read as
 *   an achievement; the line says a meal may have gone unlogged instead.
 *   His number, 20.
 */

import { counts, NIGHT_ENDS } from './plan';
import { mealsBetween } from './meals';

export const GAP_HOURS = 20;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type FastLine =
  /** The day has its first meal: the gap before it. */
  | { kind: 'overnight'; last: number; first: number; ms: number }
  /** Today, nothing yet since the night: the time since the last meal. */
  | { kind: 'since'; last: number; ms: number }
  /** Too long to be a fast: a meal probably went unlogged. `first` null while still waiting. */
  | { kind: 'gap'; last: number; first: number | null };

/**
 * What the line says for the day starting at `dayStart`, from the times of
 * eaten meals around it, in order or not. Null when there is nothing to say:
 * a day not yet come, no meal before it to count from, or a past day with
 * no meal of its own.
 */
export function fastLine(dayStart: number, eatenAt: readonly number[], now: number): FastLine | null {
  const morning = dayStart + NIGHT_ENDS * HOUR;
  const nextMorning = morning + DAY;
  if (dayStart > now) return null;
  const times = [...eatenAt].sort((a, b) => a - b);
  const first = times.find((t) => t >= morning && t < nextMorning) ?? null;
  const upTo = first ?? now;
  const before = times.filter((t) => t < upTo && t < morning);
  const last = before.length ? before[before.length - 1] : null;
  if (last === null) return null;
  if (first !== null) {
    const ms = first - last;
    return ms > GAP_HOURS * HOUR ? { kind: 'gap', last, first } : { kind: 'overnight', last, first, ms };
  }
  // No meal yet after the night: only today has a "since".
  if (now >= nextMorning) return null;
  const ms = now - last;
  return ms > GAP_HOURS * HOUR ? { kind: 'gap', last, first: null } : { kind: 'since', last, ms };
}

/** "12 h 20 min", "45 min". */
export function duration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** The line for a day, read from the record: eaten meals from three days before it to the morning after. */
export async function readFastLine(dayStart: number, now = Date.now()): Promise<FastLine | null> {
  const rows = await mealsBetween(dayStart - 3 * DAY, dayStart + DAY + NIGHT_ENDS * HOUR);
  const eaten = rows.filter((r) => r.items.some((i) => counts(i.plan_state))).map((r) => r.meal.eaten_at);
  return fastLine(dayStart, eaten, now);
}
