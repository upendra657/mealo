/**
 * Importing your own food table.
 *
 * The format is the one you already keep by hand:
 *
 *   Meal/Ingredient, Quantity, Measure, Net weight (g),
 *   Calories (Kcal), Protein (g), Fats (g), Carbs (g), Fiber (g)
 *
 * Two things this does that a naive importer would not:
 *
 *   1. It normalises every row to per-100g before storing, and keeps the row's
 *      own net weight as a *portion anchor* rather than as the serving size.
 *      That is what makes the data elastic: the row says what one katori
 *      weighs, and everything else — 1.5 katori, a bowl, 80g — is derived from
 *      it instead of being locked to the row.
 *
 *   2. Several rows for the same dish are a feature, not a duplicate. "Dal, 1,
 *      katori, 150" and "Dal, 1, bowl, 250" are two anchors on one dish. If
 *      their macros disagree once normalised, that is a data error worth
 *      telling you about rather than quietly averaging away.
 *
 * Re-importing the whole file is the intended way to update it. Dishes match
 * on name, portions match on (dish, measure), and nothing duplicates.
 */

import { scopedDb } from '../db/scope';
import { normalise, rememberAlias, slugFor } from './foods';
import { canonicalMeasure, toMeasure } from './measures';
import { upsertPortion } from './portions';

const db = scopedDb('nutritionist');

// ------------------------------------------------------------------ CSV

/**
 * A real CSV reader — quoted fields, embedded commas, doubled quotes, CRLF.
 * Dish names contain commas ("Dal, tadka") often enough that a split(',')
 * importer corrupts the file silently, which is the worst way to lose data.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Header names we accept for each column, normalised to letters and digits. */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ['mealingredient', 'meal', 'ingredient', 'dish', 'food', 'item', 'name', 'fooditem'],
  quantity: ['quantity', 'qty', 'amount', 'count', 'number'],
  measure: ['measure', 'unit', 'measurement', 'units', 'servingunit', 'household'],
  netWeightG: ['netweightg', 'netweight', 'weightg', 'weight', 'grams', 'gram', 'g', 'netwt', 'servingg'],
  energy: ['caloriekcal', 'calorieskcal', 'calories', 'calorie', 'kcal', 'energy', 'energykcal', 'energ'],
  protein: ['proteing', 'protein', 'proteins', 'prot', 'p'],
  fat: ['fatsg', 'fatg', 'fats', 'fat', 'f'],
  carbs: ['carbsg', 'carbg', 'carbs', 'carb', 'carbohydrate', 'carbohydrates', 'carbohydrateg', 'c'],
  fibre: ['fiberg', 'fibreg', 'fiber', 'fibre', 'fibres', 'fibers', 'dietaryfiber', 'dietaryfibre'],
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Header text with its parenthetical hints removed.
 *
 * Real sheets carry them — "Quantity (Numeric eg: 1.0)", "Net weight (g)" —
 * and an importer that only accepts the bare word makes you edit the file
 * before it will read it.
 */
const bare = (s: string) => key(s.replace(/[([{][^)\]}]*[)\]}]?/g, ' '));

export type ColumnMap = Partial<Record<keyof typeof HEADER_ALIASES, number>>;

