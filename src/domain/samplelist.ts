/**
 * Sample dishes: published vegetarian dishes a phone can log from before its
 * own food table has anything in it (Upendra, 15-16 Oct 2026; the name is his).
 *
 * For the people he gives access to. He and his partner have their kitchen
 * weighed already and never add it, so everything here has to leave a phone
 * that has not tapped Add exactly as it was: the tables stay empty, and every
 * query that reads them reads nothing.
 *
 * What he decided, and what follows from it:
 *
 *   One tap in Dev → Lists fetches the file from Mealo's own address. It is
 *   in `public/lists/`, served beside the app, and kept out of the offline
 *   cache (vite.config.ts precaches no .json), so no phone downloads it
 *   until someone asks.
 *
 *   It is a list on this phone, like the medicine lists: never synced, never
 *   in the household library, removable. A meal logged from it carries its
 *   own figures, as every meal item does, so removing the list changes no
 *   meal.
 *
 *   A dish goes into My food table only by choice, and only a dish given
 *   per 100 g (CoFID). The INDB dishes are given per dosa or per bowl as a
 *   recipe makes it; My food table works per 100 g, and INDB's grams are of
 *   the raw ingredients, so no honest per-100 g figure exists for them ("1.
 *   Agreed. Let's keep it separate").
 *
 *   A dish with no fibre figure adds nothing to the day's fibre: the day then
 *   reads low, which he preferred to marking it incomplete ("low is better
 *   than incomplete which is inconclusive").
 *
 * The rows are the build's, not the phone's: scripts/build-sample-list.ts
 * chose them, refused the recipes whose figures are wrong at source, and
 * converted carbohydrate to Mealo's convention. This file only checks that
 * what arrived is that, and stores it.
 */

import { scopedDb } from '../db/scope';
import { LIST_FOODS, LIST_PREFIX, normalise, slugFor, type Food } from './foods';

const db = scopedDb('nutritionist');

/** Where the file is served, and the id its list takes on the phone. */
export const SAMPLE_URL = '/lists/sample-veg.json';
export const SAMPLE_SET = 'sample-veg';

/** One dish as the file carries it. */
export type SampleRow = {
  id: string;
  name: string;
  /** '100g', or the one unit the source counts it in: 'dosa', 'bowl'. */
  unit: string;
  kcal: number;
  protein: number;
  fat: number;
  /** Fibre included. */
  carbs: number;
  /** null: the source has no fibre figure for this dish. */
  fibre: number | null;
  source: 'CoFID 2021' | 'INDB 2024';
  code: string;
  /** Measured in a laboratory, rather than calculated from a recipe. */
  lab: boolean;
};

export type SampleFile = {
  list: string;
  version: number;
  name: string;
  tag: string;
  credits: string;
  count: number;
  rows: SampleRow[];
};

export type SampleState = {
  name: string;
  tag: string;
  credits: string | null;
  count: number;
  addedAt: number | null;
};

// ---------------------------------------------------------------- the file

/**
 * The file as a phone may store it, or an error saying what is wrong.
 *
 * Whole or not at all: one bad row refuses the file, because a list with a
 * gap the person cannot see is worse than no list. The limits are wide enough
 * for any real dish and narrow enough to stop a file that is something else:
 * ghee, the densest thing in the list, is 878 Cal per 100 g, and nothing per
 * 100 g can hold more than 100 g of protein, fat and carbohydrate together.
 * Per piece or bowl the ceiling is 3,000 Cal; the largest dish in it is 563.
 */
