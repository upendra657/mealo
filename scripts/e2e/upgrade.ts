/**
 * An update, as a phone experiences it.
 *
 * The rest of the harness opens a database already at the latest version and
 * wipes it, so it proves the schema works and nothing about getting there. A
 * migration with a wrong WHERE would pass every assertion in it. This file
 * builds a database one version behind, holding rows in every table and every
 * column, puts it where the app keeps its database, and lets the real worker
 * open it and migrate — then checks each value is still what was written.
 *
 * Only the newest migration runs through the worker. That is the one that has
 * never run on a real phone; everything older already has, on both.
 * The older ones still run here over populated data, in the builder.
 *
 * Runs before anything else in the harness, because the worker opens the file
 * once and keeps it. Opened by hand on the `npm run dev` port, this overwrites
 * that origin's dev database — which the rest of the harness already wipes, so
 * nothing there was being kept.
 */

import { initDb, query, run as sql } from '../../src/db/client';
import { LATEST_VERSION, MIGRATIONS } from '../../src/db/migrations';

type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = Record<string, unknown>;

/** Rows written immediately after the migration of the same version runs. */
type Seed = { version: number; table: string; rows: Row[] };

const T = 1_759_000_000_000; // a fixed instant, so a failure reads the same twice

/**
 * Every migration adds its seeds here, for whatever it creates or adds. The
 * coverage check below fails until it does, because a column nobody wrote to
 * is a column no later migration is tested against.
 *
 * Each table gets a soft-deleted row too. A table rebuild that copies with
 * `WHERE deleted_at IS NULL` looks like tidying and silently breaks sync,
 * since the tombstone is how the other phone learns of the delete.
 *
 * The dal figures are from his sheet (scripts/e2e/harness.ts SHEET), per 100 g.
 */
