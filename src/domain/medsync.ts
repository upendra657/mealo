/**
 * The medicine library's half of sync: reading it out, and writing the other
 * phone's back in.
 *
 * The same rules as librarysync.ts, which this mirrors on purpose — read its
 * header first. Above all: every write here carries the sender's updated_at
 * through raw SQL, never db.update's now(), or two phones trade the same
 * medicine forever.
 *
 * Separate from the food half because these tables are the Pharmacist's, and
 * the handle is what says so. Three things differ from food:
 *
 *   A private medicine never leaves. Not its entry, not its ingredients, not
 *   its starting schedule. Filtered at the query, so no later code can forget.
 *
 *   An incoming entry never makes a local one private or public. If she has a
 *   private Thyroxine 50 mcg and his shared one arrives, the two are the same
 *   strip and merge, but hers stays off the wire — he already has it, and
 *   what she asked for was that hers not be sent.
 *
 *   Ingredients and schedule rows are rewritten whole on every save: the old
 *   rows soft-deleted, new ones inserted at positions 1..n. So one position
 *   can hold a tombstone and a live row with the same timestamp, and the
 *   wire has to say which is the truth. The live one is — sent with the
 *   newest timestamp of any row at that position, so the other phone takes it.
 */

import { scopedDb } from '../db/scope';
import { kvGet, kvSet } from '../lib/kv';
import { newId } from '../lib/device';
import { medSlug } from './doses';
import { collapse, nextCursor, resolve, type SyncTable, type WireRow } from './sync';

const db = scopedDb('pharmacist');

/**
 * Its own push cursor, not the food one. The food cursor already sits at the
 * newest dish this phone ever sent, and every medicine row written before
 * this file shipped is older than that — sharing the cursor would leave them
 * below it and never sent.
 */
const PUSH_KV = 'sync.medPushCursor';

export async function medPushCursor(): Promise<number> {
  return (await kvGet<number>(PUSH_KV)) ?? 0;
}
export async function setMedPushCursor(rows: WireRow[]): Promise<void> {
  await kvSet(PUSH_KV, nextCursor(rows, await medPushCursor()));
}

// ------------------------------------------------------------- collecting

type ChildRow = {
  product_slug: string | null;
  product_name: string;
  product_strength: string | null;
  position: number;
  updated_at: number;
  deleted_at: number | null;
  [k: string]: unknown;
};

/**
 * One wire row per position: the live row if there is one, else the newest
 * tombstone (the list got shorter), stamped with the newest time anything at
 * that position changed.
 */
function bySlot(
  t: SyncTable,
  rows: ChildRow[],
  fields: (r: ChildRow) => Record<string, string | number | null>,
): WireRow[] {
  const slots = new Map<string, ChildRow[]>();
  for (const r of rows) {
    const slug = r.product_slug || medSlug(r.product_name, r.product_strength);
    if (!slug) continue;
    const k = `${slug}|${r.position}`;
    slots.set(k, [...(slots.get(k) ?? []), { ...r, product_slug: slug }]);
  }
  const out: WireRow[] = [];
  for (const [k, list] of slots) {
    const live = list.find((r) => r.deleted_at === null);
    const newest = list.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
    const pick = live ?? newest;
    out.push({
      t,
      k,
      at: Math.max(...list.map((r) => r.updated_at)),
      del: live ? null : newest.deleted_at,
      f: { product_slug: pick.product_slug, position: pick.position, ...fields(pick) },
    });
  }
  return out;
}

/** Everything in the shared medicine library changed since the cursor. */
export async function collectMeds(cursor: number): Promise<WireRow[]> {
  const out: WireRow[] = [];

  const products = await db.query<{
    slug: string | null;
    name: string;
    form: string | null;
    strength_text: string | null;
    hidden: number;
    updated_at: number;
    deleted_at: number | null;
  }>(
    `SELECT slug, name, form, strength_text, hidden, updated_at, deleted_at
       FROM med_products WHERE updated_at >= ? AND private = 0`,
    [cursor],
  );
  for (const p of products) {
    const slug = p.slug || medSlug(p.name, p.strength_text);
    if (!slug) continue;
    out.push({
      t: 'med_products',
      k: slug,
      at: p.updated_at,
      del: p.deleted_at,
      f: { slug, name: p.name, form: p.form, strength_text: p.strength_text, hidden: p.hidden },
    });
  }

  // A changed position carries every row at it, including the ones older than
  // the cursor, so the live-or-tombstone choice is made with the whole slot in
  // view. Selecting only rows past the cursor could see the tombstone of a
  // rewrite and miss the live row that replaced it in the same millisecond.
  const changedSlots = `
    (c.product_id, c.position) IN (
      SELECT product_id, position FROM %T WHERE updated_at >= ?)`;

  const ingredients = await db.query<ChildRow>(
    `SELECT p.slug AS product_slug, p.name AS product_name, p.strength_text AS product_strength,
            c.position, c.name, c.strength_text, c.updated_at, c.deleted_at
       FROM med_product_ingredients c
       JOIN med_products p ON p.id = c.product_id
      WHERE p.private = 0 AND ${changedSlots.replace('%T', 'med_product_ingredients')}`,
    [cursor],
  );
  out.push(...bySlot('med_product_ingredients', ingredients, (r) => ({
    name: r.name as string,
    strength_text: (r.strength_text as string | null) ?? null,
  })));

  const doses = await db.query<ChildRow>(
    `SELECT p.slug AS product_slug, p.name AS product_name, p.strength_text AS product_strength,
            c.position, c.amount, c.unit, c.time_of_day, c.meal, c.freq, c.freq_days,
            c.updated_at, c.deleted_at
       FROM med_product_doses c
       JOIN med_products p ON p.id = c.product_id
      WHERE p.private = 0 AND ${changedSlots.replace('%T', 'med_product_doses')}`,
    [cursor],
  );
  out.push(...bySlot('med_product_doses', doses, (r) => ({
    amount: (r.amount as number | null) ?? null,
    unit: (r.unit as string | null) ?? null,
    time_of_day: (r.time_of_day as string | null) ?? null,
    meal: (r.meal as string | null) ?? null,
    // So a weekly medicine arrives weekly. A batch from before this was added
    // has no freq, which reads as every day — what it was.
    freq: (r.freq as string | null) ?? null,
    freq_days: (r.freq_days as string | null) ?? null,
  })));

  return out;
}

