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
import { activeProfile } from '../lib/active-profile';
import {
  matchFood,
  parseMealText,
  rememberAlias,
  scaleMacros,
  type Food,
} from './foods';
import { toMeasure } from './measures';
import { guessSlot, type SlotId } from './slots';
import {
  resolveFor,
  upsertPortion,
  type Basis,
  type Resolution,
} from './portions';

const db = scopedDb('nutritionist');

/** The day has six slots now; see domain/slots.ts. */
export type MealType = SlotId;
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
  net_weight_g: number | null;
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
  /** Canonical measure id — see domain/measures.ts. */
  unit: string | null;
  food: Food | null;
  /** Net weight this portion works out to. */
  grams: number;
  /** How that weight was arrived at, so the UI can be honest about it. */
  basis: Basis;
  portionNote: string;
  /** False when the grams came from a generic table rather than this dish. */
  portionMeasured: boolean;
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

export const guessMealType = guessSlot;

// ------------------------------------------------------------- drafting

function withPortion(
  base: Omit<
    DraftItem,
    'grams' | 'basis' | 'portionNote' | 'portionMeasured' | 'unit'
  >,
  res: Resolution,
): DraftItem {
  return {
    ...base,
    unit: res.measure,
    grams: res.grams,
    basis: res.basis,
    portionNote: res.note,
    portionMeasured: res.measured,
  };
}

/** Turn typed text into draft items, using local matching only. */
export async function draftFromText(text: string): Promise<DraftItem[]> {
  const parsed = parseMealText(text);
  const out: DraftItem[] = [];

  for (const p of parsed) {
    const match = await matchFood(p.label);
    // The weight comes from the dish's own recorded portions when it has any,
    // and only falls back to a household size when it has none. This is the
    // difference between "2 roti" meaning 80g and meaning 200g.
    const res = await resolveFor(match?.food.id ?? null, p.quantity, p.unit);

    if (match) {
      out.push(
        withPortion(
          {
            label: p.label,
            quantity: p.quantity,
            food: match.food,
            matchScore: match.score,
            source: 'matched',
            ...scaleMacros(match.food, res.grams),
          },
          res,
        ),
      );
    } else {
      out.push(
        withPortion(
          {
            label: p.label,
            quantity: p.quantity,
            food: null,
            matchScore: 0,
            source: 'direct',
            energy_kcal: null,
            protein_g: null,
            fat_g: null,
            carbs_g: null,
            fibre_g: null,
          },
          res,
        ),
      );
    }
  }
  return out;
}

/**
 * Recompute one draft row after the user changed its quantity, measure or
 * matched dish. The single place that keeps grams and macros consistent.
 */
export async function repriceItem(
  item: DraftItem,
  change: { quantity?: number | null; unit?: string | null; food?: Food | null },
): Promise<DraftItem> {
  const food = change.food !== undefined ? change.food : item.food;
  const quantity = change.quantity !== undefined ? change.quantity : item.quantity;
  const unit = change.unit !== undefined ? change.unit : item.unit;

  const res = await resolveFor(food?.id ?? null, quantity, unit);
  const macros = food
    ? scaleMacros(food, res.grams)
    : {
        energy_kcal: item.energy_kcal,
        protein_g: item.protein_g,
        fat_g: item.fat_g,
        carbs_g: item.carbs_g,
        fibre_g: item.fibre_g,
      };

  return withPortion(
    {
      label: item.label,
      quantity,
      food,
      matchScore: food ? (change.food !== undefined ? 1 : item.matchScore) : 0,
      source: food ? 'matched' : item.source,
      ...macros,
    },
    res,
  );
}

