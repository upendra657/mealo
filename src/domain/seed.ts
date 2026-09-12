/**
 * Seeds the bundled food reference table into SQLite.
 *
 * `foods` is reference data, not user data: it ships with the app, is never
 * synced, and is safe to wipe and rewrite. Reseeding happens when the bundled
 * count differs from what's in the database, which covers both first run and a
 * dataset upgrade.
 *
 * Ships empty. Run `node scripts/import-foods.mjs <usda-csv-dir>` to fill it —
 * see the script header for where to get the data and why USDA specifically.
 */

import { query, run } from '../db/client';
import bundled from '../data/foods.json';

/**
 * Uses the raw client rather than a scoped handle, deliberately.
 *
 * No agent may write `foods` — it is reference data that ships with the app,
 * and an agent rewriting the nutrient tables underneath itself is exactly the
 * kind of thing the scope layer exists to prevent. Seeding is app
 * infrastructure running at startup, not an agent action, so it does not
 * borrow an agent's identity to get the permission.
 *
 * The scope layer caught this being wrong the first time it was written.
 */

type BundledFood = {
  id: string;
  name: string;
  source_db: string;
  per_unit: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
};

export type SeedResult = {
  bundled: number;
  inDb: number;
  seeded: boolean;
};

export async function seedFoods(): Promise<SeedResult> {
  const list = bundled as BundledFood[];
  const rows = await query<{ n: number }>('SELECT COUNT(*) AS n FROM foods');
  const inDb = Number(rows[0]?.n ?? 0);

  if (list.length === 0 || inDb === list.length) {
    return { bundled: list.length, inDb, seeded: false };
  }

  await run('DELETE FROM foods');

  // One multi-row INSERT per chunk: a few thousand round-trips to the worker
  // is slow enough to be visible on first launch.
  const CHUNK = 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const values = chunk
      .map(() => '(?,?,?,?,?,?,?,?,?)')
      .join(',');
    const bind: unknown[] = [];
    for (const f of chunk) {
      bind.push(
        f.id, f.name, f.source_db, f.per_unit,
        f.energy_kcal, f.protein_g, f.fat_g, f.carbs_g, f.fibre_g,
      );
    }
    await run(
      `INSERT INTO foods
         (id, name, source_db, per_unit, energy_kcal, protein_g, fat_g, carbs_g, fibre_g)
       VALUES ${values}`,
      bind,
    );
  }

  return { bundled: list.length, inDb: list.length, seeded: true };
}
