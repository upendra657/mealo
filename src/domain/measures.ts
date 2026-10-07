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
  /**
   * True when the size is specific to the place it came from and nothing can
   * be transferred in or out — a restaurant "serve". The resolver refuses to
   * derive these and refuses to derive anything from them.
   */
  needsOwn?: boolean;
  /**
   * Kept in the vocabulary, kept out of the picker.
   *
   * Three sorts of measure earn this. One is the generic serving word — whole,
   * serve, large, regular, burger, bar, nugget — which says "one of these"
   * and nothing more, which is what `piece` already says. Nineteen entries
   * under Pieces meant reading a list to find the one that mattered.
   * The second is the wrong magnitude for a plate of food: kg and litre, when
   * grams already runs to a kilo.
   * The third is the measure that names a food — roti, paratha, naan, idli,
   * dosa, egg, biscuit, clove — plus ladle, scoop and plate, none of which
   * this kitchen logs in. Each named-food measure is only ever used on its
   * own dish, where it means one piece of it, and piece is enough; on any
   * other dish it is nonsense, and "a roti of dal" was one scroll away.
   * Upendra's call, 7 Oct 2026.
   *
   * Hidden rather than deleted, and that distinction is the whole point.
   * `toMeasure` still resolves these, so:
   *   - a meal logged in 'burger' last month still prices correctly;
   *   - an anchor recorded against one still resolves, and still appears in
   *     the picker for that dish, because a dish's own measures are listed
   *     ahead of the vocabulary;
   *   - the importer still understands "2 handfuls", "1 kg", "each", "medium"
   *     in a CSV, which is where half of these aliases were earning their
   *     keep anyway.
   * Deleting them would have turned every one of those into a silent zero.
   */
  hidden?: boolean;
  aliases: readonly string[];
  /** Grouping for the dropdown. */
  group: 'Weight & volume' | 'Bowls & spoons' | 'Pieces';
};

