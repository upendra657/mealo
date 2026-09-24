/**
 * A day, read back.
 *
 * The dashboard asks "how am I doing"; insights asks "because of what". Both
 * questions come off the same rows, so both are answered here rather than in
 * two components that could drift apart on what counts as a total.
 *
 * Everything is arithmetic over what is stored. No estimates, no filling in
 * of gaps: an item logged with no calories contributes nothing and makes the
 * day's total a floor, which `hasGaps` reports so the UI can say so.
 */

import {
  itemsFor,
  mealRange,
  mealsOn,
  startOfToday,
  type Meal,
  type MealItem,
} from './meals';
import { normaliseSlot, SLOTS, type SlotId } from './slots';

/** kcal, protein, fat, carbs, fibre — in that order, everywhere. */
export type Macros = [number, number, number, number, number];

export const MACRO_LABELS = ['Calories', 'Protein', 'Fats', 'Carbs', 'Fibre'];

/** Which index in a Macros tuple each macro sits at. */
export const KCAL = 0;

const r1 = (n: number) => Math.round(n * 10) / 10;

export function zero(): Macros {
  return [0, 0, 0, 0, 0];
}

export function macrosOf(item: MealItem): Macros {
  return [
    item.energy_kcal ?? 0,
    item.protein_g ?? 0,
    item.fat_g ?? 0,
    item.carbs_g ?? 0,
    item.fibre_g ?? 0,
  ];
}

export function add(a: Macros, b: Macros): Macros {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4]];
}

export function round(m: Macros): Macros {
  return [r1(m[0]), r1(m[1]), r1(m[2]), r1(m[3]), r1(m[4])];
}

export type SlotGroup = {
  slot: SlotId;
  meals: Meal[];
  items: MealItem[];
  macros: Macros;
};

export type DayView = {
  dayStart: number;
  items: MealItem[];
  /** Only the slots that actually have something in them, in day order. */
  groups: SlotGroup[];
  totals: Macros;
  /** True when an item carries no calories, so the totals are a floor. */
  hasGaps: boolean;
};

export async function readDay(dayStart = startOfToday()): Promise<DayView> {
  const meals = await mealsOn(dayStart);
  const items = await itemsFor(meals.map((m) => m.id));

  const slotOf = new Map<string, SlotId>();
  for (const m of meals) slotOf.set(m.id, normaliseSlot(m.meal_type));

  const groups: SlotGroup[] = [];
  for (const s of SLOTS) {
    const mine = meals.filter((m) => slotOf.get(m.id) === s.id);
    if (!mine.length) continue;
    const ids = new Set(mine.map((m) => m.id));
    const its = items.filter((i) => ids.has(i.meal_id));
    if (!its.length && !mine.length) continue;
    groups.push({
      slot: s.id,
      meals: mine,
      items: its,
      macros: round(its.map(macrosOf).reduce(add, zero())),
    });
  }

  return {
    dayStart,
    items,
    groups,
    totals: round(items.map(macrosOf).reduce(add, zero())),
    hasGaps: items.some((i) => i.energy_kcal === null),
  };
}

export type Contributor = {
  label: string;
  foodId: string | null;
  value: number;
  grams: number;
  times: number;
  /** Share of the day's total for this macro, 0-100. */
  share: number;
};

/**
 * Which dishes drove one macro today, biggest first.
 *
 * Grouped by the food they resolved to, falling back to the written label for
 * anything unmatched, so "2 roti" logged twice reads as one line rather than
 * two. Shares are of what was logged, not of the target: a dish can be a third
 * of today's protein on a day that came nowhere near the goal.
 */
export function contributors(view: DayView, macro: number): Contributor[] {
  const acc = new Map<string, Contributor>();
  for (const item of view.items) {
    const value = macrosOf(item)[macro];
    if (value <= 0) continue;
    const key = item.food_id ?? `label:${item.label.toLowerCase()}`;
    const row = acc.get(key) ?? {
      label: item.label,
      foodId: item.food_id,
      value: 0,
      grams: 0,
      times: 0,
      share: 0,
    };
    row.value += value;
    row.grams += item.net_weight_g ?? 0;
    row.times += 1;
    acc.set(key, row);
  }

  const rows = [...acc.values()];
  const sum = rows.reduce((a, r) => a + r.value, 0);
  for (const r of rows) {
    r.value = r1(r.value);
    r.grams = r1(r.grams);
    r.share = sum > 0 ? Math.round((r.value / sum) * 100) : 0;
  }
  return rows.sort((a, b) => b.value - a.value);
}

/**
 * How a meal's calories split across protein, fat and carbs.
 *
 * By energy, not by grams: a gram of fat carries 9 calories and a gram of
 * carbohydrate 4, so a bar drawn from raw grams shows fat as a sliver of a
 * meal it actually dominates. Returns three fractions that sum to 1, or null
 * when there is nothing to split.
 */
export function energySplit(m: Macros): [number, number, number] | null {
  const parts = [m[1] * 4, m[2] * 9, m[3] * 4];
  const total = parts[0] + parts[1] + parts[2];
  if (total <= 0) return null;
  return [parts[0] / total, parts[1] / total, parts[2] / total];
}

/**
 * A day as "YYYY-MM-DD" in local time.
 *
 * Deliberately not toISOString().slice(0,10), which is UTC: at +05:30 a meal
 * eaten at half past midnight is the previous day in UTC, so the calendar
 * would put the dot under the wrong square.
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which days in a range have anything logged.
 *
 * The bucketing happens here rather than in SQL for the same reason as above:
 * SQLite's DATE(ts/1000,'unixepoch') is UTC and has no idea what timezone the
 * person eats in. A month of timestamps is a handful of rows, so reading them
 * and grouping in local time costs nothing and is right everywhere.
 */
export async function loggedDays(
  fromMs: number,
  toMs: number,
): Promise<Set<string>> {
  const rows = await mealRange(fromMs, toMs);
  const out = new Set<string>();
  for (const r of rows) out.add(localDayKey(r.eaten_at));
  return out;
}

/** Local midnight for a day offset from today. Negative is the past. */
export function dayAt(offset: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}
