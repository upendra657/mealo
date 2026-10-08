/**
 * Correcting a dish after the fact: its name, what a portion of it contains,
 * what its portions weigh — and, when asked, the entries already logged with
 * it.
 *
 * Until this existed, the only way to fix a dish was to add it again, and the
 * add screen quietly saved over the old one under the old name (see
 * `saveDishFromPortion`). A wrong dish could only be deleted, which loses its
 * correct portions with its wrong numbers.
 *
 * Past entries are a separate question from the dish, and the person answers
 * it each time. A logged item stores its own grams and calories, so a
 * corrected dish changes nothing already eaten unless asked to — which is
 * right when the dish was changed (a new recipe) and wrong when it was
 * mistaken (the same potato, weighed properly). Only the person knows which.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import { deleteCustomFood, dishNamed, rememberAlias, scaleMacros, slugFor, type Food } from './foods';
import type { Per100 } from './import';
import { toMeasure } from './measures';
import {
  deletePortion,
  portionsFor,
  resolvePortion,
  upsertPortion,
  type Anchor,
  type Portion,
} from './portions';

const db = scopedDb('nutritionist');

export type DishEdit = {
  name: string;
  per100: Per100;
  /** The portion the form describes. It becomes the dish's default. */
  portion: { measure: string; quantity: number; netWeightG: number };
  /**
   * The dish's other recorded portions, as the form left them: a new weight,
   * or null for one marked to remove. A portion in the form's own measure is
   * never in here — that one is `portion`.
   */
  others: { id: string; measure: string; quantity: number; netWeightG: number | null }[];
};