const SEEDS: Seed[] = [
  { version: 1, table: 'medications', rows: [
    { id: 'fx-med-1', name: 'Vitamin D3', raw_text: 'vit d 1000 after breakfast',
      rxcui: '11253', dose_text: '1000 IU', schedule: 'after breakfast',
      started_on: '2025-06-01', ended_on: '2025-12-01', notes: 'with food',
      updated_at: T },
    { id: 'fx-med-2', name: 'Iron', updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'intake_events', rows: [
    { id: 'fx-intake-1', medication_id: 'fx-med-1', taken_at: T, status: 'taken',
      note: 'an hour late', updated_at: T },
    { id: 'fx-intake-2', medication_id: 'fx-med-1', taken_at: T, status: 'skipped',
      updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'meals', rows: [
    { id: 'fx-meal-1', eaten_at: T, raw_text: '1 katori dal tadka, 2 roti',
      meal_type: 'dinner', updated_at: T },
    { id: 'fx-meal-2', eaten_at: T, updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'meal_items', rows: [
    { id: 'fx-item-1', meal_id: 'fx-meal-1', label: 'Dal Tadka', food_id: 'fx-food-1',
      quantity: 1, unit: 'katori', energy_kcal: 128, protein_g: 6.1, fat_g: 4.1,
      carbs_g: 16.6, fibre_g: 2.9, source: 'direct', updated_at: T },
    { id: 'fx-item-2', meal_id: 'fx-meal-2', label: 'Roti', source: 'matched',
      updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'food_aliases', rows: [
    { id: 'fx-alias-1', alias: 'dal', food_id: 'fx-food-1', hits: 7, updated_at: T },
    { id: 'fx-alias-2', alias: 'daal', food_id: 'fx-food-1', updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'symptoms', rows: [
    { id: 'fx-sym-1', noted_at: T, raw_text: 'headache since morning', label: 'headache',
      severity: 2, resolved_at: T + 3_600_000, updated_at: T },
    { id: 'fx-sym-2', noted_at: T, raw_text: 'tired', updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'current_state', rows: [
    { id: 'singleton', summary: 'no active conditions', flags: '["fasting"]', updated_at: T },
  ] },
  { version: 1, table: 'citations', rows: [
    { id: 'fx-cite-1', claim: 'dal is 85 kcal per 100 g', source_name: 'IFCT2017',
      source_url: 'https://www.ifct2017.com/', excerpt: 'Lentil, cooked',
      retrieved_at: T, updated_at: T },
    { id: 'fx-cite-2', claim: 'x', source_name: 'USDA', source_url: 'https://fdc.nal.usda.gov/',
      retrieved_at: T, updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'messages', rows: [
    { id: 'fx-msg-1', agent: 'nutritionist', role: 'user',
      content: 'how much protein today?', created_at: T, updated_at: T },
    { id: 'fx-msg-2', agent: 'doctor', role: 'assistant', content: 'x',
      created_at: T, updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 1, table: 'conversation_summaries', rows: [
    { id: 'nutritionist', summary: 'asks about protein most evenings',
      upto_msg_id: 'fx-msg-1', updated_at: T },
  ] },

  { version: 2, table: 'custom_foods', rows: [
    { id: 'fx-food-1', name: 'Dal Tadka', per_unit: '100g', energy_kcal: 85.3,
      protein_g: 4.07, fat_g: 2.73, carbs_g: 11.07, fibre_g: 1.93,
      notes: 'home recipe', updated_at: T },
    { id: 'fx-food-2', name: 'Old Dal', updated_at: T, deleted_at: T + 1 },
  ] },

  { version: 3, table: 'food_portions', rows: [
    { id: 'fx-portion-1', food_id: 'fx-food-1', measure: 'katori', quantity: 1,
      net_weight_g: 150, is_default: 1, source: 'user', updated_at: T },
    { id: 'fx-portion-2', food_id: 'fx-food-1', measure: 'bowl', quantity: 1,
      net_weight_g: 350, source: 'derived', updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 3, table: 'meal_items', rows: [
    { id: 'fx-item-3', meal_id: 'fx-meal-1', label: 'Roti', quantity: 2, unit: 'piece',
      net_weight_g: 70, source: 'matched', updated_at: T },
  ] },

  { version: 4, table: 'profiles', rows: [
    { id: 'fx-partner', name: 'Partner', colour: '#d98b5f', created_at: T, updated_at: T },
    { id: 'fx-gone', name: 'Removed', created_at: T, updated_at: T, deleted_at: T + 1 },
  ] },
  { version: 4, table: 'meals', rows: [
    { id: 'fx-meal-3', profile_id: 'fx-partner', eaten_at: T, meal_type: 'lunch', updated_at: T },
  ] },

  { version: 5, table: 'targets', rows: [
    { id: 'primary', energy_kcal: 1800, protein_g: 90, fat_g: 60, carbs_g: 200,
      fibre_g: 30, updated_at: T },
    { id: 'fx-gone', energy_kcal: 1500, updated_at: T, deleted_at: T + 1 },
  ] },

  { version: 6, table: 'custom_foods', rows: [
    { id: 'fx-food-3', name: 'Set Curd', slug: 'set curd', share: 1,
      energy_kcal: 62, updated_at: T },
  ] },

  { version: 7, table: 'weights', rows: [
    { id: 'fx-w-1', profile_id: 'primary', measured_at: T, kg: 72.4, note: 'morning',
      updated_at: T },
    { id: 'fx-w-2', profile_id: 'primary', measured_at: T, kg: 73, updated_at: T,
      deleted_at: T + 1 },
  ] },

  { version: 8, table: 'targets', rows: [
    { id: 'fx-partner', weight_kg: 58, updated_at: T },
  ] },

  { version: 9, table: 'burns', rows: [
    { id: 'fx-b-1', profile_id: 'primary', measured_at: T, kcal: 420, note: 'walk + gym',
      updated_at: T },
    { id: 'fx-b-2', profile_id: 'primary', measured_at: T, kcal: 100, updated_at: T,
      deleted_at: T + 1 },
  ] },
  { version: 9, table: 'targets', rows: [
    { id: 'fx-later', burn_kcal: 500, updated_at: T },
  ] },
];

/**
 * Reference data, not anyone's record: it ships with the app and seedFoods
 * wipes and rewrites it whenever the bundled count changes. A migration that
 * damaged it would be repaired on the next start.
 */
const NOT_USER_DATA = new Set(['foods']);

/**
 * What the migrations are allowed to have changed, by design. These are the
 * v4 rewrites sanctioned in test-portions.ts, plus the v4 backfill that files
 * everything logged before profiles existed under the one person who was
 * using the app. Anything else differing from SEEDS is a migration damaging
 * data.
 */
const BACKFILLED_AT_V4 = new Set([
  'medications', 'intake_events', 'meals', 'meal_items', 'symptoms', 'messages',
]);

function expected(seed: Seed, row: Row, upto: number): { table: string; row: Row } {
  if (upto < 4 || seed.version >= 4) return { table: seed.table, row };
  if (BACKFILLED_AT_V4.has(seed.table)) {
    return { table: seed.table, row: { ...row, profile_id: 'primary' } };
  }
  if (seed.table === 'current_state' && row.id === 'singleton') {
    return { table: seed.table, row: { ...row, id: 'primary' } };
  }
  if (seed.table === 'conversation_summaries') {
    return { table: seed.table, row: { ...row, id: `primary:${row.id}` } };
  }
  return { table: seed.table, row };
}

/** Rows a migration inserts itself, which the fixture did not write. */
const MIGRATION_ROWS: { version: number; table: string; row: Row }[] = [
  { version: 4, table: 'profiles', row: { id: 'primary', name: 'Me' } },
];

// --------------------------------------------------------------- sqlite

type OoDb = {
  exec(opts: { sql: string; bind?: unknown[]; rowMode?: string; returnValue?: string }): unknown;
  selectValue(sql: string): unknown;
  close(): void;
  pointer: number;
};
type Sqlite3 = {
  oo1: { DB: new (path: string, flags: string) => OoDb };
  capi: { sqlite3_js_db_export(ptr: number): Uint8Array };
};

/**
 * The same distribution, by the same route, as db/worker.ts — see the comment
 * on loadSqlite3 there for why the import is indirect. On the main thread it
 * cannot install OPFS and does not need to: the builder works in memory and
 * the result is handed over as a file.
 */
async function loadSqlite3(): Promise<Sqlite3> {
  const load = new Function('u', 'return import(u)') as (
    u: string,
  ) => Promise<{ default: () => Promise<Sqlite3> }>;
  return (await load('/sqlite-wasm/index.mjs')).default();
}

/**
 * Applies migrations 1..upto with each version's seeds written straight after
 * it. Deliberately not the worker's loop: that is the thing under test, and it
 * gets its turn on the file this produces.
 */
function buildAt(sqlite3: Sqlite3, upto: number): OoDb {
  const db = new sqlite3.oo1.DB(':memory:', 'ct');
  for (const m of MIGRATIONS) {
    if (m.version > upto) break;
    db.exec({ sql: m.sql });
    db.exec({ sql: `PRAGMA user_version = ${m.version}` });
    for (const seed of SEEDS.filter((s) => s.version === m.version)) {
      for (const row of seed.rows) {
        const cols = Object.keys(row);
        db.exec({
          sql: `INSERT INTO ${seed.table} (${cols.join(', ')})
                VALUES (${cols.map(() => '?').join(', ')})`,
          bind: cols.map((c) => row[c]),
        });
      }
    }
  }
  return db;
}

function rows(db: OoDb, q: string): Row[] {
  return db.exec({ sql: q, rowMode: 'object', returnValue: 'resultRows' }) as Row[];
}

/** Every `table.column` holding nothing but NULL. */
function uncovered(db: OoDb): string[] {
  const missing: string[] = [];
  const tables = rows(db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    const t = String(name);
    if (NOT_USER_DATA.has(t)) continue;
    for (const col of rows(db, `PRAGMA table_info(${t})`)) {
      const c = String(col.name);
      const n = Number(db.selectValue(`SELECT COUNT(*) FROM ${t} WHERE ${c} IS NOT NULL`));
      if (n === 0) missing.push(`${t}.${c}`);
    }
  }
  return missing;
}

/**
 * Hands the file to the app. The OPFS VFS keeps `/mealo.sqlite3` as a file of
 * that name at the origin's root, so writing the bytes there is
 * indistinguishable from a phone that last ran the previous build.
 */
async function placeInOpfs(bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (const leftover of ['mealo.sqlite3-journal', 'mealo.sqlite3-wal']) {
    await root.removeEntry(leftover).catch(() => {});
  }
  const handle = await root.getFileHandle('mealo.sqlite3', { create: true });
  const out = await handle.createWritable();
  await out.write(bytes as BlobPart);
  await out.close();
}

// ----------------------------------------------------------------- test

const same = (a: unknown, b: unknown) => String(a) === String(b);

export async function upgradeFromPrevious(check: Check): Promise<void> {
  const from = LATEST_VERSION - 1;
  const sqlite3 = await loadSqlite3();

  // The seeds themselves, at the latest version: every column of every table
  // has a value, so the migration after this one is tested against all of it.
  {
    const db = buildAt(sqlite3, LATEST_VERSION);
    const missing = uncovered(db);
    db.close();
    check(`seeds cover every column at v${LATEST_VERSION}`, missing.length === 0,
      `nothing but NULL in ${missing.join(', ')} — either SEEDS has no value for ` +
        'them (add one), or a migration erased the values it had');
  }

  const db = buildAt(sqlite3, from);
  check(`fixture built at v${from}`, Number(db.selectValue('PRAGMA user_version')) === from);
  const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  db.close();
  await placeInOpfs(bytes);

  // The real path: the app's worker opens the file and runs what it finds
  // missing, exactly as it does after a deploy.
  const info = await initDb();
  check('the app opened the fixture from OPFS', info.mode === 'opfs',
    `mode is ${info.mode} — the fixture was never read`);
  check(`the app migrated it v${from} → v${LATEST_VERSION}`, info.version === LATEST_VERSION,
    `at v${info.version}`);

  const integrity = await query<{ integrity_check: string }>('PRAGMA integrity_check');
  check('integrity_check is ok', integrity[0]?.integrity_check === 'ok',
    JSON.stringify(integrity));

  const want = new Map<string, Row[]>();
  for (const seed of SEEDS.filter((s) => s.version <= from)) {
    for (const r of seed.rows) {
      const e = expected(seed, r, from);
      want.set(e.table, [...(want.get(e.table) ?? []), e.row]);
    }
  }
  for (const m of MIGRATION_ROWS.filter((m) => m.version <= from)) {
    want.set(m.table, [...(want.get(m.table) ?? []), m.row]);
  }

  for (const [table, list] of want) {
    const problems: string[] = [];
    const count = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    if (Number(count[0]?.n) !== list.length) {
      problems.push(`found ${count[0]?.n}, expected ${list.length}`);
    }
    for (const w of list) {
      const got = (await query<Row>(`SELECT * FROM ${table} WHERE id = ?`, [w.id]))[0];
      if (!got) {
        problems.push(`${String(w.id)} is gone`);
        continue;
      }
      for (const [col, value] of Object.entries(w)) {
        if (!same(got[col], value)) {
          problems.push(`${String(w.id)}.${col} was ${String(value)}, now ${String(got[col])}`);
        }
      }
    }
    check(`${table}: ${list.length} row${list.length === 1 ? '' : 's'} survive${list.length === 1 ? 's' : ''} the update intact`,
      problems.length === 0, problems.join('; '));
  }

  // Leave the database as a fresh install would, so the rest of the harness
  // starts where it always has. Raw SQL: this is test scaffolding, not an
  // agent, and the profile guard would rightly refuse an unscoped delete.
  for (const [table, list] of want) {
    for (const w of list) {
      if (table === 'profiles' && w.id === 'primary') continue;
      await sql(`DELETE FROM ${table} WHERE id = ?`, [w.id]);
    }
  }
  const left = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM profiles WHERE id != 'primary'");
  check('fixture removed afterwards', Number(left[0]?.n) === 0);
}
