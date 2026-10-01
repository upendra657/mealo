/**
 * Weight, entered by hand.
 *
 * One reading a day is the shape this assumes. Weighing twice in a morning is
 * normal and neither number is more true than the other, so a second entry for
 * the same local day replaces the first rather than stacking up — the chart
 * plots days, not events, and two dots on one date would imply a precision the
 * scale does not have.
 *
 * Read through the Doctor's handle: a body measurement belongs to the agent
 * that reasons about bodies. The Nutritionist can read it (db/scope.ts) because
 * the home banner speaks in its voice, but it cannot write one.
 *
 * The arithmetic below — bucketing, filling, trend — is pure and lives apart
 * from the queries so it can be tested in node. Everything the chart draws
 * comes from rows that exist; nothing here invents a point to make a line look
 * continuous.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import { localDayKey } from './day';

const db = scopedDb('doctor');

export type Weight = {
  id: string;
  measured_at: number;
  kg: number;
  note: string | null;
};

/** Local midnight for a timestamp. */
export function dayStartOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Whole local days between two instants.
 *
 * Bucketed to midnight before subtracting, so 11pm Monday to 1am Tuesday is
 * one day rather than zero. Rounded because a DST change makes one of those
 * days 23 or 25 hours long and a bare division would come back 0.96.
 *
 * Lives here beside dayStartOf, and the burn screen imports it from here, so
 * the two screens can never drift on what "three days ago" means.
 */
export function daysBetween(a: number, b: number): number {
  return Math.round(Math.abs(dayStartOf(b) - dayStartOf(a)) / 86_400_000);
}

/**
 * How a delta names the span it covers.
 *
 * The whole point of showing an older reading is that the comparison stops
 * being overnight, and a bare "−0.35" would still be read as overnight. So
 * every delta says what it spans.
 *
 * A single day gets a name rather than a count, and which name depends on
 * which card is speaking: from today, one day back is yesterday; from the
 * previous reading, one day back is the day before it. Saying "on yesterday"
 * on the Previous card would point at the wrong day.
 */
export function spanLabel(days: number, from: 'today' | 'previous'): string {
  if (days !== 1) return `over ${days} days`;
  return from === 'today' ? 'on yesterday' : 'on the day before';
}

