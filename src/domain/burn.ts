/**
 * Calories burnt, entered by hand.
 *
 * The sibling of weight.ts, and deliberately almost the same file — one row
 * per local day, soft deleted, per person, every chart drawn only from rows
 * that exist. Three things differ, and each of them follows from burn being a
 * flow rather than a level.
 *
 * **A second entry adds.** Weighing twice in a morning gives two readings of
 * one thing, so the later replaces the earlier. Walking in the morning and
 * going to the gym at night gives two parts of one day, so they sum. That is
 * `recordBurn`, and it is the path the sheet uses. `setBurnTotal` overwrites
 * instead, which exists because otherwise a mistyped 3200 could never be
 * taken back.
 *
 * **More is the good direction.** Nothing here encodes that — it is the UI's
 * business — but it is why `trendOver` is absent. A first-to-last delta over
 * daily totals says nothing useful: burn does not drift the way a body does,
 * it just varies. What the screen wants instead is `streak` and an average,
 * and both are below.
 *
 * **Nothing nets it against food.** There is no function here that touches
 * the energy target, and there should not be. Burning 500 does not raise the
 * day's remaining calories. This is a measurement the agents may read, not a
 * term in an equation the app computes.
 *
 * Read and written through the Doctor's handle: what the body did belongs to
 * the agent that reasons about bodies. The Nutritionist can read it
 * (db/scope.ts) when asked about a day, but the home banner composes no line
 * about it — see the note there.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import { localDayKey } from './day';
import { dayStartOf } from './weight';

const db = scopedDb('doctor');

export type Burn = {
  id: string;
  measured_at: number;
  kcal: number;
  note: string | null;
};

/** Local midnight for a timestamp. Shared with weight, same bucketing. */
export { dayStartOf };

// ------------------------------------------------------------- writes

/** The row holding a local day's total, or null. */
async function rowFor(dayStart: number): Promise<{ id: string; kcal: number } | null> {
  const rows = await db.query<{ id: string; kcal: number }>(
    `SELECT id, kcal FROM burns
      WHERE profile_id = ? AND deleted_at IS NULL
        AND measured_at >= ? AND measured_at < ?
      LIMIT 1`,
    [activeProfile(), dayStart, dayStart + 86_400_000],
  );
  return rows[0] ?? null;
}

/**
 * Add `kcal` to the day's total, creating the day if it is the first entry.
 *
 * The default path, and the reason burn does not simply reuse the weight
 * code. Two sessions in a day are two parts of one number, so the app does
 * the addition rather than asking you to.
 *
 * Returns the day's new total so the caller can say what it became without a
 * second read.
 */
export async function recordBurn(
  kcal: number,
  measuredAt = Date.now(),
  note: string | null = null,
): Promise<{ id: string; total: number }> {
  const existing = await rowFor(dayStartOf(measuredAt));
  if (existing) {
    const total = existing.kcal + kcal;
    await db.update('burns', existing.id, { kcal: total, measured_at: measuredAt, note });
    return { id: existing.id, total };
  }
  const id = await db.insert('burns', {
    kcal,
    measured_at: measuredAt,
    note,
    deleted_at: null,
  });
  return { id, total: kcal };
}

/**
 * Set the day's total outright, discarding whatever was there.
 *
 * For corrections. Without it an add-only screen has no way back from a
 * mistyped number, which would be a worse trap than the arithmetic it saves.
 */
export async function setBurnTotal(
  kcal: number,
  measuredAt = Date.now(),
  note: string | null = null,
): Promise<string> {
  const existing = await rowFor(dayStartOf(measuredAt));
  if (existing) {
    await db.update('burns', existing.id, { kcal, measured_at: measuredAt, note });
    return existing.id;
  }
  return db.insert('burns', { kcal, measured_at: measuredAt, note, deleted_at: null });
}

export async function deleteBurn(id: string): Promise<void> {
  await db.softDelete('burns', id);
}

// -------------------------------------------------------------- reads

/** Totals on or after `fromMs`, oldest first. */
export async function burnsSince(fromMs: number): Promise<Burn[]> {
  return db.query<Burn>(
    `SELECT id, measured_at, kcal, note FROM burns
      WHERE profile_id = ? AND deleted_at IS NULL AND measured_at >= ?
      ORDER BY measured_at ASC`,
    [activeProfile(), fromMs],
  );
}

