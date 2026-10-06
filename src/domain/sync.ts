/**
 * Syncing the household's libraries between two phones.
 *
 * Six tables travel: `custom_foods`, `food_portions`, `food_aliases`, and
 * since v10 the medicine library — `med_products` and its ingredients and
 * starting schedule. Nothing that records a body travels: no meal, no dose
 * taken, no sickness.
 * `foods` does not — it ships bundled, has no `updated_at` or `deleted_at`,
 * no agent may write it, and both devices already hold byte-identical rows
 * with identical ids. Sending it would be sending a copy of the app.
 *
 * ---------------------------------------------------------------------------
 * The problem this file exists to solve
 * ---------------------------------------------------------------------------
 *
 * Row ids are device-scoped and random (lib/device.ts). That is right for a
 * meal and wrong for a dish, which v6 already fixed for `custom_foods` by
 * giving every dish a `slug` derived from its name: two phones adding "Dal
 * Tadka" independently arrive at the same slug without talking.
 *
 * But a portion row says `food_id`, and that is her `custom_foods.id`, which
 * means nothing on his device. Ship it verbatim and you get an anchor
 * pointing at a dish that does not exist — silently, because SQLite has no
 * foreign keys here to complain. The portion would simply never resolve, and
 * "1 katori = 150g" would quietly go missing from half the library.
 *
 * So nothing that crosses the wire carries a local id. A portion travels as
 * `(food_slug, measure)` and an alias as `(alias, food_slug)`, and the
 * receiving device looks the slug up in its own table. Slugs are the only
 * identity two devices share, which is what makes them the merge key for all
 * three tables:
 *
 *     custom_foods    slug
 *     food_portions   food_slug + measure     (already UNIQUE locally)
 *     food_aliases    alias
 *
 * ---------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------------
 *
 * Last write wins on `updated_at`, per merge key, with one exception that is
 * not arbitrary: a portion whose `source` is 'user' beats one whose source is
 * 'derived' regardless of which is newer. A derived portion is the app's own
 * arithmetic and a user portion is a number somebody put on a scale, and
 * letting the first overwrite the second because it happened to be written
 * later would launder a guess into a measurement — the same rule
 * `upsertPortion` already enforces locally.
 *
 * Ties on `updated_at` go to the row whose id sorts lower. Arbitrary, but it
 * has to be *the same* arbitrary on both devices or they never converge.
 *
 * Deletes are soft everywhere, so they merge like any other edit: a row with
 * `deleted_at` set and a newer `updated_at` wins and the dish disappears on
 * both phones. There is no way to express "delete this and mean it" across
 * devices, and a hard delete could not be synced at all.
 *
 * Everything below the wire types is pure — no database, no network, no
 * clock. That is what lets the merge rules be tested exhaustively rather than
 * exercised by hand with two phones.
 */

