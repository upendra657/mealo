/**
 * Quantity → net weight → macros, elastically.
 *
 * The problem this solves: a food table says "per 100g" and a person says
 * "one katori". Bridging those with a fixed constant per unit — a katori is
 * always 150g, a bowl is always 250g — is wrong for almost every dish, because
 * a katori of dal and a katori of rice and a katori of curd weigh three
 * different things.
 *
 * So the bridge is per dish, and it is learned rather than assumed. One row of
 * "1 katori dal = 150g" is an *anchor*. From a single anchor we can derive:
 *
 *   - any quantity of the same measure, linearly (1.5 katori → 225g)
 *   - any other bowl-or-spoon measure, through the density that anchor
 *     implies (150g in a 150ml katori → 1.0 g/ml → a 250ml bowl is 250g)
 *   - grams when no measure is given at all, from the dish's default portion
 *     ("2 roti" → 2 × 40g, not 2 × 100g)
 *
 * Everything returns *why* alongside the number. A weight derived from the
 * user's own measurement and a weight guessed from a global table are not the
 * same kind of fact, and the UI says which one it is showing rather than
 * rendering both in the same grey text.
 *
 * The arithmetic below is deliberately pure and separated from the database
 * calls, so it can be tested without a browser. See scripts/test-portions.mjs.
 */

import { scopedDb } from '../db/scope';
import { canonicalMeasure, toMeasure, type Measure } from './measures';

const db = scopedDb('nutritionist');

export type Portion = {
  id: string;
  food_id: string;
  measure: string;
  quantity: number;
  net_weight_g: number;
  is_default: number;
  source: 'user' | 'derived';
  updated_at: number;
  deleted_at: number | null;
};

/** The anchor shape the pure resolver needs — a Portion minus the bookkeeping. */
export type Anchor = {
  measure: string;
  quantity: number;
  net_weight_g: number;
  is_default?: number;
};

export type Basis =
  /** You gave a weight or a volume outright. */
  | 'weight'
  /** This dish has a recorded portion for exactly this measure. */
  | 'anchor'
  /** Derived from this dish's density, measured on a different bowl or spoon. */
  | 'density'
  /** Borrowed from this dish's only other per-piece portion. */
  | 'sibling'
  /** No measure given, so the dish's default portion was used. */
  | 'default'
  /** Nothing dish-specific — a generic household size. */
  | 'household'
  /** Nothing at all to go on. */
  | 'unknown';