/** Grams edited by hand — keep the number, drop the claim about where it came from. */
export function withManualGrams(item: DraftItem, grams: number): DraftItem {
  return {
    ...item,
    grams,
    basis: 'weight',
    portionNote: `${grams}g, set by hand`,
    portionMeasured: true,
    ...(item.food ? scaleMacros(item.food, grams) : {}),
  };
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
      // The dish's own name when one matched: the typed words are already
      // kept on the meal as raw_text, and a row reading "teacup filter
      // coffee" is the parser's working, not what you ate.
      label: it.food?.name ?? it.label,
      food_id: it.food?.id ?? null,
      quantity: it.quantity,
      unit: it.unit,
      net_weight_g: it.grams,
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
    // Learn the portion, but only from a weight the user actually set. A
    // household guess the app made must never come back as "your katori" —
    // that would launder an assumption into a measurement. `basis === 'weight'`
    // means the grams were typed, not derived.
    //
    // Saved as 'derived', which upsertPortion will not let overwrite anything
    // measured, so a real figure always wins and never the other way round.
    const measure = it.unit ? toMeasure(it.unit) : null;
    if (
      it.food &&
      measure &&
      measure.kind !== 'weight' &&
      it.basis === 'weight' &&
      it.grams > 0 &&
      it.quantity &&
      it.quantity > 0
    ) {
      await upsertPortion({
        foodId: it.food.id,
        measure: measure.id,
        quantity: it.quantity,
        netWeightG: it.grams,
        source: 'derived',
      });
    }
  }
  return mealId;
}

/**
 * Remove one item. The meal it belonged to is removed too if that empties it,
 * so the day never shows a heading with nothing under it.
 */
export async function deleteMealItem(itemId: string): Promise<void> {
  const rows = await db.query<{ meal_id: string }>(
    `SELECT meal_id FROM meal_items
      WHERE id = ? AND profile_id = ? AND deleted_at IS NULL`,
    [itemId, activeProfile()],
  );
  await db.softDelete('meal_items', itemId);
  const mealId = rows[0]?.meal_id;
  if (!mealId) return;
  const left = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM meal_items
      WHERE meal_id = ? AND profile_id = ? AND deleted_at IS NULL`,
    [mealId, activeProfile()],
  );
  if (Number(left[0]?.n ?? 0) === 0) await db.softDelete('meals', mealId);
}

/** Correct an item in place — the amount changed, not what was eaten. */
export async function updateMealItem(
  itemId: string,
  item: DraftItem,
): Promise<void> {
  await db.update('meal_items', itemId, {
    label: item.label,
    food_id: item.food?.id ?? null,
    quantity: item.quantity,
    unit: item.unit,
    net_weight_g: item.grams,
    energy_kcal: item.energy_kcal,
    protein_g: item.protein_g,
    fat_g: item.fat_g,
    carbs_g: item.carbs_g,
    fibre_g: item.fibre_g,
    source: item.source,
    deleted_at: null,
  });
}

/** Move an item's meal into a different slot. */
export async function setMealSlot(
  mealId: string,
  mealType: MealType,
): Promise<void> {
  await db.update('meals', mealId, { meal_type: mealType });
}

export async function deleteMeal(id: string): Promise<void> {
  await db.softDelete('meals', id);
  const items = await db.query<{ id: string }>(
    `SELECT id FROM meal_items
      WHERE meal_id = ? AND profile_id = ? AND deleted_at IS NULL`,
    [id, activeProfile()],
  );
  for (const i of items) await db.softDelete('meal_items', i.id);
}

// ------------------------------------------------------------- reads

export async function mealsOn(dayStart = startOfToday()): Promise<Meal[]> {
  return db.query<Meal>(
    `SELECT * FROM meals
      WHERE profile_id = ? AND deleted_at IS NULL
        AND eaten_at >= ? AND eaten_at < ?
      ORDER BY eaten_at DESC`,
    [activeProfile(), dayStart, dayStart + 86_400_000],
  );
}

export async function itemsFor(mealIds: string[]): Promise<MealItem[]> {
  if (mealIds.length === 0) return [];
  const holes = mealIds.map(() => '?').join(',');
  return db.query<MealItem>(
    `SELECT * FROM meal_items
      WHERE profile_id = ? AND deleted_at IS NULL AND meal_id IN (${holes})`,
    [activeProfile(), ...mealIds],
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
