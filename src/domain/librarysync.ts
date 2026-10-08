/**
 * Reading the library out, and writing the other phone's back in.
 *
 * The rules for who wins live in sync.ts and are pure. This is the half that
 * touches the database and the network, kept separate so those rules stay
 * testable without either.
 *
 * ---------------------------------------------------------------------------
 * The rule that makes sync stop rather than run forever
 * ---------------------------------------------------------------------------
 *
 * Applying an incoming row must write the sender's `updated_at`, not now().
 *
 * `db.update` stamps `updated_at` on every write, which is right for a person
 * editing a dish and catastrophic here: the applied row would look locally
 * modified, be collected by the next push, arrive at the other phone, look
 * modified *there*, and come back. Two devices would trade the same dish
 * forever, burning D1 writes and never converging. So everything in this file
 * writes through raw SQL with the timestamp carried across verbatim — the
 * same reason `initFoodLibrary` does.
 *
 * ---------------------------------------------------------------------------
 * Two cursors, and why they are different things
 * ---------------------------------------------------------------------------
 *
 *   push  the highest local `updated_at` already sent. Local clock.
 *   pull  the highest relay `seq` already consumed. Relay's counter.
 *
 * They are not comparable and must never be conflated. Both live in
 * IndexedDB rather than SQLite: they describe this device's relationship to
 * the relay, not anything about the food, and a database restored from an
 * export should not inherit some other device's idea of what it has seen.
 *
 * ---------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------------
 *
 * Dishes are applied before portions and aliases, because those resolve a
 * slug against `custom_foods` and would otherwise have nothing to point at.
 * Anything still unresolvable is skipped rather than guessed — it will apply
 * on the next sync, once the dish it belongs to has arrived.
 */

import { scopedDb } from '../db/scope';
import { kvGet, kvSet } from '../lib/kv';
import { newId, now } from '../lib/device';
import { slugFor } from './foods';
import {
  collapse,
  nextCursor,
  resolve,
  wireKey,
  WIRE_VERSION,
  type Batch,
  type SyncTable,
  type WireRow,
} from './sync';

const db = scopedDb('nutritionist');

const PUSH_KV = 'sync.pushCursor';
const PULL_KV = 'sync.pullCursor';
const SEEN_KV = 'sync.lastAt';

/**
 * A portion can hang off a bundled food as well as a custom one. Bundled ids
 * are identical on every install — they ship in foods.json — so those travel
 * by id, tagged with a '#' that `normalise` can never produce, which keeps
 * one field unambiguous instead of two.
 */
const BUNDLED = '#';

export async function pushCursor(): Promise<number> {
  return (await kvGet<number>(PUSH_KV)) ?? 0;
}
export async function pullCursor(): Promise<number> {
  return (await kvGet<number>(PULL_KV)) ?? 0;
}
export async function lastSyncAt(): Promise<number | null> {
  return (await kvGet<number>(SEEN_KV)) ?? null;
}

// ------------------------------------------------------------- collecting

type CustomRow = {
  id: string;
  slug: string | null;
  name: string;
  per_unit: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
  notes: string | null;
  share: number;
  updated_at: number;
  deleted_at: number | null;
};

/** Everything changed since the cursor, as wire rows. */
export async function collect(cursor: number): Promise<WireRow[]> {
  const out: WireRow[] = [];

  const dishes = await db.query<CustomRow>(
    `SELECT id, slug, name, per_unit, energy_kcal, protein_g, fat_g, carbs_g,
            fibre_g, notes, share, updated_at, deleted_at
       FROM custom_foods WHERE updated_at >= ?`,
    [cursor],
  );
  for (const d of dishes) {
    const slug = d.slug || slugFor(d.name);
    if (!slug) continue; // a dish with no letters in its name has no identity
    out.push({
      t: 'custom_foods',
      k: slug,
      at: d.updated_at,
      del: d.deleted_at,
      f: {
        slug,
        name: d.name,
        per_unit: d.per_unit,
        energy_kcal: d.energy_kcal,
        protein_g: d.protein_g,
        fat_g: d.fat_g,
        carbs_g: d.carbs_g,
        fibre_g: d.fibre_g,
        notes: d.notes,
        share: d.share,
      },
    });
  }

  // LEFT JOIN, then fall back to the bundled form: a portion on a USDA row
  // has no custom dish to join to but is still worth syncing, because that
  // id means the same thing on both devices.
  const portions = await db.query<{
    food_slug: string | null;
    food_id: string;
    measure: string;
    quantity: number;
    net_weight_g: number;
    is_default: number;
    source: string;
    updated_at: number;
    deleted_at: number | null;
  }>(
    `SELECT c.slug AS food_slug, p.food_id, p.measure, p.quantity, p.net_weight_g,
            p.is_default, p.source, p.updated_at, p.deleted_at
       FROM food_portions p
       LEFT JOIN custom_foods c ON c.id = p.food_id
      WHERE p.updated_at >= ?`,
    [cursor],
  );
  for (const p of portions) {
    const ref = await refFor(p.food_slug, p.food_id);
    if (!ref) continue;
    out.push({
      t: 'food_portions',
      k: `${ref}|${p.measure}`,
      at: p.updated_at,
      del: p.deleted_at,
      f: {
        food_slug: ref,
        measure: p.measure,
        quantity: p.quantity,
        net_weight_g: p.net_weight_g,
        is_default: p.is_default,
        source: p.source,
      },
    });
  }

  const aliases = await db.query<{
    alias: string;
    food_slug: string | null;
    food_id: string;
    hits: number;
    updated_at: number;
    deleted_at: number | null;
  }>(
    `SELECT a.alias, c.slug AS food_slug, a.food_id, a.hits, a.updated_at, a.deleted_at
       FROM food_aliases a
       LEFT JOIN custom_foods c ON c.id = a.food_id
      WHERE a.updated_at >= ?`,
    [cursor],
  );
  for (const a of aliases) {
    const ref = await refFor(a.food_slug, a.food_id);
    if (!ref) continue;
    out.push({
      t: 'food_aliases',
      k: a.alias,
      at: a.updated_at,
      del: a.deleted_at,
      f: { alias: a.alias, food_slug: ref, hits: a.hits },
    });
  }

  return out;
}

