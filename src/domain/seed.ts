/**
 * Keeps the bundled food reference table in SQLite equal to the bundled file.
 *
 * `foods` is reference data, not user data: it ships with the app, is never
 * synced, and is safe to wipe and rewrite. The file is `src/data/foods.json`,
 * 329 USDA Foundation Foods; `scripts/import-foods.mjs` builds it — see the
 * script header for where to get the data and why USDA specifically.
 *
 * The table is compared with the file row for row at every start, and
 * rewritten when they differ. It used to compare counts only, and it was
 * called from the old log screen only. Both failed quietly: the dark rebuild
 * of 24 Sep 2026 replaced that screen, so from then on nothing loaded the
 * table at all — a database older than that kept its 329 rows for good and a
 * newer one never got any — and a corrected figure in the file, same count,
 * would not have reached a phone even while the call was alive. Found 11 Oct
 * 2026, when the calorie figures turned out to mix two of USDA's calculations
 * and there was no way to deliver the correction.
 *
 * No version stamp is kept, on purpose. A stamp in IndexedDB outlives a
 * restore, which replaces the SQLite file and would leave an old backup's
 * table marked current; a stamp in SQLite needs a table and a migration.
 * Reading 329 rows costs less than either and cannot disagree with itself.
 */

import { query, run } from '../db/client';

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

export type BundledFood = {
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

const COLUMNS = [
  'id', 'name', 'source_db', 'per_unit',
  'energy_kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g',
] as const;

/**
 * The bundled file, fetched when asked for rather than imported at the top.
 *
 * A static import would put 329 rows of JSON in the main chunk, which is
 * already past the size the build warns about, to be parsed before first
 * paint on every start for a comparison that almost always finds nothing to
 * do.
 */
async function bundledFoods(): Promise<BundledFood[]> {
  return (await import('../data/foods.json')).default as BundledFood[];
}

/** Whether the table holds exactly these rows: same ids, same value in every column. */
function same(inDb: BundledFood[], list: BundledFood[]): boolean {
  if (inDb.length !== list.length) return false;
  const byId = new Map(inDb.map((f) => [f.id, f]));
  return list.every((f) => {
    const have = byId.get(f.id);
    return !!have && COLUMNS.every((c) => have[c] === f[c]);
  });
}

/**
 * `list` is the bundled file unless a caller hands in its own, which is how
 * the e2e run checks a corrected figure without rewriting the real file.
 *
 * An empty list writes nothing. It means the file could not be built or read,
 * and wiping a table that meals, portions and aliases point into, on the
 * strength of having nothing to put there, is the wrong reading of that.
 */
export async function seedFoods(list?: BundledFood[]): Promise<SeedResult> {
  const wanted = list ?? (await bundledFoods());
  const inDb = await query<BundledFood>(`SELECT ${COLUMNS.join(', ')} FROM foods`);

  if (wanted.length === 0 || same(inDb, wanted)) {
    return { bundled: wanted.length, inDb: inDb.length, seeded: false };
  }

  // Ids are `usda-` plus USDA's own, so a rewritten row is the row every
  // meal, portion and alias already pointed at. Not one transaction: closed
  // halfway, the table is short, the next start finds it different and
  // writes it again.
  await run('DELETE FROM foods');

  // One multi-row INSERT per chunk: a few thousand round-trips to the worker
  // is slow enough to be visible on first launch.
  const CHUNK = 200;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
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

  return { bundled: wanted.length, inDb: wanted.length, seeded: true };
}

/**
 * The start-up call, once per page.
 *
 * StrictMode runs the mount effect twice in development, and two rewrites at
 * once both delete and then both insert: the second insert meets the first's
 * rows and fails on the primary key. The medicine lists loaded twice this way
 * before `startLists` got the same guard.
 */
let startup: Promise<SeedResult> | null = null;
export function startFoods(): Promise<SeedResult> {
  startup ??= seedFoods();
  return startup;
}
