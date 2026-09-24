/**
 * What you logged lately, ready to log again.
 *
 * Most eating repeats. The fastest path to a logged meal is not a better
 * search box — it is the twenty things you actually eat, with the amount you
 * actually had, one tap from the screen.
 *
 * Ordered by how recently you ate it, with the slot you are logging into
 * pulled to the front: at 8am the list should open with breakfast, because
 * that is what 8am is for.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import { normaliseSlot, type SlotId } from './slots';

const db = scopedDb('nutritionist');

export type Recent = {
  /** Stable key for React: dish, measure and amount together. */
  key: string;
  label: string;
  foodId: string | null;
  quantity: number;
  measure: string | null;
  grams: number | null;
  energy: number | null;
  slot: SlotId;
  lastAt: number;
};

/**
 * `limit` is what comes back, not what is read: the query takes a wider slice
 * so that a day of repeating the same three things does not leave the list
 * three items long.
 */
export async function recentItems(
  slot: SlotId | null = null,
  limit = 12,
): Promise<Recent[]> {
  const rows = await db.query<{
    label: string;
    food_id: string | null;
    quantity: number | null;
    unit: string | null;
    net_weight_g: number | null;
    energy_kcal: number | null;
    meal_type: string | null;
    eaten_at: number;
  }>(
    `SELECT i.label, i.food_id, i.quantity, i.unit, i.net_weight_g,
            i.energy_kcal, m.meal_type, m.eaten_at
       FROM meal_items i
       JOIN meals m ON m.id = i.meal_id
      WHERE i.profile_id = ? AND i.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY m.eaten_at DESC
      LIMIT 400`,
    [activeProfile()],
  );

  const seen = new Map<string, Recent>();
  for (const r of rows) {
    const quantity = r.quantity ?? 1;
    const key = `${r.label.toLowerCase()}|${r.unit ?? ''}|${quantity}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      label: r.label,
      foodId: r.food_id,
      quantity,
      measure: r.unit,
      grams: r.net_weight_g,
      energy: r.energy_kcal,
      slot: normaliseSlot(r.meal_type),
      lastAt: r.eaten_at,
    });
  }

  const all = [...seen.values()];
  if (!slot) return all.slice(0, limit);

  // Same slot first, each group still newest-first.
  const mine = all.filter((r) => r.slot === slot);
  const rest = all.filter((r) => r.slot !== slot);
  return [...mine, ...rest].slice(0, limit);
}