/**
 * How a row names the dish it belongs to, on the wire.
 *
 * A custom dish travels as its slug. A bundled one travels as '#' plus its
 * id, which is safe because bundled ids ship in foods.json and are identical
 * on every install, and unambiguous because '#' is not something `normalise`
 * can ever emit. Anything else — a dangling food_id pointing at neither — is
 * not addressable and does not travel at all.
 */
async function refFor(slug: string | null, foodId: string): Promise<string> {
  if (slug) return slug;
  if (await isBundled(foodId)) return BUNDLED + foodId;
  return '';
}

const bundledIds = new Set<string>();
let bundledLoaded = false;
async function isBundled(id: string): Promise<boolean> {
  if (!bundledLoaded) {
    const rows = await db.query<{ id: string }>('SELECT id FROM foods');
    for (const r of rows) bundledIds.add(r.id);
    bundledLoaded = true;
  }
  return bundledIds.has(id);
}

// -------------------------------------------------------------- applying

/** slug (or '#id') → this device's food id. */
async function resolveRef(ref: string): Promise<string | null> {
  if (ref.startsWith(BUNDLED)) {
    const id = ref.slice(1);
    return (await isBundled(id)) ? id : null;
  }
  // Live row first; see `applyOne`.
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM custom_foods WHERE slug = ? ORDER BY deleted_at IS NOT NULL LIMIT 1',
    [ref],
  );
  return rows[0]?.id ?? null;
}

export type Applied = { dishes: number; portions: number; aliases: number; skipped: number };

/**
 * Write a batch in. Dishes first, so the rest have something to point at.
 *
 * Every write here carries the sender's `updated_at` through unchanged. See
 * the note at the top of this file — this is the difference between sync that
 * settles and sync that ping-pongs.
 */
export async function apply(rows: WireRow[]): Promise<Applied> {
  const best = collapse(rows);
  const stats: Applied = { dishes: 0, portions: 0, aliases: 0, skipped: 0 };
  const order: SyncTable[] = ['custom_foods', 'food_portions', 'food_aliases'];

  for (const table of order) {
    for (const r of best.values()) {
      if (r.t !== table) continue;
      try {
        const did = await applyOne(r);
        if (did === 'skip') stats.skipped++;
        else if (table === 'custom_foods') stats.dishes++;
        else if (table === 'food_portions') stats.portions++;
        else stats.aliases++;
      } catch {
        // One malformed row must not abandon the rest of the batch.
        stats.skipped++;
      }
    }
  }
  return stats;
}

