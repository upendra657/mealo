/**
 * Food matching — the part that keeps the Nutritionist off the model.
 *
 * Phase 2's exit criterion is that 80% of meals resolve with zero model calls.
 * That is not a performance optimisation: at 8,000 tokens/minute on the free
 * tier, a model call per meal item is how you hit a rate limit at lunchtime.
 *
 * Order of attempts, cheapest first:
 *   1. food_aliases  — something you confirmed before. Free, instant, exact.
 *   2. exact name    — normalised string equality against the reference table.
 *   3. fuzzy         — token overlap + trigram similarity, scored.
 *   4. the model     — only when all of the above fail. Handled by the caller.
 *
 * Every confirmed match is written back to food_aliases, so your own
 * vocabulary converges and step 1 catches more over time.
 */

import { scopedDb } from '../db/scope';
import { canonicalMeasure, MEASURES } from './measures';

const db = scopedDb('nutritionist');

export type Food = {
  id: string;
  name: string;
  source_db: string;
  per_unit: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
  /** 1 when the user defined this themselves. */
  is_custom?: number;
};

/**
 * Both food sources as one result set.
 *
 * `custom_foods` first and flagged, because something you defined by hand beats
 * a generic reference row — you know what your dal actually contains and USDA
 * does not have it at all.
 */
/**
 * `name_len` is carried as a real column, not computed in ORDER BY.
 *
 * SQLite refuses an expression in the ORDER BY of a compound SELECT — it only
 * accepts names that appear in the result set — and the failure is a thrown
 * error at query time, not at build time. Search was dead because of it.
 */
const UNION_FOODS = `
  SELECT id, name, 'custom' AS source_db, per_unit,
         energy_kcal, protein_g, fat_g, carbs_g, fibre_g,
         1 AS is_custom, LENGTH(name) AS name_len
    FROM custom_foods WHERE deleted_at IS NULL AND name LIKE ?
  UNION ALL
  SELECT id, name, source_db, per_unit,
         energy_kcal, protein_g, fat_g, carbs_g, fibre_g,
         0 AS is_custom, LENGTH(name) AS name_len
    FROM foods WHERE name LIKE ?
`;

export type Match = {
  food: Food;
  score: number;
  via: 'alias' | 'exact' | 'fuzzy';
};

/** Lowercase, strip punctuation and plurals, collapse whitespace. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(\w+?)(?:es|s)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigrams — cheap, and forgiving of small typos. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Fraction of the query's words that appear in the candidate name. */
export function tokenCoverage(query: string, candidate: string): number {
  const q = query.split(' ').filter(Boolean);
  if (q.length === 0) return 0;
  const c = new Set(candidate.split(' ').filter(Boolean));
  return q.filter((t) => c.has(t)).length / q.length;
}

/**
 * How well a written label matches a reference food name.
 *
 * Dice alone is unusable here because reference names are long and specific
 * while people type short and general: "curd" against "Curd plain whole milk"
 * scores 0.37 on trigrams and gets rejected, which is obviously wrong — the
 * user said curd and that food is curd.
 *
 * So take the better of the two signals, and break ties toward the shorter
 * name, since "Curd plain whole milk" is a likelier intent than
 * "Curd plain whole milk with added fruit preparation".
 */
export function score(query: string, candidateName: string): number {
  const dice = similarity(query, candidateName);
  const coverage = tokenCoverage(query, candidateName);
  const base = Math.max(dice, coverage);
  const lengthPenalty = Math.min(candidateName.length / 400, 0.08);
  return Math.max(0, base - lengthPenalty);
}

export type ParsedItem = {
  /** What the user actually wrote for this item. */
  label: string;
  quantity: number | null;
  unit: string | null;
};

/**
 * Every word that could be a measure, longest first.
 *
 * Built from the measure vocabulary rather than kept as its own list. The two
 * drifted apart once already and it showed up as "1 teacup filter coffee"
 * logging a 100g nothing, and "3 regular idli" matching Regular Naan — the
 * parser had never heard of "teacup" or "regular", so both words stayed in
 * the dish name and poisoned the match.
 *
 * Longest first matters: "small bowl" has to be tried before "bowl", or the
 * word "small" is left stranded at the front of the dish name.
 */
const UNITS = [...new Set(
  MEASURES.flatMap((m) => [m.id, m.label, ...m.aliases]),
)]
  .map((u) => u.toLowerCase())
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * Splits "2 roti, dal tadka, 1 cup curd" into items with quantities.
 *
 * Deliberately simple string work — no model call. Anything it can't parse is
 * kept verbatim as the label, so nothing is ever silently dropped.
 */