export const MEASURES: readonly Measure[] = [
  // ---- weight -----------------------------------------------------------
  { id: 'g',  label: 'g',  kind: 'weight', grams: 1,    group: 'Weight & volume',
    aliases: ['gram', 'grams', 'gm', 'gms'] },
  { id: 'kg', label: 'kg', kind: 'weight', grams: 1000, hidden: true, group: 'Weight & volume',
    aliases: ['kilo', 'kilos', 'kilogram', 'kilograms'] },
  // A house unit. 100 g flat, so a plate of anything can be logged in round
  // hundreds without anyone deciding whether it was a katori or a bowl.
  //
  // Weight-kind, which is the whole point: it needs no anchor and no density,
  // so it resolves identically for every dish and nothing has to be added to
  // any of them. Count measures are untouched — a roti is still a roti.
  { id: 'tingu', label: 'tingu', kind: 'weight', grams: 100, group: 'Weight & volume',
    aliases: ['tingus'] },
  { id: 'ml', label: 'ml', kind: 'weight', grams: 1,    group: 'Weight & volume',
    aliases: ['millilitre', 'millilitres', 'milliliter', 'milliliters', 'cc'] },
  { id: 'l',  label: 'litre', kind: 'weight', grams: 1000, hidden: true, group: 'Weight & volume',
    aliases: ['litre', 'litres', 'liter', 'liters', 'lt'] },

  // ---- volume -----------------------------------------------------------
  { id: 'tsp',     label: 'teaspoon',  kind: 'volume', ml: 5,   grams: 5,   group: 'Bowls & spoons',
    aliases: ['teaspoon', 'teaspoons', 'tsps', 'chamach'] },
  { id: 'tbsp',    label: 'tablespoon', kind: 'volume', ml: 15, grams: 15,  group: 'Bowls & spoons',
    aliases: ['tablespoon', 'tablespoons', 'tbsps', 'tbs'] },
  { id: 'scoop',   label: 'scoop',     kind: 'volume', ml: 30,  grams: 30,  hidden: true, group: 'Bowls & spoons',
    aliases: ['scoops'] },
  { id: 'ladle',   label: 'ladle',     kind: 'volume', ml: 60,  grams: 60,  hidden: true, group: 'Bowls & spoons',
    aliases: ['ladles', 'karchi', 'karchhi'] },
  { id: 'katori',  label: 'katori',    kind: 'volume', ml: 150, grams: 150, group: 'Bowls & spoons',
    aliases: ['katoris'] },
  // Same 150 ml as a katori, kept as its own entry on purpose: some people
  // reach for "small bowl" and shouldn't have to learn that it means katori.
  { id: 'smallbowl', label: 'small bowl', kind: 'volume', ml: 150, grams: 150, group: 'Bowls & spoons',
    aliases: ['small bowls', 'katori small'] },
  { id: 'teacup',  label: 'teacup',    kind: 'volume', ml: 180, grams: 180, group: 'Bowls & spoons',
    aliases: ['teacups', 'tea cup', 'chai cup'] },
  { id: 'cup',     label: 'cup',       kind: 'volume', ml: 240, grams: 240, group: 'Bowls & spoons',
    aliases: ['cups'] },
  // 350 ml, not 250. Measured: dal tadka is 150g in a katori and 350g in a
  // bowl, which is exactly 150 ml and 350 ml at 1.0 g/ml.
  { id: 'bowl',    label: 'bowl',      kind: 'volume', ml: 350, grams: 350, group: 'Bowls & spoons',
    aliases: ['bowls', 'big bowl', 'large bowl'] },
  { id: 'glass',   label: 'glass',     kind: 'volume', ml: 250, grams: 250, group: 'Bowls & spoons',
    aliases: ['glasses', 'tumbler'] },
  { id: 'plate',   label: 'plate',     kind: 'volume', ml: 350, grams: 350, hidden: true, group: 'Bowls & spoons',
    aliases: ['plates', 'thali'] },
  // A handful is whoever's hand. Kept for the importer, out of the picker.
  { id: 'handful', label: 'handful',   kind: 'volume', ml: 40,  grams: 30,  hidden: true, group: 'Bowls & spoons',
    aliases: ['handfuls', 'mutthi', 'muthi'] },

  // ---- count ------------------------------------------------------------
  // `grams` here is a shrug. Any dish you log more than once should carry its
  // own portion instead; that is what the Save-portion path is for.
  { id: 'piece',   label: 'piece',   kind: 'count', grams: 50,  group: 'Pieces',
    aliases: ['pieces', 'pc', 'pcs', 'no', 'nos', 'number'] },
  // ---- the generic serving words ----------------------------------------
  // Every one of these means "one of whatever this dish is", which is what
  // `piece` says in a word everybody already uses. They stay resolvable for
  // old rows and for the importer; see `hidden` on the type above.
  //
  // A serve is whatever that restaurant plates — 112g of fries or 750g of
  // penne. `needsOwn` stops the resolver inventing one and stops it lending
  // its size to any other measure.
  { id: 'serve',   label: 'serve',   kind: 'count', grams: 300, needsOwn: true, hidden: true, group: 'Pieces',
    aliases: ['serves', 'serving', 'servings', 'portion', 'portions', 'helping', 'plateful'] },
  { id: 'large',   label: 'large',   kind: 'count', grams: 200, needsOwn: true, hidden: true, group: 'Pieces',
    aliases: ['big'] },
  { id: 'regular', label: 'regular', kind: 'count', grams: 100, needsOwn: true, hidden: true, group: 'Pieces',
    aliases: ['standard', 'medium'] },
  { id: 'burger',  label: 'burger',  kind: 'count', grams: 200, needsOwn: true, hidden: true, group: 'Pieces',
    aliases: ['burgers', 'sandwich', 'wrap', 'roll'] },
  { id: 'bar',     label: 'bar',     kind: 'count', grams: 50, hidden: true, group: 'Pieces',
    aliases: ['bars'] },
  { id: 'nugget',  label: 'nugget',  kind: 'count', grams: 35, hidden: true, group: 'Pieces',
    aliases: ['nuggets'] },
  // ---- shapes that name a food, and so carry a weight of their own -------
  // Most are hidden now (see `hidden` above). Their `grams` still earns its
  // keep: it is what a meal logged as "2 roti" before then still weighs, on a
  // dish that was never given a roti portion of its own.
  { id: 'slice',   label: 'slice',   kind: 'count', grams: 30,  group: 'Pieces',
    aliases: ['slices'] },
  { id: 'egg',     label: 'egg',     kind: 'count', grams: 50,  hidden: true, group: 'Pieces',
    aliases: ['eggs'] },
  { id: 'roti',    label: 'roti',    kind: 'count', grams: 40,  hidden: true, group: 'Pieces',
    aliases: ['rotis', 'chapati', 'chapatis', 'chapathi', 'phulka', 'phulkas'] },
  { id: 'paratha', label: 'paratha', kind: 'count', grams: 70,  hidden: true, group: 'Pieces',
    aliases: ['parathas', 'parantha', 'paranthas'] },
  { id: 'naan',    label: 'naan',    kind: 'count', grams: 90,  hidden: true, group: 'Pieces',
    aliases: ['naans', 'kulcha', 'kulchas'] },
  { id: 'idli',    label: 'idli',    kind: 'count', grams: 45,  hidden: true, group: 'Pieces',
    aliases: ['idlis', 'idly', 'idlies'] },
  { id: 'dosa',    label: 'dosa',    kind: 'count', grams: 110, hidden: true, group: 'Pieces',
    aliases: ['dosas', 'dosai'] },
  { id: 'biscuit', label: 'biscuit', kind: 'count', grams: 12,  hidden: true, group: 'Pieces',
    aliases: ['biscuits', 'cookie', 'cookies'] },
  { id: 'packet',  label: 'packet',  kind: 'count', grams: 100, group: 'Pieces',
    aliases: ['packets', 'pack', 'packs', 'sachet', 'sachets', 'pouch'] },
  { id: 'bottle',  label: 'bottle',  kind: 'count', grams: 500, group: 'Pieces',
    aliases: ['bottles', 'can', 'cans', 'tetrapack'] },
  { id: 'clove',   label: 'clove',   kind: 'count', grams: 3,   hidden: true, group: 'Pieces',
    aliases: ['cloves', 'kali'] },
  { id: 'whole',   label: 'whole',   kind: 'count', grams: 120, hidden: true, group: 'Pieces',
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

/**
 * A measure as the picker should show it: "katori (150 ml)", "piece", "g".
 *
 * The volume is on the label because a katori and a small bowl are the same
 * 150 ml and a cup is not, and picking between them blind is guesswork. A
 * count measure has no volume to show, and a restaurant portion has one that
 * would be a lie — `needsOwn` means the size came from one specific plate, so
 * quoting an average as though it were a standard is exactly the impression
 * not to give.
 */
export function describeMeasure(x: Measure | string | null | undefined): string {
  const mm = typeof x === 'string' ? toMeasure(x) : x;
  if (!mm) return '';
  // Spelt out in the picker, abbreviated everywhere else. A list of measures
  // wants "Grams" beside "Katori (150 ml)"; a logged row wants "450 g", and
  // capitalising the label would give the list a shouted "G".
  const spelt: Record<string, string> = {
    g: 'Grams',
    kg: 'Kilograms',
    ml: 'Millilitres',
    l: 'Litres',
    tingu: 'Tingu (100 g)',
  };
  const name = spelt[mm.id] ?? mm.label.charAt(0).toUpperCase() + mm.label.slice(1);
  if (mm.kind === 'volume' && mm.ml && !mm.needsOwn) return `${name} (${mm.ml} ml)`;
  return name;
}

/**
 * What the picker offers, in order.
 *
 * Not every measure — the hidden ones are still in `MEASURES` and still
 * resolve, they are just not worth a row in a list you scroll past three
 * times a day. A dish's own anchors are listed ahead of this by the caller,
 * so a hidden measure that a dish has actually been weighed in still appears
 * for that dish.
 */
export function allMeasureIds(): string[] {
  return MEASURES.filter((x) => !x.hidden).map((x) => x.id);
}

/**
 * What the log's measure wheel offers for one dish, in order.
 *
 * The dish's own measures lead, then the unit the meal was opened in if
 * neither list has it, then the picker. That middle entry is for a meal
 * logged in a measure since hidden — "2 roti" from before roti left the
 * picker. Without it the wheel cannot find the meal's unit, highlights its
 * first row instead, and reads "Piece" over a meal that says roti.
 *
 * `opened` must be the unit the screen opened with, not the live one.
 * Following the live unit drops roti from the list the moment the wheel
 * moves off it, every row below shifts up one under the finger, and the
 * wheel's next report names the row beneath the one it shows.
 */
export function wheelMeasures(own: readonly string[], opened: string | null): string[] {
  const offered = allMeasureIds();
  const kept = opened && !own.includes(opened) && !offered.includes(opened) ? [opened] : [];
  return [...own, ...kept, ...offered.filter((id) => !own.includes(id))];
}

/** Every measure, hidden ones included. For the resolver and the importer. */
export function everyMeasureId(): string[] {
  return MEASURES.map((x) => x.id);
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
    measures: MEASURES.filter((m) => m.group === group && !m.hidden),
  }));
}

/** True when this measure is already a weight and needs no interpretation. */
export function isAbsolute(m: Measure): boolean {
  return m.kind === 'weight';
}