/** The total for one local day, or null when nothing was logged. */
export async function burnOn(dayStart: number): Promise<Burn | null> {
  const rows = await db.query<Burn>(
    `SELECT id, measured_at, kcal, note FROM burns
      WHERE profile_id = ? AND deleted_at IS NULL
        AND measured_at >= ? AND measured_at < ?
      LIMIT 1`,
    [activeProfile(), dayStart, dayStart + 86_400_000],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------- the goal

/**
 * Calories to burn in a day, if this person set a number.
 *
 * On `targets` beside weight_kg and the macro goals, read through the
 * Nutritionist's handle because that table's owner is the Nutritionist.
 * Nothing computes it — the app has no view on how much anyone should burn.
 */
const targetsDb = scopedDb('nutritionist');

export async function goalBurn(): Promise<number | null> {
  const rows = await targetsDb.query<{ burn_kcal: number | null }>(
    'SELECT burn_kcal FROM targets WHERE id = ? AND deleted_at IS NULL',
    [activeProfile()],
  );
  return rows[0]?.burn_kcal ?? null;
}

export async function setGoalBurn(kcal: number | null): Promise<void> {
  const id = activeProfile();
  const exists = await targetsDb.query<{ id: string }>(
    'SELECT id FROM targets WHERE id = ?',
    [id],
  );
  if (exists[0]) await targetsDb.update('targets', id, { burn_kcal: kcal });
  else await targetsDb.insert('targets', { id, burn_kcal: kcal, deleted_at: null });
}

// --------------------------------------------------------- pure helpers

export type BurnPoint = { t: number; kcal: number };

/**
 * One point per local day.
 *
 * Days nobody logged are absent, not zero. A zero is a claim that you moved
 * nothing all day; an absence says no one recorded it, which is the truth and
 * is why the chart leaves a gap in the row of bars rather than drawing a bar
 * of height nothing.
 *
 * One row per day is already the invariant, so this mostly guards against a
 * duplicate: the later `measured_at` wins, matching what the writes do.
 */
export function byDay(rows: { measured_at: number; kcal: number }[]): BurnPoint[] {
  const seen = new Map<string, BurnPoint>();
  for (const r of rows) {
    const key = localDayKey(r.measured_at);
    const prev = seen.get(key);
    if (!prev || r.measured_at >= prev.t) seen.set(key, { t: r.measured_at, kcal: r.kcal });
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

/**
 * Consecutive calendar days at or above target, counted back from the latest
 * reading.
 *
 * Calendar-consecutive, not consecutive-among-readings, and the difference is
 * the whole honesty of the number. Hit target on Monday, log nothing Tuesday,
 * hit it again Wednesday, and counting readings gives "3 days running" — which
 * asserts something about a Tuesday there is no reading for. A missing day
 * breaks the run.
 *
 * Zero when the latest day fell short, and zero when no target is set, because
 * without one there is no such thing as a run. This is the number most
 * tempting to inflate, so it is the one that gets the strict rule.
 */
export function streak(points: BurnPoint[], goal: number | null): number {
  if (goal === null || goal <= 0 || points.length === 0) return 0;
  let n = 0;
  let expected = dayStartOf(points[points.length - 1].t);
  for (let i = points.length - 1; i >= 0; i--) {
    if (dayStartOf(points[i].t) !== expected) break;
    if (points[i].kcal < goal) break;
    n++;
    expected -= 86_400_000;
  }
  return n;
}

/** Mean of the window, rounded. Null when the window is empty. */
export function average(points: BurnPoint[]): number | null {
  if (points.length === 0) return null;
  return Math.round(points.reduce((s, p) => s + p.kcal, 0) / points.length);
}

/**
 * The top of the axis.
 *
 * Bars are read against zero, so unlike the weight chart the bottom is not
 * negotiable — a burn chart that started at 300 would make a 320 day look
 * like nothing. Only the ceiling is chosen: the tallest bar or the target,
 * whichever is higher, plus headroom, rounded up to a round hundred so the
 * gridline labels are numbers rather than artefacts.
 */
export function ceiling(points: BurnPoint[], goal: number | null): number {
  let peak = goal ?? 0;
  for (const p of points) if (p.kcal > peak) peak = p.kcal;
  if (peak <= 0) return 100;
  return Math.ceil((peak * 1.12) / 100) * 100;
}

/**
 * Thin a series to at most `max` points, keeping the ends.
 *
 * Drops points, never averages or invents them, so every bar is a day
 * somebody recorded. A year of daily bars in 340 device pixels is a smear.
 */
export function thin(points: BurnPoint[], max = 90): BurnPoint[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * How many day slots the chart should lay out for a window.
 *
 * The span of the data, not the span of the range. Ask for a year with a
 * month of readings and 365 slots gives two-pixel splinters jammed against
 * the right margin. Measuring from the first reading keeps the bars legible,
 * and the axis still prints the real dates, so nothing claims a longer
 * history than there is. It does mean 1Y and 1M look the same until there is
 * more than a month to show, which is true.
 */
export function slotsFor(points: BurnPoint[], now: number, min = 7): number {
  if (points.length === 0) return min;
  const days = Math.round((dayStartOf(now) - dayStartOf(points[0].t)) / 86_400_000) + 1;
  return Math.max(min, days);
}

export const BURN_RANGES = [
  { id: '1W', days: 7 },
  { id: '1M', days: 30 },
  { id: '3M', days: 90 },
  { id: '6M', days: 180 },
  { id: '1Y', days: 365 },
] as const;

export type BurnRangeId = (typeof BURN_RANGES)[number]['id'];