export const SYNC_TABLES = [
  'custom_foods',
  'food_portions',
  'food_aliases',
  // The medicine library (v10), on the same terms as the food one: what a
  // medicine is travels, who takes it does not. The rows are read and written
  // by medsync.ts, through the Pharmacist's handle.
  'med_products',
  'med_product_ingredients',
  'med_product_doses',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export const MED_TABLES: readonly SyncTable[] = [
  'med_products',
  'med_product_ingredients',
  'med_product_doses',
];
export const isMedTable = (t: SyncTable) => MED_TABLES.includes(t);

/**
 * A row as it crosses the wire.
 *
 * Deliberately not the local row: no `id`, because a device-scoped id means
 * nothing to the other device, and carrying one would invite somebody to
 * write it into a foreign key later.
 */
export type WireRow = {
  t: SyncTable;
  /** The merge key, already built. See `wireKey`. */
  k: string;
  /** updated_at, ms. */
  at: number;
  /** deleted_at, ms, or null. */
  del: number | null;
  /** Everything else the table needs, minus ids. */
  f: Record<string, string | number | null>;
};

export type Batch = {
  /** Wire format version, so an older phone can refuse politely. */
  v: WireVersion;
  rows: WireRow[];
};

/**
 * 2 since batches began carrying medicines. A phone still on the old code
 * reads only 1, so it drops a 2 whole rather than misfiling a medicine row as
 * a food alias — its own fallthrough branch. It does still move past the
 * batch, which is why an updated phone re-reads the relay once (relay.ts).
 */
export type WireVersion = 1 | 2;
export const WIRE_VERSION: WireVersion = 2;
export const READS: readonly number[] = [1, 2];

/** The merge key for a wire row. Same string on both devices, or nothing works. */
export function wireKey(t: SyncTable, f: Record<string, unknown>): string {
  switch (t) {
    case 'custom_foods':
      return String(f.slug ?? '');
    case 'food_portions':
      return `${String(f.food_slug ?? '')}|${String(f.measure ?? '')}`;
    case 'food_aliases':
      return String(f.alias ?? '');
    case 'med_products':
      return String(f.slug ?? '');
    // Ingredients and schedule rows are numbered within their medicine and
    // rewritten whole on every save, so the slot is the identity: whatever is
    // live at position 2 of Calcium + D3 is "the second ingredient".
    case 'med_product_ingredients':
    case 'med_product_doses':
      return `${String(f.product_slug ?? '')}|${String(f.position ?? '')}`;
  }
}

/** True when the row carries enough to be merged at all. */
export function isAddressable(r: WireRow): boolean {
  if (!r.k || r.k === '|') return false;
  if (r.t === 'food_portions' && !String(r.f.food_slug ?? '')) return false;
  if (r.t === 'food_aliases' && !String(r.f.food_slug ?? '')) return false;
  if (r.t === 'med_product_ingredients' || r.t === 'med_product_doses') {
    if (!String(r.f.product_slug ?? '')) return false;
    // Positions start at 1. Number(null) is 0, which isFinite would wave
    // through, filing a row with no position at a slot nothing else uses.
    const pos = Number(r.f.position);
    if (!Number.isInteger(pos) || pos < 1) return false;
  }
  return Number.isFinite(r.at);
}

export type Side = {
  updated_at: number;
  deleted_at: number | null;
  /** Only meaningful for food_portions. */
  source?: string | null;
  /** Tie-break of last resort. */
  id?: string;
};

export type Verdict = 'incoming' | 'local';

/**
 * Which of two versions of the same thing survives.
 *
 * Pure, total, and symmetric in the sense that matters: run it on both
 * devices with the sides swapped and it picks the same row, which is the
 * whole definition of converging.
 */
export function resolve(t: SyncTable, local: Side, incoming: Side): Verdict {
  // A measured portion is not overwritten by a derived one, newer or not.
  // The app's arithmetic never gets to bury somebody's scale reading.
  if (t === 'food_portions') {
    const lUser = local.source === 'user';
    const iUser = incoming.source === 'user';
    if (lUser !== iUser) return lUser ? 'local' : 'incoming';
  }

  if (incoming.updated_at > local.updated_at) return 'incoming';
  if (incoming.updated_at < local.updated_at) return 'local';

  // Same millisecond. Pick by id so both devices pick the same one; without
  // this they can disagree forever and each keep re-pushing its own.
  const li = local.id ?? '';
  const ii = incoming.id ?? '';
  if (ii === li) return 'local';
  return ii < li ? 'incoming' : 'local';
}

/**
 * Collapse a batch to one row per key, so applying it is a single pass.
 *
 * A device that edited the same dish three times since the last sync sends
 * three rows. Only the survivor matters, and resolving in memory first means
 * the database sees one write instead of three.
 */
export function collapse(rows: WireRow[]): Map<string, WireRow> {
  const best = new Map<string, WireRow>();
  for (const r of rows) {
    if (!isAddressable(r)) continue;
    const id = `${r.t}:${r.k}`;
    const prev = best.get(id);
    if (!prev) {
      best.set(id, r);
      continue;
    }
    const verdict = resolve(
      r.t,
      { updated_at: prev.at, deleted_at: prev.del, source: prev.f.source as string | null },
      { updated_at: r.at, deleted_at: r.del, source: r.f.source as string | null },
    );
    if (verdict === 'incoming') best.set(id, r);
  }
  return best;
}

/**
 * The high-water mark to remember after pushing.
 *
 * The largest `updated_at` actually sent, not "now". Using the clock would
 * skip any row written while the request was in flight — a dish added during
 * a slow push would sit below the new cursor and never be sent again.
 */
export function nextCursor(rows: WireRow[], previous: number): number {
  let hi = previous;
  for (const r of rows) if (r.at > hi) hi = r.at;
  return hi;
}

/**
 * Rows to send, given everything changed since the cursor.
 *
 * Inclusive of the cursor itself on purpose: `updated_at` has millisecond
 * resolution and two rows can share one, so `>` would drop the second.
 * Re-sending a row that has already been applied is free — it resolves to a
 * tie and changes nothing — while dropping one loses a dish.
 */
export function since(rows: { updated_at: number }[], cursor: number) {
  return rows.filter((r) => r.updated_at >= cursor);
}