export function checkSampleFile(raw: unknown): SampleFile {
  const bad = (why: string): never => {
    throw new Error(`The sample list did not pass its check: ${why}. Nothing on this phone changed.`);
  };
  if (!raw || typeof raw !== 'object') bad('it is not a list');
  const f = raw as Record<string, unknown>;
  if (f.list !== SAMPLE_SET) bad('it is not the sample dishes');
  if (!Number.isInteger(f.version) || (f.version as number) < 1) bad('it has no version');
  for (const k of ['name', 'tag', 'credits'] as const) {
    if (typeof f[k] !== 'string' || !(f[k] as string).trim()) bad(`it has no ${k}`);
  }
  if (!Array.isArray(f.rows) || f.rows.length === 0) bad('it has no dishes');
  const rows = f.rows as unknown[];
  if (f.count !== rows.length) bad(`it says ${String(f.count)} dishes and holds ${rows.length}`);
  if (rows.length > 1000) bad('it is far longer than the list');

  const ids = new Set<string>();
  const names = new Set<string>();
  const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const [i, r] of rows.entries()) {
    const at = `dish ${i + 1}`;
    if (!r || typeof r !== 'object') bad(`${at} is not a dish`);
    const d = r as Record<string, unknown>;
    if (typeof d.id !== 'string' || !/^list:[a-z]+-[A-Za-z0-9-]+$/.test(d.id)) bad(`${at} has no proper id`);
    if (ids.has(d.id as string)) bad(`${at} repeats an id`);
    ids.add(d.id as string);
    if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 120) bad(`${at} has no proper name`);
    const key = slugFor(d.name as string);
    if (!key || names.has(key)) bad(`${at} (${String(d.name)}) repeats a name`);
    names.add(key);
    if (typeof d.unit !== 'string' || !(d.unit === '100g' || /^[a-z][a-z ]{0,20}$/.test(d.unit))) bad(`${at} has no proper unit`);
    const per100 = d.unit === '100g';
    if (!amount(d.kcal) || (d.kcal as number) > (per100 ? 900 : 3000)) bad(`${at} has no believable calories`);
    for (const k of ['protein', 'fat', 'carbs'] as const) if (!amount(d[k])) bad(`${at} has no ${k} figure`);
    if (d.fibre !== null && !amount(d.fibre)) bad(`${at} has an unreadable fibre figure`);
    if (d.fibre !== null && (d.fibre as number) > (d.carbs as number) + 0.05) bad(`${at} has more fibre than carbohydrate`);
    if (per100 && (d.protein as number) + (d.fat as number) + (d.carbs as number) > 100.5) bad(`${at} holds more than 100 g in 100 g`);
    if (d.source !== 'CoFID 2021' && d.source !== 'INDB 2024') bad(`${at} names no known source`);
    if (typeof d.code !== 'string' || !d.code.trim()) bad(`${at} has no source code`);
    if (typeof d.lab !== 'boolean') bad(`${at} does not say how it was measured`);
  }
  return f as unknown as SampleFile;
}

// ---------------------------------------------------------------- pricing

/** Given per piece or bowl rather than per 100 g: never weighed. */
export function isServing(food: Pick<Food, 'per_unit'>): boolean {
  return food.per_unit !== '100g';
}

/** '1 dosa' → 'dosa'. */
export function servingWord(food: Pick<Food, 'per_unit'>): string {
  return food.per_unit.replace(/^1\s+/, '');
}

/**
 * A serving dish's figures for a quantity: the published figure for one,
 * times how many. Nulls stay null (fibre not known is not zero fibre, even
 * though the day's total counts it as nothing).
 */
export function servingMacros(
  food: Food,
  quantity: number | null,
): { energy_kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null; fibre_g: number | null } {
  const q = quantity == null || quantity <= 0 ? 1 : quantity;
  const r = (v: number | null) => (v === null || v === undefined ? null : Math.round(v * q * 10) / 10);
  return {
    energy_kcal: r(food.energy_kcal),
    protein_g: r(food.protein_g),
    fat_g: r(food.fat_g),
    carbs_g: r(food.carbs_g),
    fibre_g: r(food.fibre_g),
  };
}

// ---------------------------------------------------------------- the list

/** The list on this phone, or null when it has not been added. */
export async function sampleListState(): Promise<SampleState | null> {
  const rows = await db.query<{ name: string; tag: string; credits: string | null; row_count: number; added_at: number | null }>(
    'SELECT name, tag, credits, row_count, added_at FROM food_ref_sets WHERE id = ? AND deleted_at IS NULL',
    [SAMPLE_SET],
  );
  const s = rows[0];
  return s ? { name: s.name, tag: s.tag, credits: s.credits, count: Number(s.row_count), addedAt: s.added_at } : null;
}

/** Fetch the file from Mealo's own address. */
async function fetchFile(): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(SAMPLE_URL, { cache: 'no-store' });
  } catch {
    throw new Error('No connection: the list could not be fetched. Nothing on this phone changed.');
  }
  if (!res.ok) throw new Error(`The list could not be fetched (${res.status}). Nothing on this phone changed.`);
  try {
    return await res.json();
  } catch {
    throw new Error('What came back was not the list. Nothing on this phone changed.');
  }
}