async function applyOne(r: WireRow): Promise<'wrote' | 'skip'> {
  if (r.t === 'custom_foods') {
    const slug = String(r.f.slug ?? '');
    // Live row first. A phone where a dish was deleted and then added again
    // before 8 Oct 2026 holds two rows under one slug, and an unordered LIMIT 1
    // returned the older, deleted one: the incoming edit, newer than its
    // tombstone, brought it back to life beside the live copy. `writeDishes`
    // no longer makes the pair; this keeps a phone that already has one safe.
    const local = await db.query<{ id: string; updated_at: number; deleted_at: number | null }>(
      `SELECT id, updated_at, deleted_at FROM custom_foods
        WHERE slug = ? ORDER BY deleted_at IS NOT NULL LIMIT 1`,
      [slug],
    );
    if (!local[0]) {
      if (r.del) return 'skip'; // a delete for a dish we never had
      const id = await newId();
      await db.run(
        `INSERT INTO custom_foods
           (id, name, slug, per_unit, energy_kcal, protein_g, fat_g, carbs_g,
            fibre_g, notes, share, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, r.f.name, slug, r.f.per_unit ?? '100g', r.f.energy_kcal, r.f.protein_g,
         r.f.fat_g, r.f.carbs_g, r.f.fibre_g, r.f.notes, r.f.share ?? 0, r.at, r.del],
      );
      return 'wrote';
    }
    const verdict = resolve(
      'custom_foods',
      { updated_at: local[0].updated_at, deleted_at: local[0].deleted_at, id: local[0].id },
      { updated_at: r.at, deleted_at: r.del },
    );
    if (verdict === 'local') return 'skip';
    await db.run(
      `UPDATE custom_foods
          SET name=?, per_unit=?, energy_kcal=?, protein_g=?, fat_g=?, carbs_g=?,
              fibre_g=?, notes=?, share=?, updated_at=?, deleted_at=?
        WHERE id=?`,
      [r.f.name, r.f.per_unit ?? '100g', r.f.energy_kcal, r.f.protein_g, r.f.fat_g,
       r.f.carbs_g, r.f.fibre_g, r.f.notes, r.f.share ?? 0, r.at, r.del, local[0].id],
    );
    return 'wrote';
  }

  if (r.t === 'food_portions') {
    const foodId = await resolveRef(String(r.f.food_slug ?? ''));
    if (!foodId) return 'skip'; // the dish has not arrived yet; next sync
    const measure = String(r.f.measure ?? '');
    const local = await db.query<{
      id: string; updated_at: number; deleted_at: number | null; source: string;
    }>(
      'SELECT id, updated_at, deleted_at, source FROM food_portions WHERE food_id = ? AND measure = ? LIMIT 1',
      [foodId, measure],
    );
    if (!local[0]) {
      if (r.del) return 'skip';
      const id = await newId();
      await db.run(
        `INSERT INTO food_portions
           (id, food_id, measure, quantity, net_weight_g, is_default, source, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, foodId, measure, r.f.quantity, r.f.net_weight_g, r.f.is_default ?? 0,
         r.f.source ?? 'user', r.at, r.del],
      );
      return 'wrote';
    }
    const verdict = resolve(
      'food_portions',
      { updated_at: local[0].updated_at, deleted_at: local[0].deleted_at, source: local[0].source, id: local[0].id },
      { updated_at: r.at, deleted_at: r.del, source: r.f.source as string },
    );
    if (verdict === 'local') return 'skip';
    await db.run(
      `UPDATE food_portions
          SET quantity=?, net_weight_g=?, is_default=?, source=?, updated_at=?, deleted_at=?
        WHERE id=?`,
      [r.f.quantity, r.f.net_weight_g, r.f.is_default ?? 0, r.f.source ?? 'user',
       r.at, r.del, local[0].id],
    );
    return 'wrote';
  }

  // food_aliases
  const foodId = await resolveRef(String(r.f.food_slug ?? ''));
  if (!foodId) return 'skip';
  const alias = String(r.f.alias ?? '');
  const local = await db.query<{ id: string; updated_at: number; deleted_at: number | null }>(
    'SELECT id, updated_at, deleted_at FROM food_aliases WHERE alias = ? LIMIT 1',
    [alias],
  );
  if (!local[0]) {
    if (r.del) return 'skip';
    const id = await newId();
    await db.run(
      'INSERT INTO food_aliases (id, alias, food_id, hits, updated_at, deleted_at) VALUES (?,?,?,?,?,?)',
      [id, alias, foodId, r.f.hits ?? 0, r.at, r.del],
    );
    return 'wrote';
  }
  const verdict = resolve(
    'food_aliases',
    { updated_at: local[0].updated_at, deleted_at: local[0].deleted_at, id: local[0].id },
    { updated_at: r.at, deleted_at: r.del },
  );
  if (verdict === 'local') return 'skip';
  await db.run(
    'UPDATE food_aliases SET food_id=?, hits=?, updated_at=?, deleted_at=? WHERE id=?',
    [foodId, r.f.hits ?? 0, r.at, r.del, local[0].id],
  );
  return 'wrote';
}

// ------------------------------------------------------------- the cursors

export async function setPushCursor(rows: WireRow[]): Promise<void> {
  await kvSet(PUSH_KV, nextCursor(rows, await pushCursor()));
}
export async function setPullCursor(seq: number): Promise<void> {
  await kvSet(PULL_KV, seq);
}
export async function markSynced(): Promise<void> {
  await kvSet(SEEN_KV, now());
}

/** The batch this device would send right now. */
export function batchOf(rows: WireRow[]): Batch {
  return { v: WIRE_VERSION, rows };
}

/** Rows a batch carries that this device can name. Used by the tests. */
export function keysOf(rows: WireRow[]): string[] {
  return rows.map((r) => `${r.t}:${wireKey(r.t, r.f)}`);
}