// -------------------------------------------------------------- applying

export type MedsApplied = { medicines: number; skipped: number };

/** Write the other phone's medicine rows in. Entries first, so the rest resolve. */
export async function applyMeds(rows: WireRow[]): Promise<MedsApplied> {
  const best = collapse(rows);
  const stats: MedsApplied = { medicines: 0, skipped: 0 };
  const order: SyncTable[] = ['med_products', 'med_product_ingredients', 'med_product_doses'];
  for (const table of order) {
    for (const r of best.values()) {
      if (r.t !== table) continue;
      try {
        if ((await applyOne(r)) === 'skip') stats.skipped++;
        else if (table === 'med_products') stats.medicines++;
      } catch {
        // One malformed row must not abandon the rest of the batch.
        stats.skipped++;
      }
    }
  }
  return stats;
}

async function productId(slug: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM med_products WHERE slug = ? ORDER BY updated_at LIMIT 1',
    [slug],
  );
  return rows[0]?.id ?? null;
}

async function applyOne(r: WireRow): Promise<'wrote' | 'skip'> {
  if (r.t === 'med_products') {
    const slug = String(r.f.slug ?? '');
    const local = await db.query<{ id: string; updated_at: number; deleted_at: number | null }>(
      'SELECT id, updated_at, deleted_at FROM med_products WHERE slug = ? ORDER BY updated_at LIMIT 1',
      [slug],
    );
    if (!local[0]) {
      if (r.del) return 'skip'; // a delete for a medicine we never had
      await db.run(
        `INSERT INTO med_products
           (id, slug, name, form, strength_text, private, hidden, updated_at, deleted_at)
         VALUES (?,?,?,?,?,0,?,?,?)`,
        [await newId(), slug, r.f.name, r.f.form ?? null, r.f.strength_text ?? null,
         Number(r.f.hidden ?? 0), r.at, r.del],
      );
      return 'wrote';
    }
    const verdict = resolve(
      'med_products',
      { updated_at: local[0].updated_at, deleted_at: local[0].deleted_at, id: local[0].id },
      { updated_at: r.at, deleted_at: r.del },
    );
    if (verdict === 'local') return 'skip';
    // `private` is not in this list. See the header.
    await db.run(
      `UPDATE med_products
          SET name=?, form=?, strength_text=?, hidden=?, updated_at=?, deleted_at=?
        WHERE id=?`,
      [r.f.name, r.f.form ?? null, r.f.strength_text ?? null, Number(r.f.hidden ?? 0),
       r.at, r.del, local[0].id],
    );
    return 'wrote';
  }

  const table = r.t === 'med_product_ingredients' ? 'med_product_ingredients' : 'med_product_doses';
  const pid = await productId(String(r.f.product_slug ?? ''));
  if (!pid) return 'skip'; // its medicine has not arrived yet; next sync
  const position = Number(r.f.position);

  // The live row at this position if there is one: that is the one a person
  // here would have edited, and the one the incoming row is competing with.
  const local = await db.query<{ id: string; updated_at: number; deleted_at: number | null }>(
    `SELECT id, updated_at, deleted_at FROM ${table}
      WHERE product_id = ? AND position = ?
      ORDER BY deleted_at IS NULL DESC, updated_at DESC LIMIT 1`,
    [pid, position],
  );

  const values =
    table === 'med_product_ingredients'
      ? { name: r.f.name ?? '', strength_text: r.f.strength_text ?? null }
      : { amount: r.f.amount ?? null, unit: r.f.unit ?? null,
          time_of_day: r.f.time_of_day ?? null, meal: r.f.meal ?? null,
          freq: r.f.freq ?? null, freq_days: r.f.freq_days ?? null };
  const cols = Object.keys(values);

  if (!local[0]) {
    if (r.del) return 'skip';
    await db.run(
      `INSERT INTO ${table} (id, product_id, position, ${cols.join(', ')}, updated_at, deleted_at)
       VALUES (?,?,?,${cols.map(() => '?').join(',')},?,?)`,
      [await newId(), pid, position, ...Object.values(values), r.at, r.del],
    );
    return 'wrote';
  }
  const verdict = resolve(
    r.t,
    { updated_at: local[0].updated_at, deleted_at: local[0].deleted_at, id: local[0].id },
    { updated_at: r.at, deleted_at: r.del },
  );
  if (verdict === 'local') return 'skip';
  await db.run(
    `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=?, deleted_at=?
      WHERE id=?`,
    [...Object.values(values), r.at, r.del, local[0].id],
  );
  return 'wrote';
}