/**
 * Add the list: fetch, check, and write it as one unit, so every dish lands
 * or none does. One transaction rather than the medicine lists' staged
 * import, which exists for files of 250,000 rows; this one has 169.
 *
 * `load` is for the tests, which hand it a file without a network.
 */
export async function addSampleList(load: () => Promise<unknown> = fetchFile): Promise<SampleState> {
  await finishRemovals();
  const already = await sampleListState();
  if (already) return already;

  const file = checkSampleFile(await load());
  const now = Date.now();
  await db.atomically(async (tx) => {
    await tx.insert('food_ref_sets', {
      id: SAMPLE_SET,
      name: file.name,
      tag: file.tag,
      credits: file.credits,
      version: file.version,
      row_count: file.rows.length,
      added_at: now,
      deleted_at: null,
    });
    for (const r of file.rows) {
      await tx.insert('food_ref_items', {
        id: r.id,
        set_id: SAMPLE_SET,
        name: r.name,
        slug: slugFor(r.name),
        unit: r.unit,
        energy_kcal: r.kcal,
        protein_g: r.protein,
        fat_g: r.fat,
        carbs_g: r.carbs,
        fibre_g: r.fibre,
        source: r.source,
        code: r.code,
        lab: r.lab ? 1 : 0,
        deleted_at: null,
      });
    }
  });
  return (await sampleListState())!;
}

/**
 * Remove the list. The list row is marked first, which takes every dish out
 * of search and matching at once (LIST_FOODS joins on it); the rows are then
 * deleted outright, as the medicine lists' are, since nothing here is synced
 * and a tombstone would serve no one. Meals logged from it keep their
 * figures; dishes kept from it are the person's own and stay.
 */
export async function removeSampleList(): Promise<void> {
  if (await sampleListState()) await db.update('food_ref_sets', SAMPLE_SET, { deleted_at: Date.now() });
  await finishRemovals();
}

/** A removal the app closed in the middle of, finished. */
export async function finishRemovals(): Promise<void> {
  const gone = await db.query<{ id: string }>('SELECT id FROM food_ref_sets WHERE deleted_at IS NOT NULL');
  for (const s of gone) {
    await db.run('DELETE FROM food_ref_items WHERE set_id = ?', [s.id]);
    await db.run('DELETE FROM food_ref_sets WHERE id = ?', [s.id]);
  }
}

// ---------------------------------------------------------------- reading

/**
 * Sample dishes matching what was typed, for the search screen's second
 * section. A dish with the same name as one of the person's own is left out:
 * theirs is what they meant, and two rows with one name is a choice nobody
 * can make from the screen.
 */
export async function searchSample(term: string, limit = 25): Promise<Food[]> {
  const needle = normalise(term);
  if (needle.length < 2) return [];
  const like = `%${needle}%`;
  return db.query<Food>(
    `SELECT * FROM (${LIST_FOODS} AND (i.name LIKE ? OR i.slug LIKE ?)
        AND i.slug NOT IN (SELECT slug FROM custom_foods WHERE deleted_at IS NULL AND slug IS NOT NULL))
      ORDER BY name_len LIMIT ?`,
    [like, like, limit],
  );
}

/** One sample dish, if its list is on this phone. */
export async function sampleFood(id: string): Promise<Food | null> {
  if (!id.startsWith(LIST_PREFIX)) return null;
  const rows = await db.query<Food>(`${LIST_FOODS} AND i.id = ?`, [id]);
  return rows[0] ?? null;
}

/** Of these ids, the ones whose dish is on this phone now. */
export async function liveSampleIds(ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((id) => id.startsWith(LIST_PREFIX)))];
  if (want.length === 0) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM (${LIST_FOODS} AND i.id IN (${want.map(() => '?').join(',')}))`,
    want,
  );
  return new Set(rows.map((r) => r.id));
}

/** Where a sample dish's figures come from, for the line under them. */
export async function sampleCredit(id: string): Promise<string | null> {
  const rows = await db.query<{ source: string; code: string; lab: number }>(
    'SELECT source, code, lab FROM food_ref_items WHERE id = ?',
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const from = r.source === 'INDB 2024' ? 'Indian Nutrient Databank 2024' : `UK ${r.source}`;
  return `${from}, ${r.code} · ${r.lab ? 'measured in a laboratory' : 'calculated from a recipe'}`;
}