export function parseMealText(text: string): ParsedItem[] {
  return text
    .split(/[,\n]|\band\b|\+/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      // "250g paneer" / "2 roti" / "1.5 cups dal"
      const m = chunk.match(
        new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:(${UNITS.join('|')})\\b)?\\s*(.*)$`, 'i'),
      );
      if (m && m[1]) {
        const rest = (m[3] || '').trim();
        const unit = canonicalMeasure(m[2] ?? null);
        // "2 roti" — the word is both the measure and the dish, so it has to
        // stay in the label and stop being the measure.
        const label = rest || m[2] || chunk;
        return {
          label,
          quantity: Number(m[1]),
          unit: rest ? unit : null,
        };
      }
      return { label: chunk, quantity: null, unit: null };
    });
}

// ------------------------------------------------------------- lookups

export async function countFoods(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM foods',
  );
  return Number(rows[0]?.n ?? 0);
}

async function byAlias(needle: string): Promise<Food | null> {
  // Aliases can point at either table, so check both. A custom food is the
  // more likely target once the user has started defining their own.
  const rows = await db.query<Food>(
    `SELECT c.id, c.name, 'custom' AS source_db, c.per_unit,
            c.energy_kcal, c.protein_g, c.fat_g, c.carbs_g, c.fibre_g,
            1 AS is_custom
       FROM food_aliases a
       JOIN custom_foods c ON c.id = a.food_id
      WHERE a.alias = ? AND a.deleted_at IS NULL AND c.deleted_at IS NULL
     UNION ALL
     SELECT f.id, f.name, f.source_db, f.per_unit,
            f.energy_kcal, f.protein_g, f.fat_g, f.carbs_g, f.fibre_g,
            0 AS is_custom
       FROM food_aliases a
       JOIN foods f ON f.id = a.food_id
      WHERE a.alias = ? AND a.deleted_at IS NULL
     LIMIT 1`,
    [needle, needle],
  );
  return rows[0] ?? null;
}

async function byExactName(needle: string): Promise<Food | null> {
  const rows = await db.query<Food>(
    `SELECT id, name, 'custom' AS source_db, per_unit,
            energy_kcal, protein_g, fat_g, carbs_g, fibre_g, 1 AS is_custom
       FROM custom_foods WHERE deleted_at IS NULL AND LOWER(name) = ?
     UNION ALL
     SELECT id, name, source_db, per_unit,
            energy_kcal, protein_g, fat_g, carbs_g, fibre_g, 0 AS is_custom
       FROM foods WHERE LOWER(name) = ?
     LIMIT 1`,
    [needle, needle],
  );
  return rows[0] ?? null;
}

/** Save a food the user defined. Matches for free from then on. */
export async function saveCustomFood(food: {
  name: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
  per_unit?: string;
}): Promise<string> {
  return db.insert('custom_foods', {
    name: food.name.trim(),
    per_unit: food.per_unit ?? '100g',
    energy_kcal: food.energy_kcal,
    protein_g: food.protein_g,
    fat_g: food.fat_g,
    carbs_g: food.carbs_g,
    fibre_g: food.fibre_g,
    notes: null,
    deleted_at: null,
  });
}

export async function listCustomFoods(): Promise<Food[]> {
  return db.query<Food>(
    `SELECT id, name, 'custom' AS source_db, per_unit,
            energy_kcal, protein_g, fat_g, carbs_g, fibre_g, 1 AS is_custom
       FROM custom_foods WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  );
}

export async function deleteCustomFood(id: string): Promise<void> {
  await db.softDelete('custom_foods', id);
}

/**
 * Resolve one written item to a reference food.
 *
 * Returns null rather than a bad guess. A wrong food silently attached to a
 * meal is worse than an unmatched one the user can fix.
 */
export async function matchFood(
  label: string,
  minScore = 0.45,
): Promise<Match | null> {
  const needle = normalise(label);
  if (!needle) return null;

  const alias = await byAlias(needle);
  if (alias) return { food: alias, score: 1, via: 'alias' };

  const exact = await byExactName(needle);
  if (exact) return { food: exact, score: 1, via: 'exact' };

  // Narrow with a LIKE on the longest token before scoring, so we are not
  // trigram-matching the whole table on every keystroke.
  const longest = needle
    .split(' ')
    .sort((a, b) => b.length - a.length)[0];
  if (!longest || longest.length < 3) return null;

  const like = `%${longest}%`;
  const candidates = await db.query<Food>(`${UNION_FOODS} LIMIT 400`, [
    like,
    like,
  ]);
  if (candidates.length === 0) return null;

  let best: Match | null = null;
  for (const food of candidates) {
    // Small thumb on the scale for your own definitions.
    const s = score(needle, normalise(food.name)) + (food.is_custom ? 0.15 : 0);
    if (!best || s > best.score) best = { food, score: Math.min(s, 1), via: 'fuzzy' };
  }
  return best && best.score >= minScore ? best : null;
}

/** Remember a confirmed match so it resolves for free next time. */
export async function rememberAlias(
  label: string,
  foodId: string,
): Promise<void> {
  const alias = normalise(label);
  if (!alias) return;
  const existing = await db.query<{ id: string; hits: number }>(
    'SELECT id, hits FROM food_aliases WHERE alias = ? LIMIT 1',
    [alias],
  );
  if (existing[0]) {
    await db.update('food_aliases', existing[0].id, {
      food_id: foodId,
      hits: existing[0].hits + 1,
      deleted_at: null,
    });
  } else {
    await db.insert('food_aliases', {
      alias,
      food_id: foodId,
      hits: 1,
      deleted_at: null,
    });
  }
}

export async function searchFoods(term: string, limit = 20): Promise<Food[]> {
  const needle = normalise(term);
  if (needle.length < 2) return [];
  const like = `%${needle}%`;
  return db.query<Food>(
    `${UNION_FOODS} ORDER BY is_custom DESC, name_len LIMIT ?`,
    [like, like, limit],
  );
}

/**
 * Scale a reference food's per-100g values to a quantity.
 * Returns nulls where the reference has none — never a computed guess.
 */
export function scaleMacros(
  food: Food,
  grams: number,
): {
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
} {
  const f = grams / 100;
  const r = (v: number | null) =>
    v === null || v === undefined ? null : Math.round(v * f * 10) / 10;
  return {
    energy_kcal: r(food.energy_kcal),
    protein_g: r(food.protein_g),
    fat_g: r(food.fat_g),
    carbs_g: r(food.carbs_g),
    fibre_g: r(food.fibre_g),
  };
}
