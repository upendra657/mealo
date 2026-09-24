/**
 * Daily targets, per person.
 *
 * Every field is nullable and stays that way until someone types a number.
 * A missing target renders as a grey bar rather than a percentage, because
 * "68% of a goal you never set" is a fabricated judgement, and this app does
 * not make those. Nothing here derives a target from height, weight or
 * activity either — that would be a health recommendation.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';

const db = scopedDb('nutritionist');

export type Targets = {
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
};

export const NO_TARGETS: Targets = {
  energy_kcal: null,
  protein_g: null,
  fat_g: null,
  carbs_g: null,
  fibre_g: null,
};

export type TargetKey = keyof Targets;

export const TARGET_FIELDS: { key: TargetKey; label: string; unit: string }[] = [
  { key: 'energy_kcal', label: 'Calories', unit: 'Cal' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'fat_g', label: 'Fats', unit: 'g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g' },
];

export async function loadTargets(
  profileId = activeProfile(),
): Promise<Targets> {
  const rows = await db.query<Targets>(
    `SELECT energy_kcal, protein_g, fat_g, carbs_g, fibre_g
       FROM targets WHERE id = ? AND deleted_at IS NULL`,
    [profileId],
  );
  return rows[0] ?? { ...NO_TARGETS };
}

export async function saveTargets(
  patch: Partial<Targets>,
  profileId = activeProfile(),
): Promise<Targets> {
  const current = await loadTargets(profileId);
  const next: Targets = { ...current, ...patch };

  const exists = await db.query<{ id: string }>(
    'SELECT id FROM targets WHERE id = ?',
    [profileId],
  );
  if (exists[0]) {
    await db.update('targets', profileId, { ...next, deleted_at: null });
  } else {
    await db.insert('targets', { id: profileId, ...next, deleted_at: null });
  }
  return next;
}

/**
 * Where a number sits against its target.
 *
 * Over is only bad for the things where over is bad. Eating 61g of fibre
 * against a 30g target is not a failure, and colouring it red teaches you to
 * eat less of the thing you were trying to eat more of.
 */
export type Standing = 'unset' | 'empty' | 'low' | 'good' | 'over';

export function standing(
  consumed: number,
  target: number | null,
  overIsBad: boolean,
): { standing: Standing; pct: number | null } {
  if (!target || target <= 0) return { standing: 'unset', pct: null };
  const pct = Math.round((consumed / target) * 100);
  if (consumed <= 0) return { standing: 'empty', pct: 0 };
  if (pct > 100) return { standing: overIsBad ? 'over' : 'good', pct };
  if (pct >= 76) return { standing: 'good', pct };
  return { standing: 'low', pct };
}

/** Which macros it is bad to exceed. Protein and fibre are not among them. */
export const OVER_IS_BAD: Record<TargetKey, boolean> = {
  energy_kcal: true,
  protein_g: false,
  fat_g: true,
  carbs_g: true,
  fibre_g: false,
};