/** A dish as the edit screen needs it, or null if it is gone or bundled. */
export async function customFood(id: string): Promise<(Food & { slug: string | null }) | null> {
  const rows = await db.query<Food & { slug: string | null }>(
    `SELECT id, name, 'custom' AS source_db, per_unit, energy_kcal, protein_g,
            fat_g, carbs_g, fibre_g, 1 AS is_custom, slug
       FROM custom_foods WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

export type Entry = {
  id: string;
  quantity: number | null;
  unit: string | null;
  net_weight_g: number | null;
  energy_kcal: number | null;
  eaten_at: number;
};

/**
 * What the selected person has logged with this dish, oldest first.
 *
 * The selected person only. The dish is the household's, but an entry is a
 * record of one body, and correcting her lunch from his phone is not
 * something a dish edit gets to do.
 */
export async function entriesUsing(foodId: string): Promise<Entry[]> {
  return db.query<Entry>(
    `SELECT i.id, i.quantity, i.unit, i.net_weight_g, i.energy_kcal, m.eaten_at
       FROM meal_items i
       JOIN meals m ON m.id = i.meal_id
      WHERE i.profile_id = ? AND i.food_id = ?
        AND i.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY m.eaten_at`,
    [activeProfile(), foodId],
  );
}

/**
 * The anchors the dish will have once this edit is saved.
 *
 * Pure, so the preview on the confirm sheet is worked out from exactly what
 * `saveDishEdit` is about to write — the "390 Cal with the new data" has to be
 * the number the entries actually become. A weight-kind measure is not an
 * anchor (100 g of a dish says nothing about its katori), so it is left out,
 * as the add screen leaves it out.
 */
export function anchorsAfter(edit: DishEdit): Anchor[] {
  const out: Anchor[] = [];
  const m = toMeasure(edit.portion.measure);
  if (m && m.kind !== 'weight') {
    out.push({
      measure: m.id,
      quantity: edit.portion.quantity > 0 ? edit.portion.quantity : 1,
      net_weight_g: edit.portion.netWeightG,
      is_default: 1,
    });
  }
  for (const o of edit.others) {
    if (o.netWeightG === null || !(o.netWeightG > 0)) continue;
    if (o.measure === m?.id) continue;
    out.push({ measure: o.measure, quantity: o.quantity, net_weight_g: o.netWeightG, is_default: 0 });
  }
  return out;
}

/**
 * One past entry, worked out again from the corrected dish.
 *
 * The quantity and measure are what the person said and are kept; the grams
 * are the app's arithmetic from them and are redone. So "1 piece" logged at
 * the old 100 g becomes the corrected 75 g, while "120 g" stays 120 g and only
 * its calories change.
 */
export function recalcEntry(
  entry: Pick<Entry, 'quantity' | 'unit'>,
  per100: Per100,
  anchors: Anchor[],
): { net_weight_g: number } & Per100 {
  const grams = resolvePortion(entry.quantity, entry.unit, anchors).grams;
  return { net_weight_g: grams, ...scaleMacros({ ...per100 } as Food, grams) };
}

export type EntriesPreview = {
  count: number;
  from: number | null;
  to: number | null;
  kcalNow: number;
  kcalNew: number;
};

/** What "update past entries" would do, for the sheet that asks. */
export function previewEntries(entries: Entry[], edit: DishEdit): EntriesPreview {
  const anchors = anchorsAfter(edit);
  let kcalNow = 0;
  let kcalNew = 0;
  for (const e of entries) {
    kcalNow += e.energy_kcal ?? 0;
    kcalNew += recalcEntry(e, edit.per100, anchors).energy_kcal ?? 0;
  }
  return {
    count: entries.length,
    from: entries[0]?.eaten_at ?? null,
    to: entries[entries.length - 1]?.eaten_at ?? null,
    kcalNow: Math.round(kcalNow),
    kcalNew: Math.round(kcalNew),
  };
}

export type EditResult = {
  food: Food | null;
  /** Another dish already has this name; nothing was written. */
  clash?: Food;
  /** Past entries rewritten. */
  updated: number;
};

/**
 * Save a corrected dish, and its past entries if `updateEntries`.
 *
 * A rename that keeps the slug ("Boiled potato - small" → "Boiled potato
 * (small)") is just a new name on the same row. A rename that changes it is a
 * change of identity, because sync merges dishes on the slug: sent as it is,
 * the other phone would take the new slug for a new dish and keep the old one
 * beside it. So the old slug is left behind as a tombstone — a deleted row
 * carrying it, which the other phone applies to its own copy — and the
 * dish's portions and aliases are re-stamped so they travel again under the
 * new slug. The row itself keeps its id, so every entry on this phone still
 * points at it.
 */
export async function saveDishEdit(
  foodId: string,
  edit: DishEdit,
  updateEntries: boolean,
): Promise<EditResult> {
  const current = await customFood(foodId);
  if (!current) return { food: null, updated: 0 };

  const name = edit.name.trim();
  const clash = await dishNamed(name);
  if (clash && clash.id !== foodId) return { food: null, clash, updated: 0 };

  const slug = slugFor(name);
  const oldSlug = current.slug || slugFor(current.name);
  const moved = slug !== oldSlug;

  if (moved) {
    await db.insert('custom_foods', {
      name: current.name,
      slug: oldSlug,
      per_unit: '100g',
      energy_kcal: current.energy_kcal,
      protein_g: current.protein_g,
      fat_g: current.fat_g,
      carbs_g: current.carbs_g,
      fibre_g: current.fibre_g,
      notes: null,
      deleted_at: Date.now(),
    });
  }

  await db.update('custom_foods', foodId, { name, slug, per_unit: '100g', ...edit.per100 });

  const before = new Map<string, Portion>((await portionsFor(foodId)).map((p) => [p.id, p]));
  for (const o of edit.others) {
    const was = before.get(o.id);
    if (!was) continue;
    if (o.netWeightG === null) {
      await deletePortion(o.id);
    } else if (o.netWeightG > 0 && o.netWeightG !== was.net_weight_g) {
      // Typed by a person, so it is a measurement now, whatever it was.
      await upsertPortion({
        foodId,
        measure: o.measure,
        quantity: o.quantity,
        netWeightG: o.netWeightG,
        source: 'user',
      });
    }
  }
  const m = toMeasure(edit.portion.measure);
  if (m && m.kind !== 'weight') {
    await upsertPortion({
      foodId,
      measure: m.id,
      quantity: edit.portion.quantity,
      netWeightG: edit.portion.netWeightG,
      isDefault: true,
      source: 'user',
    });
  }

  // Aliases are the reason. Saving the default portion already re-stamps all
  // of a dish's portions (setDefaultPortion), but not when the form describes
  // a weight, and never its aliases — and an alias left behind keeps pointing
  // the other phone's "aloo jeera" at the copy the tombstone just deleted.
  if (moved) {
    const t = Date.now();
    await db.run(
      'UPDATE food_portions SET updated_at = ? WHERE food_id = ? AND deleted_at IS NULL',
      [t, foodId],
    );
    await db.run(
      'UPDATE food_aliases SET updated_at = ? WHERE food_id = ? AND deleted_at IS NULL',
      [t, foodId],
    );
  }
  await rememberAlias(name, foodId);

  let updated = 0;
  if (updateEntries) {
    // The anchors as saved, not as previewed — the same thing by
    // construction, and the e2e run checks that it stays so.
    const anchors = await portionsFor(foodId);
    for (const e of await entriesUsing(foodId)) {
      await db.update('meal_items', e.id, {
        label: name,
        ...recalcEntry(e, edit.per100, anchors),
      });
      updated++;
    }
  }

  return { food: await customFood(foodId), updated };
}

/** Out of the shared table on both phones. Logged entries keep their numbers. */
export async function deleteDish(foodId: string): Promise<void> {
  await deleteCustomFood(foodId);
}
