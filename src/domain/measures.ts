/**
 * The measure vocabulary — the dropdown, and the arithmetic behind it.
 *
 * A measure is one of three kinds, and the kind decides what can be derived
 * from it:
 *
 *   weight  g, kg, ml, l — already a quantity. Nothing to guess.
 *   volume  katori, bowl, cup, tbsp — has a reference volume in ml, so a
 *           density measured once for a dish carries across all of them.
 *           This is what makes "1 katori = 150g" tell us what a bowl weighs.
 *   count   piece, slice, egg, roti — has no volume, and nothing can be
 *           derived from any other measure. A slice of bread weighs what it
 *           weighs; knowing a cup of bread weighs 40g tells you nothing.
 *
 * `grams` is the household fallback used only when the dish itself has no
 * anchor. It is a starting number, and every path that reaches for it says so
 * in the UI rather than presenting it as a measurement.
 *
 * The volume figures are the common Indian kitchen sizes, not US legal cups: a
 * katori is the small steel bowl, a bowl is the bigger one. If yours differ,
 * record one portion for one dish and every other dish measured the same way
 * inherits the correction through density.
 */

export type MeasureKind = 'weight' | 'volume' | 'count';

export type Measure = {
  /** Canonical id, stored in the database. */
  id: string;
  label: string;
  kind: MeasureKind;
  /** Reference volume. Volume measures only. */
  ml?: number;
  /** Household fallback weight for one of these, when the dish has no anchor. */
  grams: number;
  aliases: readonly string[];
  /** Grouping for the dropdown. */
  group: 'Weight & volume' | 'Bowls & spoons' | 'Pieces';
};