export type Resolution = {
  grams: number;
  basis: Basis;
  /** Canonical measure actually used, null when none was given or known. */
  measure: string | null;
  quantity: number;
  /** True when the number came from this dish, false when it was assumed. */
  measured: boolean;
  note: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Grams for one unit of an anchor's measure. */
function perUnit(a: Anchor): number {
  return a.quantity > 0 ? a.net_weight_g / a.quantity : a.net_weight_g;
}

/**
 * g/ml implied by a dish's bowl-or-spoon anchors.
 *
 * Prefers the default anchor, then the largest vessel — a tablespoon
 * measurement carries more rounding error per ml than a bowl does.
 */
export function densityFrom(anchors: Anchor[]): { density: number; from: Measure } | null {
  const vols = anchors
    .map((a) => ({ a, m: toMeasure(a.measure) }))
    .filter((x): x is { a: Anchor; m: Measure } => !!x.m && x.m.kind === 'volume' && !!x.m.ml);
  if (vols.length === 0) return null;
  vols.sort((x, y) => {
    const d = (y.a.is_default ?? 0) - (x.a.is_default ?? 0);
    return d !== 0 ? d : (y.m.ml ?? 0) - (x.m.ml ?? 0);
  });
  const best = vols[0];
  return { density: perUnit(best.a) / (best.m.ml as number), from: best.m };
}

/**
 * The whole thing, as one pure function.
 *
 * `anchors` are this dish's recorded portions. Pass an empty array for a dish
 * that has none and the result falls back to household sizes, flagged.
 */
export function resolvePortion(
  quantity: number | null,
  measureRaw: string | null,
  anchors: Anchor[] = [],
): Resolution {
  const q = quantity == null || quantity <= 0 ? 1 : quantity;
  const id = canonicalMeasure(measureRaw);
  const m = id ? toMeasure(id) : null;

  // --- no measure given -------------------------------------------------
  if (!m) {
    const fallback =
      anchors.find((a) => a.is_default) ??
      (anchors.length === 1 ? anchors[0] : undefined) ??
      anchors[0];
    if (fallback) {
      const unit = perUnit(fallback);
      const label = toMeasure(fallback.measure)?.label ?? fallback.measure;
      return {
        grams: round1(q * unit),
        basis: 'default',
        measure: fallback.measure,
        quantity: q,
        measured: true,
        note: `${q} × ${label} (${round1(unit)}g each, your portion)`,
      };
    }
    return {
      grams: round1(q * 100),
      basis: 'unknown',
      measure: null,
      quantity: q,
      measured: false,
      note: 'no portion recorded — assuming 100g, edit if wrong',
    };
  }

  const exact = anchors.find((a) => canonicalMeasure(a.measure) === m.id);

  // --- an outright weight or volume -------------------------------------
  if (m.kind === 'weight') {
    // ml and litres are a volume wearing a weight's clothes. If the dish has
    // told us its density, use it — a glass of oil is not 250g.
    if ((m.id === 'ml' || m.id === 'l') && !exact) {
      const d = densityFrom(anchors);
      if (d && Math.abs(d.density - 1) > 0.02) {
        const ml = q * (m.id === 'l' ? 1000 : 1);
        return {
          grams: round1(ml * d.density),
          basis: 'density',
          measure: m.id,
          quantity: q,
          measured: true,
          note: `${ml}ml at ${round1(d.density * 100) / 100} g/ml, from your ${d.from.label}`,
        };
      }
    }
    return {
      grams: round1(q * m.grams),
      basis: 'weight',
      measure: m.id,
      quantity: q,
      measured: true,
      note: `${q}${m.label} as given`,
    };
  }

  // --- this dish, this measure ------------------------------------------
  if (exact) {
    const unit = perUnit(exact);
    return {
      grams: round1(q * unit),
      basis: 'anchor',
      measure: m.id,
      quantity: q,
      measured: true,
      note: `your ${m.label} is ${round1(unit)}g`,
    };
  }

  // --- this dish, a different bowl or spoon ------------------------------
  if (m.kind === 'volume' && m.ml) {
    const d = densityFrom(anchors);
    if (d) {
      return {
        grams: round1(q * m.ml * d.density),
        basis: 'density',
        measure: m.id,
        quantity: q,
        measured: true,
        note: `from your ${d.from.label} — ${round1(d.density * 100) / 100} g/ml`,
      };
    }
  }

  // --- this dish, its only other per-piece portion ------------------------
  if (m.kind === 'count') {
    const counts = anchors.filter((a) => toMeasure(a.measure)?.kind === 'count');
    if (counts.length === 1) {
      const unit = perUnit(counts[0]);
      const label = toMeasure(counts[0].measure)?.label ?? counts[0].measure;
      return {
        grams: round1(q * unit),
        basis: 'sibling',
        measure: m.id,
        quantity: q,
        measured: true,
        note: `using your ${label} weight, ${round1(unit)}g each`,
      };
    }
  }

  // --- nothing dish-specific ---------------------------------------------
  return {
    grams: round1(q * m.grams),
    basis: 'household',
    measure: m.id,
    quantity: q,
    measured: false,
    note: `typical ${m.label} ≈ ${m.grams}g — record yours to make this exact`,
  };
}

/** One-line label for the UI, kept short enough for a phone. */
export function describe(r: Resolution): string {
  return `${r.grams}g — ${r.note}`;
}

// --------------------------------------------------------------- database

export async function portionsFor(foodId: string): Promise<Portion[]> {
  return db.query<Portion>(
    `SELECT * FROM food_portions
      WHERE food_id = ? AND deleted_at IS NULL
      ORDER BY is_default DESC, measure`,
    [foodId],
  );
}

export async function portionsForMany(
  foodIds: string[],
): Promise<Map<string, Portion[]>> {
  const out = new Map<string, Portion[]>();
  if (foodIds.length === 0) return out;
  const holes = foodIds.map(() => '?').join(',');
  const rows = await db.query<Portion>(
    `SELECT * FROM food_portions
      WHERE deleted_at IS NULL AND food_id IN (${holes})
      ORDER BY is_default DESC, measure`,
    foodIds,
  );
  for (const r of rows) {
    const list = out.get(r.food_id) ?? [];
    list.push(r);
    out.set(r.food_id, list);
  }
  return out;
}

/** Resolve against a dish's stored anchors. The everyday entry point. */
export async function resolveFor(
  foodId: string | null,
  quantity: number | null,
  measure: string | null,
): Promise<Resolution> {
  const anchors = foodId ? await portionsFor(foodId) : [];
  return resolvePortion(quantity, measure, anchors);
}

/**
 * Record what a measure weighs for a dish.
 *
 * One row per (dish, measure) — recording a katori twice corrects it rather
 * than accumulating contradictions. A user measurement always replaces a
 * derived one; a derived one never overwrites something you measured.
 */
export async function upsertPortion(p: {
  foodId: string;
  measure: string;
  quantity?: number;
  netWeightG: number;
  isDefault?: boolean;
  source?: 'user' | 'derived';
}): Promise<string | null> {
  const measure = canonicalMeasure(p.measure);
  if (!measure || !(p.netWeightG > 0)) return null;
  const quantity = p.quantity && p.quantity > 0 ? p.quantity : 1;
  const source = p.source ?? 'user';

  const existing = await db.query<Portion>(
    `SELECT * FROM food_portions
      WHERE food_id = ? AND measure = ? LIMIT 1`,
    [p.foodId, measure],
  );

  if (existing[0]) {
    if (existing[0].source === 'user' && source === 'derived') return existing[0].id;
    await db.update('food_portions', existing[0].id, {
      quantity,
      net_weight_g: p.netWeightG,
      source,
      is_default: p.isDefault ? 1 : existing[0].is_default,
      deleted_at: null,
    });
    if (p.isDefault) await setDefaultPortion(p.foodId, existing[0].id);
    return existing[0].id;
  }

  const hasAny = (await portionsFor(p.foodId)).length > 0;
  const id = await db.insert('food_portions', {
    food_id: p.foodId,
    measure,
    quantity,
    net_weight_g: p.netWeightG,
    // First portion recorded for a dish is its default — it is the only
    // answer available, and being asked to nominate one is friction.
    is_default: p.isDefault || !hasAny ? 1 : 0,
    source,
    deleted_at: null,
  });
  if (p.isDefault) await setDefaultPortion(p.foodId, id);
  return id;
}

export async function setDefaultPortion(
  foodId: string,
  portionId: string,
): Promise<void> {
  await db.run(
    'UPDATE food_portions SET is_default = 0, updated_at = ? WHERE food_id = ?',
    [Date.now(), foodId],
  );
  await db.update('food_portions', portionId, { is_default: 1 });
}

export async function deletePortion(id: string): Promise<void> {
  await db.softDelete('food_portions', id);
}
