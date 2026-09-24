/**
 * "Show me what you think, and I'll tell you where you're wrong."
 *
 * Entering a row for every quantity and measure of every dish is exactly the
 * data entry this whole design exists to avoid. The alternative is cheaper and
 * more accurate: record one or two real portions, let the app derive the rest,
 * then look at what it derived and correct only what is off.
 *
 * This module produces that sheet — every quantity/measure combination worth
 * checking for a dish, with the weight and macros the app currently believes,
 * and a column saying whether each number came from something measured or was
 * assumed. Correcting one cell writes a new anchor, and every other row for
 * that dish re-derives from it. Errors collapse in groups rather than one at a
 * time.
 *
 * Pure functions only, so the arithmetic is testable without a database.
 */

import type { Food } from './foods';
import { toMeasure, type Measure } from './measures';
import { resolvePortion, type Anchor, type Basis } from './portions';

/** Quantities worth showing. Half portions are common; thirds are not. */
const QUANTITIES = [0.5, 1, 1.5, 2];

/** Measures offered for a dish that has never been measured by volume. */
const VOLUME_SPREAD = ['katori', 'bowl', 'cup', 'tbsp'];
const COUNT_SPREAD = ['piece'];

export type CheckRow = {
  name: string;
  quantity: number;
  measure: string;
  measureLabel: string;
  grams: number;
  energy: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fibre: number | null;
  basis: Basis;
  /** 'yours' when this exact portion is recorded, else how it was derived. */
  confidence: 'yours' | 'derived' | 'assumed';
  note: string;
};

function scale(per100: number | null | undefined, grams: number): number | null {
  if (per100 === null || per100 === undefined) return null;
  return Math.round(((per100 * grams) / 100) * 10) / 10;
}

/**
 * Which measures to show for a dish.
 *
 * Its own anchors first — those are the rows that should come back unchanged,
 * and seeing them confirms the import landed. Then a spread of the kind the
 * dish is actually eaten in: offering "tablespoons of roti" wastes a line.
 */
export function measuresToCheck(anchors: Anchor[]): Measure[] {
  const out: Measure[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    const m = id ? toMeasure(id) : null;
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };

  for (const a of anchors) push(a.measure);

  const kinds = new Set(anchors.map((a) => toMeasure(a.measure)?.kind));
  if (kinds.has('count')) for (const id of COUNT_SPREAD) push(id);
  if (kinds.has('volume') || anchors.length === 0) {
    for (const id of VOLUME_SPREAD) push(id);
  }
  // A grams row is the control: it must always come out exactly.
  push('g');
  return out;
}

function confidenceOf(basis: Basis): CheckRow['confidence'] {
  if (basis === 'anchor' || basis === 'default' || basis === 'weight') return 'yours';
  if (basis === 'density' || basis === 'sibling') return 'derived';
  // 'restaurant' and 'household' both fall through to 'assumed' below.
  return 'assumed';
}

/** Every combination worth checking for one dish. */
export function checkRowsFor(food: Food, anchors: Anchor[]): CheckRow[] {
  const rows: CheckRow[] = [];
  const anchored = new Set(anchors.map((a) => toMeasure(a.measure)?.id));

  for (const m of measuresToCheck(anchors)) {
    // A gram row only needs one line — 100g is the reference the table is in.
    const quantities =
      m.kind === 'weight'
        ? [100]
        : anchored.has(m.id)
          ? QUANTITIES
          : QUANTITIES.filter((q) => q === 1 || q === 2);

    for (const q of quantities) {
      const r = resolvePortion(q, m.id, anchors);
      rows.push({
        name: food.name,
        quantity: q,
        measure: m.id,
        measureLabel: m.label,
        grams: r.grams,
        energy: scale(food.energy_kcal, r.grams),
        protein: scale(food.protein_g, r.grams),
        fat: scale(food.fat_g, r.grams),
        carbs: scale(food.carbs_g, r.grams),
        fibre: scale(food.fibre_g, r.grams),
        basis: r.basis,
        confidence: confidenceOf(r.basis),
        note: r.note,
      });
    }
  }
  return rows;
}

const csvCell = (s: string) =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/**
 * The check sheet, in the same columns as the import.
 *
 * That is the point: correct a weight in the spreadsheet, re-import the file,
 * and the corrected row becomes an anchor. The two extra columns at the end
 * are ignored on import — they are there so you can see at a glance which
 * numbers were measured and which the app made up.
 */
export function checkSheetCsv(rows: CheckRow[]): string {
  const head =
    'Meal/Ingredient,Quantity,Measure,Net weight (g),Calories (Kcal),' +
    'Protein (g),Fats (g),Carbs (g),Fiber (g),From,How';
  const v = (n: number | null) => (n === null ? '' : String(n));
  return [
    head,
    ...rows.map((r) =>
      [
        csvCell(r.name),
        String(r.quantity),
        r.measure,
        String(r.grams),
        v(r.energy),
        v(r.protein),
        v(r.fat),
        v(r.carbs),
        v(r.fibre),
        r.confidence,
        csvCell(r.note),
      ].join(','),
    ),
  ].join('\n');
}