export function mapHeaders(header: string[]): {
  columns: ColumnMap;
  unmatched: string[];
} {
  const columns: ColumnMap = {};
  const used = new Set<number>();
  const fields = Object.entries(HEADER_ALIASES);

  // Exact first, across every column, so "Fats (g)" can never be claimed by
  // the single-letter "g" alias before the real fat column is considered.
  for (const [field, aliases] of fields) {
    const idx = header.findIndex(
      (h, i) =>
        !used.has(i) && (aliases.includes(bare(h)) || aliases.includes(key(h))),
    );
    if (idx >= 0) {
      columns[field as keyof ColumnMap] = idx;
      used.add(idx);
    }
  }

  // Then prefixes, for headers that say more than the alias does
  // ("proteingrams", "caloriesperserving"). Short aliases are excluded —
  // "p" prefixing "protein" would be an accident waiting to happen.
  for (const [field, aliases] of fields) {
    if (columns[field as keyof ColumnMap] !== undefined) continue;
    const idx = header.findIndex((h, i) => {
      if (used.has(i)) return false;
      const b = bare(h);
      return (
        b.length >= 3 &&
        aliases.some((a) => a.length >= 4 && (b.startsWith(a) || a.startsWith(b)))
      );
    });
    if (idx >= 0) {
      columns[field as keyof ColumnMap] = idx;
      used.add(idx);
    }
  }

  const unmatched = header.filter((h, i) => !used.has(i) && h.trim() !== '');
  return { columns, unmatched };
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.replace(/[^0-9.-]/g, '').trim();
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type PersonalRow = {
  line: number;
  name: string;
  quantity: number;
  measure: string | null;
  netWeightG: number | null;
  energy: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fibre: number | null;
};

export type RowIssue = { line: number; text: string };

/** Read the sheet into rows, keeping every complaint rather than dropping any. */
export function readRows(text: string): {
  rows: PersonalRow[];
  issues: RowIssue[];
  columns: ColumnMap;
  unmatched: string[];
  headerLine: string[];
} {
  const grid = parseCsv(text);
  const issues: RowIssue[] = [];
  if (grid.length === 0) {
    return { rows: [], issues: [{ line: 0, text: 'The file is empty.' }], columns: {}, unmatched: [], headerLine: [] };
  }

  const headerLine = grid[0].map((h) => h.trim());
  const { columns, unmatched } = mapHeaders(headerLine);
  if (columns.name === undefined) {
    issues.push({
      line: 1,
      text:
        'No dish-name column found. Expected a header like "Meal/Ingredient". ' +
        `Saw: ${headerLine.join(' | ')}`,
    });
    return { rows: [], issues, columns, unmatched, headerLine };
  }

  const rows: PersonalRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const at = (c: keyof ColumnMap) =>
      columns[c] === undefined ? undefined : r[columns[c] as number];
    const name = (at('name') ?? '').trim();
    if (!name) {
      issues.push({ line: i + 1, text: 'No dish name — row skipped.' });
      continue;
    }
    const rawMeasure = (at('measure') ?? '').trim();
    const measure = canonicalMeasure(rawMeasure);
    if (rawMeasure && !measure) {
      issues.push({
        line: i + 1,
        text: `"${name}": measure "${rawMeasure}" isn't one I know — the portion was skipped, macros still imported.`,
      });
    }
    rows.push({
      line: i + 1,
      name,
      quantity: num(at('quantity')) ?? 1,
      measure,
      netWeightG: num(at('netWeightG')),
      energy: num(at('energy')),
      protein: num(at('protein')),
      fat: num(at('fat')),
      carbs: num(at('carbs')),
      fibre: num(at('fibre')),
    });
  }
  return { rows, issues, columns, unmatched, headerLine };
}

// ------------------------------------------------------- normalisation

export type Per100 = {
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
};

/**
 * The net weight a row actually describes.
 *
 * If the sheet has the weight, that wins. Otherwise a row measured in grams
 * or kilograms carries its own weight in the quantity column, which is worth
 * reading rather than refusing.
 */
export function weightOf(row: PersonalRow): number | null {
  if (row.netWeightG && row.netWeightG > 0) return row.netWeightG;
  const m = row.measure ? toMeasure(row.measure) : null;
  if (m && m.kind === 'weight') return row.quantity * m.grams;
  return null;
}

/** Scale a row's portion macros to per-100g. Nulls stay null. */
export function per100Of(row: PersonalRow, weight: number): Per100 {
  const f = 100 / weight;
  const r = (v: number | null) => (v === null ? null : Math.round(v * f * 100) / 100);
  return {
    energy_kcal: r(row.energy),
    protein_g: r(row.protein),
    fat_g: r(row.fat),
    carbs_g: r(row.carbs),
    fibre_g: r(row.fibre),
  };
}

export type DishPlan = {
  name: string;
  per100: Per100;
  /** Which row the macros came from, for the report. */
  macroLine: number;
  portions: { measure: string; quantity: number; netWeightG: number; line: number }[];
  warnings: string[];
};

/**
 * Group rows into dishes and decide, per dish, one set of per-100g macros.
 *
 * When rows disagree, the biggest portion wins — a 250g row carries less
 * relative rounding error than a 15g one — and the disagreement is reported
 * rather than hidden.
 */
