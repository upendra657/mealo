/**
 * The Nutritionist's domain operations.
 *
 * Two ways to record a meal, both first-class:
 *
 *   text    "2 roti, dal tadka, dahi" — parsed locally, matched against the
 *           bundled tables, and only sent to the model when matching fails.
 *
 *   direct  protein / fat / carbs / fibre typed straight off a label. No
 *           matching, no model, no argument. For packaged food and whey this
 *           is faster and more accurate than any lookup.
 *
 * `source` on every item records which path produced the numbers. A 'direct'
 * row is something the user read off a packet, and must never be overwritten
 * by a later table match.
 */

import { scopedDb } from '../db/scope';
import {
  matchFood,
  parseMealText,
  rememberAlias,
  scaleMacros,
  type Food,
} from './foods';

const db = scopedDb('nutritionist');

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type ItemSource = 'direct' | 'matched' | 'model';

export type Meal = {
  id: string;
  eaten_at: number;
  raw_text: string | null;
  meal_type: string | null;
  updated_at: number;
  deleted_at: number | null;
};

export type MealItem = {
  id: string;
  meal_id: string;
  label: string;
  food_id: string | null;
  quantity: number | null;
  unit: string | null;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
  source: ItemSource;
  updated_at: number;
  deleted_at: number | null;
};

export type Macros = {
  energy_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fibre_g: number;
};

export const ZERO: Macros = {
  energy_kcal: 0,
  protein_g: 0,
  fat_g: 0,
  carbs_g: 0,
  fibre_g: 0,
};

/** A parsed item plus whatever the matcher found for it, pre-confirmation. */
export type DraftItem = {
  label: string;
  quantity: number | null;
  unit: string | null;
  food: Food | null;
  /** Assumed grams when the reference is per-100g and no weight was given. */
  grams: number;
  matchScore: number;
  source: ItemSource;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
};

export function startOfToday(d = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function guessMealType(d = new Date()): MealType {
  const h = d.getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

/**
 * Default portion in grams.
 *
 * Honest about what it is: a starting number the user can correct, not a
 * measurement. Shown in the UI as an editable field for exactly that reason.
 */
function defaultGrams(unit: string | null, quantity: number | null): number {
  const q = quantity ?? 1;
  switch (unit) {
    case 'g':
    case 'gram':
      return q;
    case 'kg':
      return q * 1000;
    case 'ml':
      return q;
    case 'l':
    case 'litre':
    case 'liter':
      return q * 1000;
    case 'cup':
    case 'cups':
    case 'glass':
    case 'glasses':
      return q * 200;
    case 'bowl':
    case 'bowls':
    case 'katori':
      return q * 150;
    case 'tbsp':
    case 'tablespoon':
      return q * 15;
    case 'tsp':
    case 'teaspoon':
      return q * 5;
    case 'scoop':
    case 'scoops':
      return q * 30;
    default:
      return q * 100;
  }
}

// ------------------------------------------------------------- drafting

/** Turn typed text into draft items, using local matching only. */
export async function draftFromText(text: string): Promise<DraftItem[]> {
  const parsed = parseMealText(text);
  const out: DraftItem[] = [];

  for (const p of parsed) {
    const match = await matchFood(p.label);
    const grams = defaultGrams(p.unit, p.quantity);

    if (match) {
      const macros = scaleMacros(match.food, grams);
      out.push({
        label: p.label,
        quantity: p.quantity,
        unit: p.unit,
        food: match.food,
        grams,
        matchScore: match.score,
        source: 'matched',
        ...macros,
      });
    } else {
      out.push({
        label: p.label,
        quantity: p.quantity,
        unit: p.unit,
        food: null,
        grams,
        matchScore: 0,
        source: 'direct',
        energy_kcal: null,
        protein_g: null,
        fat_g: null,
        carbs_g: null,
        fibre_g: null,
      });
    }
  }
  return out;
}

/** How many items in a draft resolved locally — the Phase 2 exit metric. */
export function localHitRate(items: DraftItem[]): number {
  if (items.length === 0) return 0;
  return items.filter((i) => i.food !== null).length / items.length;
}

// ------------------------------------------------------------- writes

export async function saveMeal(
  items: DraftItem[],
  opts: { rawText?: string | null; mealType?: MealType; eatenAt?: number } = {},
): Promise<string> {
  const mealId = await db.insert('meals', {
    eaten_at: opts.eatenAt ?? Date.now(),
    raw_text: opts.rawText ?? null,
    meal_type: opts.mealType ?? guessMealType(),
    deleted_at: null,
  });

  for (const it of items) {
    await db.insert('meal_items', {
      meal_id: mealId,
      label: it.label,
      food_id: it.food?.id ?? null,
      quantity: it.quantity,
      unit: it.unit,
      energy_kcal: it.energy_kcal,
      protein_g: it.protein_g,
      fat_g: it.fat_g,
      carbs_g: it.carbs_g,
      fibre_g: it.fibre_g,
      source: it.source,
      deleted_at: null,
    });
    // Only learn from matches the user kept.
    if (it.food && it.source === 'matched') {
      await rememberAlias(it.label, it.food.id);
    }
  }
  return mealId;
}

export async function deleteMeal(id: string): Promise<void> {
  await db.softDelete('meals', id);
  const items = await db.query<{ id: string }>(
    'SELECT id FROM meal_items WHERE meal_id = ? AND deleted_at IS NULL',
    [id],
  );
  for (const i of items) await db.softDelete('meal_items', i.id);
}

// ------------------------------------------------------------- reads

export async function mealsOn(dayStart = startOfToday()): Promise<Meal[]> {
  return db.query<Meal>(
    `SELECT * FROM meals
      WHERE deleted_at IS NULL AND eaten_at >= ? AND eaten_at < ?
      ORDER BY eaten_at DESC`,
    [dayStart, dayStart + 86_400_000],
  );
}

export async function itemsFor(mealIds: string[]): Promise<MealItem[]> {
  if (mealIds.length === 0) return [];
  const holes = mealIds.map(() => '?').join(',');
  return db.query<MealItem>(
    `SELECT * FROM meal_items
      WHERE deleted_at IS NULL AND meal_id IN (${holes})`,
    mealIds,
  );
}

export function totalMacros(items: MealItem[]): Macros {
  return items.reduce<Macros>(
    (acc, i) => ({
      energy_kcal: acc.energy_kcal + (i.energy_kcal ?? 0),
      protein_g: acc.protein_g + (i.protein_g ?? 0),
      fat_g: acc.fat_g + (i.fat_g ?? 0),
      carbs_g: acc.carbs_g + (i.carbs_g ?? 0),
      fibre_g: acc.fibre_g + (i.fibre_g ?? 0),
    }),
    { ...ZERO },
  );
}

/** True when any item is missing numbers — the totals are then a floor. */
export function hasGaps(items: MealItem[]): boolean {
  return items.some((i) => i.energy_kcal === null);
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}