export const MEASURES: readonly Measure[] = [
  // ---- weight -----------------------------------------------------------
  { id: 'g',  label: 'g',  kind: 'weight', grams: 1,    group: 'Weight & volume',
    aliases: ['gram', 'grams', 'gm', 'gms'] },
  { id: 'kg', label: 'kg', kind: 'weight', grams: 1000, group: 'Weight & volume',
    aliases: ['kilo', 'kilos', 'kilogram', 'kilograms'] },
  { id: 'ml', label: 'ml', kind: 'weight', grams: 1,    group: 'Weight & volume',
    aliases: ['millilitre', 'millilitres', 'milliliter', 'milliliters', 'cc'] },
  { id: 'l',  label: 'litre', kind: 'weight', grams: 1000, group: 'Weight & volume',
    aliases: ['litre', 'litres', 'liter', 'liters', 'lt'] },

  // ---- volume -----------------------------------------------------------
  { id: 'tsp',     label: 'teaspoon',  kind: 'volume', ml: 5,   grams: 5,   group: 'Bowls & spoons',
    aliases: ['teaspoon', 'teaspoons', 'tsps', 'chamach'] },
  { id: 'tbsp',    label: 'tablespoon', kind: 'volume', ml: 15, grams: 15,  group: 'Bowls & spoons',
    aliases: ['tablespoon', 'tablespoons', 'tbsps', 'tbs'] },
  { id: 'scoop',   label: 'scoop',     kind: 'volume', ml: 30,  grams: 30,  group: 'Bowls & spoons',
    aliases: ['scoops'] },
  { id: 'ladle',   label: 'ladle',     kind: 'volume', ml: 60,  grams: 60,  group: 'Bowls & spoons',
    aliases: ['ladles', 'karchi', 'karchhi'] },
  { id: 'katori',  label: 'katori',    kind: 'volume', ml: 150, grams: 150, group: 'Bowls & spoons',
    aliases: ['katoris', 'katori small', 'small bowl'] },
  { id: 'cup',     label: 'cup',       kind: 'volume', ml: 240, grams: 240, group: 'Bowls & spoons',
    aliases: ['cups'] },
  { id: 'bowl',    label: 'bowl',      kind: 'volume', ml: 250, grams: 250, group: 'Bowls & spoons',
    aliases: ['bowls'] },
  { id: 'glass',   label: 'glass',     kind: 'volume', ml: 250, grams: 250, group: 'Bowls & spoons',
    aliases: ['glasses', 'tumbler'] },
  { id: 'plate',   label: 'plate',     kind: 'volume', ml: 350, grams: 350, group: 'Bowls & spoons',
    aliases: ['plates', 'thali'] },
  { id: 'handful', label: 'handful',   kind: 'volume', ml: 40,  grams: 30,  group: 'Bowls & spoons',
    aliases: ['handfuls', 'mutthi', 'muthi'] },

  // ---- count ------------------------------------------------------------
  // `grams` here is a shrug. Any dish you log more than once should carry its
  // own portion instead; that is what the Save-portion path is for.
  { id: 'piece',   label: 'piece',   kind: 'count', grams: 50,  group: 'Pieces',
    aliases: ['pieces', 'pc', 'pcs', 'no', 'nos', 'number'] },
  { id: 'serving', label: 'serving', kind: 'count', grams: 150, group: 'Pieces',
    aliases: ['servings', 'portion', 'portions', 'helping'] },
  { id: 'slice',   label: 'slice',   kind: 'count', grams: 30,  group: 'Pieces',
    aliases: ['slices'] },
  { id: 'egg',     label: 'egg',     kind: 'count', grams: 50,  group: 'Pieces',
    aliases: ['eggs'] },
  { id: 'roti',    label: 'roti',    kind: 'count', grams: 40,  group: 'Pieces',
    aliases: ['rotis', 'chapati', 'chapatis', 'chapathi', 'phulka', 'phulkas'] },
  { id: 'paratha', label: 'paratha', kind: 'count', grams: 70,  group: 'Pieces',
    aliases: ['parathas', 'parantha', 'paranthas'] },
  { id: 'naan',    label: 'naan',    kind: 'count', grams: 90,  group: 'Pieces',
    aliases: ['naans', 'kulcha', 'kulchas'] },
  { id: 'idli',    label: 'idli',    kind: 'count', grams: 45,  group: 'Pieces',
    aliases: ['idlis', 'idly', 'idlies'] },
  { id: 'dosa',    label: 'dosa',    kind: 'count', grams: 110, group: 'Pieces',
    aliases: ['dosas', 'dosai'] },
  { id: 'biscuit', label: 'biscuit', kind: 'count', grams: 12,  group: 'Pieces',
    aliases: ['biscuits', 'cookie', 'cookies'] },
  { id: 'packet',  label: 'packet',  kind: 'count', grams: 100, group: 'Pieces',
    aliases: ['packets', 'pack', 'packs', 'sachet', 'sachets', 'pouch'] },
  { id: 'bottle',  label: 'bottle',  kind: 'count', grams: 500, group: 'Pieces',
    aliases: ['bottles', 'can', 'cans', 'tetrapack'] },
  { id: 'clove',   label: 'clove',   kind: 'count', grams: 3,   group: 'Pieces',
    aliases: ['cloves', 'kali'] },
  { id: 'whole',   label: 'whole',   kind: 'count', grams: 120, group: 'Pieces',
    aliases: ['full', 'entire', 'unit', 'units', 'each'] },
];

const BY_KEY = new Map<string, Measure>();
for (const m of MEASURES) {
  BY_KEY.set(m.id, m);
  BY_KEY.set(m.label.toLowerCase(), m);
  for (const a of m.aliases) BY_KEY.set(a, m);
}

/** Canonicalise whatever the user typed or the CSV said. Null if unknown. */
export function toMeasure(raw: string | null | undefined): Measure | null {
  if (!raw) return null;
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return null;
  return BY_KEY.get(key) ?? BY_KEY.get(key.replace(/s$/, '')) ?? null;
}

/** The canonical id, for storage. */
export function canonicalMeasure(raw: string | null | undefined): string | null {
  return toMeasure(raw)?.id ?? null;
}

/** Dropdown contents, in groups, in the order declared above. */
export function measureGroups(): { group: string; measures: Measure[] }[] {
  const order: Measure['group'][] = ['Bowls & spoons', 'Pieces', 'Weight & volume'];
  return order.map((group) => ({
    group,
    measures: MEASURES.filter((m) => m.group === group),
  }));
}

/** True when this measure is already a weight and needs no interpretation. */
export function isAbsolute(m: Measure): boolean {
  return m.kind === 'weight';
}