export function planDishes(rows: PersonalRow[]): {
  dishes: DishPlan[];
  issues: RowIssue[];
} {
  const issues: RowIssue[] = [];
  const groups = new Map<string, PersonalRow[]>();
  for (const r of rows) {
    const k = normalise(r.name) || r.name.toLowerCase();
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  const dishes: DishPlan[] = [];
  for (const list of groups.values()) {
    const name = list[0].name.trim();
    const warnings: string[] = [];
    const weighed = list
      .map((r) => ({ r, w: weightOf(r) }))
      .filter((x): x is { r: PersonalRow; w: number } => x.w !== null && x.w > 0);

    if (weighed.length === 0) {
      issues.push({
        line: list[0].line,
        text: `"${name}": no net weight on any row, so per-100g macros can't be worked out. Row skipped.`,
      });
      continue;
    }

    // Macros come from the largest weighed row that actually has calories.
    const withEnergy = weighed.filter((x) => x.r.energy !== null);
    const pool = withEnergy.length ? withEnergy : weighed;
    const chosen = [...pool].sort((a, b) => b.w - a.w)[0];
    const per100 = per100Of(chosen.r, chosen.w);

    // Cross-check the others.
    for (const x of pool) {
      if (x === chosen) continue;
      const other = per100Of(x.r, x.w);
      const a = per100.energy_kcal;
      const b = other.energy_kcal;
      if (a !== null && b !== null && a > 0) {
        const drift = Math.abs(a - b) / a;
        if (drift > 0.05) {
          warnings.push(
            `rows ${chosen.r.line} and ${x.r.line} disagree on energy once ` +
              `scaled (${Math.round(a)} vs ${Math.round(b)} kcal/100g). ` +
              `Using row ${chosen.r.line}; check the net weights.`,
          );
        }
      }
    }

    // Every row with a real household measure becomes an anchor.
    const portions: DishPlan['portions'] = [];
    const seen = new Set<string>();
    for (const x of weighed) {
      const m = x.r.measure ? toMeasure(x.r.measure) : null;
      if (!m || m.kind === 'weight') continue;
      if (seen.has(m.id)) {
        warnings.push(`"${m.label}" appears more than once; row ${x.r.line} was used.`);
      }
      seen.add(m.id);
      portions.push({
        measure: m.id,
        quantity: x.r.quantity > 0 ? x.r.quantity : 1,
        netWeightG: x.w,
        line: x.r.line,
      });
    }

    dishes.push({ name, per100, macroLine: chosen.r.line, portions, warnings });
  }
  return { dishes, issues };
}

// ------------------------------------------------------------- writing

export type ImportReport = {
  rowsRead: number;
  dishesCreated: number;
  dishesUpdated: number;
  portionsSaved: number;
  issues: RowIssue[];
  warnings: string[];
  unmatchedColumns: string[];
  missingColumns: string[];
};

const REQUIRED: (keyof ColumnMap)[] = ['name', 'netWeightG', 'energy'];

export type WriteCounts = {
  created: number;
  updated: number;
  portionsSaved: number;
  warnings: string[];
  lastFoodId: string | null;
};

/** Write planned dishes to the library. Idempotent — re-running updates. */
export async function writeDishes(dishes: DishPlan[]): Promise<WriteCounts> {
  const warnings: string[] = [];
  let created = 0;
  let updated = 0;
  let portionsSaved = 0;
  let lastFoodId: string | null = null;

  for (const d of dishes) {
    // Match on the slug first, then fall back to the exact name.
    //
    // The slug is what a second device will merge on, so the same dish has to
    // resolve to one row here too — otherwise an import creates locally the
    // duplicate that sync was designed to avoid. It matches a little more
    // loosely than the old name check did: "Boiled Egg" and "Boiled Eggs"
    // normalise alike and are now one dish, which is the intended behaviour
    // and the reason this is a merge key rather than a display name.
    //
    // The name fallback covers rows written before v6 that init has not
    // backfilled yet.
    const slug = slugFor(d.name);
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM custom_foods
        WHERE deleted_at IS NULL AND (slug = ? OR LOWER(name) = ?)
        LIMIT 1`,
      [slug, d.name.trim().toLowerCase()],
    );

    let foodId: string;
    let isNew = false;
    if (existing[0]) {
      foodId = existing[0].id;
      await db.update('custom_foods', foodId, {
        per_unit: '100g',
        ...d.per100,
        slug,
        deleted_at: null,
      });
      updated++;
    } else {
      foodId = await db.insert('custom_foods', {
        name: d.name.trim(),
        slug,
        per_unit: '100g',
        ...d.per100,
        notes: 'imported',
        deleted_at: null,
      });
      created++;
      isNew = true;
    }

    for (const [i, p] of d.portions.entries()) {
      const id = await upsertPortion({
        foodId,
        measure: p.measure,
        quantity: p.quantity,
        netWeightG: p.netWeightG,
        // First listed portion becomes the default, but only for a dish we
        // just created — sheets are written most-common-first, and a re-import
        // should not silently undo a default you picked in the app.
        isDefault: isNew && i === 0,
        source: 'user',
      });
      if (id) portionsSaved++;
    }

    await rememberAlias(d.name, foodId);
    for (const w of d.warnings) warnings.push(`${d.name}: ${w}`);
    lastFoodId = foodId;
  }

  return { created, updated, portionsSaved, warnings, lastFoodId };
}

/** Parse, normalise and write. Safe to run again on the same file. */
export async function importPersonalFoods(text: string): Promise<ImportReport> {
  const { rows, issues, columns, unmatched } = readRows(text);
  const { dishes, issues: planIssues } = planDishes(rows);
  const counts = await writeDishes(dishes);

  return {
    rowsRead: rows.length,
    dishesCreated: counts.created,
    dishesUpdated: counts.updated,
    portionsSaved: counts.portionsSaved,
    issues: [...issues, ...planIssues],
    warnings: counts.warnings,
    unmatchedColumns: unmatched,
    missingColumns: REQUIRED.filter((c) => columns[c] === undefined).map(String),
  };
}

/**
 * Add or correct one dish from a single portion, entered by hand.
 *
 * Takes the same shape as one row of the sheet, deliberately: the form in the
 * app and the spreadsheet should not require two different ways of thinking
 * about the same dish.
 */
export async function saveDishFromPortion(input: {
  name: string;
  quantity: number;
  measure: string | null;
  netWeightG: number | null;
  energy: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fibre: number | null;
}): Promise<{ foodId: string | null; issues: RowIssue[]; warnings: string[] }> {
  const row: PersonalRow = {
    line: 1,
    name: input.name.trim(),
    quantity: input.quantity > 0 ? input.quantity : 1,
    measure: canonicalMeasure(input.measure),
    netWeightG: input.netWeightG,
    energy: input.energy,
    protein: input.protein,
    fat: input.fat,
    carbs: input.carbs,
    fibre: input.fibre,
  };
  if (!row.name) {
    return { foodId: null, issues: [{ line: 1, text: 'Give the dish a name.' }], warnings: [] };
  }
  const { dishes, issues } = planDishes([row]);
  if (dishes.length === 0) return { foodId: null, issues, warnings: [] };
  const counts = await writeDishes(dishes);
  return { foodId: counts.lastFoodId, issues, warnings: counts.warnings };
}

/** The exact header row the importer expects, for a starter file. */
export const TEMPLATE_CSV = [
  'Meal/Ingredient,Quantity,Measure,Net weight (g),Calories (Kcal),Protein (g),Fats (g),Carbs (g),Fiber (g)',
  'Dal tadka,1,katori,150,176,8.4,6.2,21.5,5.1',
  'Dal tadka,1,bowl,250,293,14,10.3,35.8,8.5',
  'Roti,1,piece,40,104,3.1,0.4,20.6,3.2',
  'Curd,1,katori,150,90,5.1,4.9,6.3,0',
  'Boiled egg,1,egg,50,78,6.3,5.3,0.6,0',
].join('\n');

/** Everything in the personal library, as the same CSV. Round-trips. */
export async function exportPersonalFoods(): Promise<string> {
  const foods = await db.query<{
    id: string;
    name: string;
    energy_kcal: number | null;
    protein_g: number | null;
    fat_g: number | null;
    carbs_g: number | null;
    fibre_g: number | null;
  }>(
    `SELECT id, name, energy_kcal, protein_g, fat_g, carbs_g, fibre_g
       FROM custom_foods WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  );
  const portions = await db.query<{
    food_id: string;
    measure: string;
    quantity: number;
    net_weight_g: number;
    is_default: number;
  }>(
    `SELECT food_id, measure, quantity, net_weight_g, is_default
       FROM food_portions WHERE deleted_at IS NULL
      ORDER BY is_default DESC, measure`,
  );

  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [TEMPLATE_CSV.split('\n')[0]];

  for (const f of foods) {
    const mine = portions.filter((p) => p.food_id === f.id);
    const emit = (measure: string, quantity: number, weight: number) => {
      const s = weight / 100;
      const v = (x: number | null) => (x === null ? '' : String(Math.round(x * s * 10) / 10));
      lines.push(
        [
          q(f.name),
          String(quantity),
          measure,
          String(Math.round(weight * 10) / 10),
          v(f.energy_kcal),
          v(f.protein_g),
          v(f.fat_g),
          v(f.carbs_g),
          v(f.fibre_g),
        ].join(','),
      );
    };
    if (mine.length === 0) emit('g', 100, 100);
    else for (const p of mine) emit(p.measure, p.quantity, p.net_weight_g);
  }
  return lines.join('\n');
}