/** "26 Sep · 4 days ago", for the Previous card. Empty when there is none. */
export function whenLabel(measuredAt: number, now = Date.now()): string {
  const n = daysBetween(measuredAt, now);
  const date = new Date(measuredAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  const rel = n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  return `${date} · ${rel}`;
}

// ------------------------------------------------------------- writes

/**
 * Record a weight for the local day `measuredAt` falls in, replacing any
 * reading already there.
 */
export async function recordWeight(
  kg: number,
  measuredAt = Date.now(),
  note: string | null = null,
): Promise<string> {
  const from = dayStartOf(measuredAt);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL
        AND measured_at >= ? AND measured_at < ?
      LIMIT 1`,
    [activeProfile(), from, from + 86_400_000],
  );
  if (existing[0]) {
    await db.update('weights', existing[0].id, { kg, measured_at: measuredAt, note });
    return existing[0].id;
  }
  return db.insert('weights', { kg, measured_at: measuredAt, note, deleted_at: null });
}

export async function deleteWeight(id: string): Promise<void> {
  await db.softDelete('weights', id);
}

// -------------------------------------------------------------- reads

/** Every reading, oldest first. */
export async function allWeights(): Promise<Weight[]> {
  return db.query<Weight>(
    `SELECT id, measured_at, kg, note FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL
      ORDER BY measured_at ASC`,
    [activeProfile()],
  );
}

/** Readings on or after `fromMs`, oldest first. */
export async function weightsSince(fromMs: number): Promise<Weight[]> {
  return db.query<Weight>(
    `SELECT id, measured_at, kg, note FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL AND measured_at >= ?
      ORDER BY measured_at ASC`,
    [activeProfile(), fromMs],
  );
}

/** The most recent reading, or null. */
export async function latestWeight(): Promise<Weight | null> {
  const rows = await db.query<Weight>(
    `SELECT id, measured_at, kg, note FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL
      ORDER BY measured_at DESC LIMIT 1`,
    [activeProfile()],
  );
  return rows[0] ?? null;
}

/**
 * The most recent readings strictly before a local day, newest first.
 *
 * This replaces asking for `today − 1 day` and `today − 2 days`. A fixed
 * offset is a question about an address rather than about the data: skip a
 * morning and there is nothing at that address, so the card went blank even
 * though a perfectly good reading sat a day further back.
 *
 * Two is what the screen needs — one to show, one to measure it against.
 */
export async function lastBefore(dayStart: number, limit = 2): Promise<Weight[]> {
  return db.query<Weight>(
    `SELECT id, measured_at, kg, note FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL AND measured_at < ?
      ORDER BY measured_at DESC LIMIT ?`,
    [activeProfile(), dayStart, limit],
  );
}

/** The reading for one local day, or null. */
export async function weightOn(dayStart: number): Promise<Weight | null> {
  const rows = await db.query<Weight>(
    `SELECT id, measured_at, kg, note FROM weights
      WHERE profile_id = ? AND deleted_at IS NULL
        AND measured_at >= ? AND measured_at < ?
      LIMIT 1`,
    [activeProfile(), dayStart, dayStart + 86_400_000],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------- the goal

/**
 * The weight this person is aiming at, if they set one.
 *
 * Lives on `targets` beside the macro goals. Read through the Nutritionist's
 * handle because that is the table's owner; nothing computes it.
 */
const targetsDb = scopedDb('nutritionist');

export async function goalWeight(): Promise<number | null> {
  const rows = await targetsDb.query<{ weight_kg: number | null }>(
    'SELECT weight_kg FROM targets WHERE id = ? AND deleted_at IS NULL',
    [activeProfile()],
  );
  return rows[0]?.weight_kg ?? null;
}

export async function setGoalWeight(kg: number | null): Promise<void> {
  const id = activeProfile();
  const exists = await targetsDb.query<{ id: string }>(
    'SELECT id FROM targets WHERE id = ?',
    [id],
  );
  if (exists[0]) await targetsDb.update('targets', id, { weight_kg: kg });
  else await targetsDb.insert('targets', { id, weight_kg: kg, deleted_at: null });
}

// --------------------------------------------------------- pure helpers

export type Point = { t: number; kg: number };

/**
 * One point per local day, newest reading winning within a day.
 *
 * Days without a reading are simply absent. Carrying the last value forward
 * would draw a flat line through a week nobody stood on a scale, which reads
 * as data and is not.
 */
export function byDay(rows: { measured_at: number; kg: number }[]): Point[] {
  const seen = new Map<string, Point>();
  for (const r of rows) {
    const key = localDayKey(r.measured_at);
    const prev = seen.get(key);
    if (!prev || r.measured_at >= prev.t) seen.set(key, { t: r.measured_at, kg: r.kg });
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

/**
 * Thin a series to at most `max` points, always keeping the ends.
 *
 * A year of daily readings in 340 device pixels is a smear. Sampling keeps the
 * shape honest — it drops points, it never invents or averages them, so every
 * dot the chart draws is a number someone actually recorded.
 */
export function thin(points: Point[], max = 90): Point[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Movement across a window, as first-to-last.
 *
 * Deliberately the two ends rather than a regression: a fitted slope over a
 * handful of noisy bathroom readings implies a confidence the scale has not
 * earned. Null when there is nothing honest to say — fewer than two readings,
 * less than three days apart, or under 300g of movement, which is water.
 */
export function trendOver(points: Point[]): { delta: number; days: number } | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const days = Math.round((last.t - first.t) / 86_400_000);
  if (days < 3) return null;
  const delta = Math.round((last.kg - first.kg) * 10) / 10;
  if (Math.abs(delta) < 0.3) return null;
  return { delta, days };
}

/** Nice round bounds for an axis, with headroom, including the goal if set. */
export function bounds(points: Point[], goal: number | null): { lo: number; hi: number } {
  const vals = points.map((p) => p.kg);
  if (goal !== null) vals.push(goal);
  if (vals.length === 0) return { lo: 0, hi: 1 };
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max(0.35, (hi - lo) * 0.18);
  lo -= pad;
  hi += pad;
  if (hi - lo < 0.5) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.25;
    hi = mid + 0.25;
  }
  return { lo, hi };
}

export const RANGES = [
  { id: '1W', days: 7 },
  { id: '1M', days: 30 },
  { id: '3M', days: 90 },
  { id: '6M', days: 180 },
  { id: '1Y', days: 365 },
] as const;

export type RangeId = (typeof RANGES)[number]['id'];
