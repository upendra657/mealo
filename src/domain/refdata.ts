/**
 * Medicine reference lists on the device: importing them, finding in them.
 *
 * An import is staged. The new list is written under status 'importing' and
 * search reads only 'ready' lists, so nobody ever sees half of one. If it
 * fails part-way, everything it wrote is removed; if the app is closed
 * part-way, the next start removes it. Replacing a list writes the new one
 * completely before the old one is deleted, so a failed replace leaves the old
 * list exactly as it was.
 *
 * These tables are the device's, not anyone's record (see v12): never synced,
 * never in the shared library. Writes go through the worker's bulk path, which
 * refuses every table but med_ref_items — an import cannot touch meals or
 * medicines whatever is wrong with the file.
 */

import { scopedDb } from '../db/scope';
import { normalise } from './foods';
import type { Form } from './doses';
import {
  CsvReader,
  emptySkips,
  rowsToItems,
  type Mapping,
  type RefIngredient,
  type RefItem,
  type Skips,
} from '../lib/tabular';

const db = scopedDb('pharmacist');

export type RefSet = {
  id: string;
  name: string;
  tag: string;
  source_url: string | null;
  licence: string | null;
  builtin: number;
  status: 'importing' | 'ready';
  row_count: number;
  skipped: number;
  version: string | null;
  imported_at: number | null;
};

export type RefMeta = {
  name: string;
  tag: string;
  source_url?: string | null;
  licence?: string | null;
  builtin?: boolean;
  version?: string | null;
};

export type ImportProgress = {
  /** Data rows read so far, header excluded. */
  read: number;
  imported: number;
  skips: Skips;
  /** 0 to 1, by bytes when reading a file, else by rows. */
  fraction: number;
};

export type ImportResult = { set: RefSet; read: number; imported: number; skips: Skips };

/** Where the rows come from. A file is read in slices; rows are handed over. */
export type RefSource =
  | { kind: 'file'; file: File }
  | { kind: 'rows'; header: string[]; rows: string[][] };

const BATCH = 2000;
const COLUMNS = ['id', 'set_id', 'name', 'name_norm', 'ingredients', 'form', 'discontinued', 'updated_at', 'deleted_at'];

/** Short ids: a quarter of a million rows each carry one, and an index of them. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** A moment for the screen to repaint between slices of a long import. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

export async function listSets(): Promise<RefSet[]> {
  return db.query<RefSet>(
    `SELECT * FROM med_ref_sets WHERE deleted_at IS NULL AND status = 'ready'
      ORDER BY builtin DESC, name COLLATE NOCASE`,
  );
}

async function removeSet(id: string): Promise<void> {
  await db.run('DELETE FROM med_ref_items WHERE set_id = ?', [id]);
  await db.run('DELETE FROM med_ref_sets WHERE id = ?', [id]);
}

/**
 * How long an import may go without a sign of life before it counts as
 * abandoned. Every batch an import writes touches its set row (see flush), so
 * a live import — in this tab, another tab, or the second run of a React
 * StrictMode effect — is never mistaken for a dead one.
 */
const STALE_AFTER = 2 * 60_000;

/** Lists an earlier start left 'importing' — the app closed mid-import. */
export async function clearStaleImports(now = Date.now()): Promise<number> {
  const stale = await db.query<{ id: string }>(
    "SELECT id FROM med_ref_sets WHERE status = 'importing' AND updated_at < ?",
    [now - STALE_AFTER],
  );
  for (const s of stale) await removeSet(s.id);
  return stale.length;
}

/** Remove a list the person imported. The bundled one comes back on its own. */
export async function deleteSet(id: string): Promise<void> {
  await removeSet(id);
}

/** Rows from a source, in slices, with how far through it is. */
async function* slices(source: RefSource): AsyncGenerator<{ rows: string[][]; fraction: number }> {
  if (source.kind === 'rows') {
    const all = [source.header, ...source.rows];
    for (let i = 0; i < all.length; i += 5000) {
      yield { rows: all.slice(i, i + 5000), fraction: Math.min(1, (i + 5000) / all.length) };
    }
    return;
  }
  const file = source.file;
  if (/\.xlsx$/i.test(file.name)) {
    // An .xlsx has to be unzipped whole; the rows are then handed on in slices.
    const { readXlsx } = await import('../lib/xlsx');
    const all = readXlsx(new Uint8Array(await file.arrayBuffer()));
    for (let i = 0; i < all.length; i += 5000) {
      yield { rows: all.slice(i, i + 5000), fraction: Math.min(1, (i + 5000) / all.length) };
    }
    return;
  }
  if (/\.xls$/i.test(file.name)) {
    throw new Error('Old .xls files cannot be read. Save it as .xlsx or CSV and try again.');
  }
  const reader = new CsvReader();
  const decoder = new TextDecoder('utf-8');
  const stream = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: end } = await stream.read();
    if (end) break;
    done += value.byteLength;
    yield { rows: reader.feed(decoder.decode(value, { stream: true })), fraction: done / Math.max(1, file.size) };
  }
  yield { rows: [...reader.feed(decoder.decode()), ...reader.end()], fraction: 1 };
}

/** The first rows of a source, for the preview before anything is written. */
export async function peek(source: RefSource, n = 6): Promise<{ header: string[]; rows: string[][] }> {
  if (source.kind === 'rows') return { header: source.header, rows: source.rows.slice(0, n) };
  const got: string[][] = [];
  for await (const s of slices(source)) {
    got.push(...s.rows);
    if (got.length > n) break;
  }
  if (!got.length) throw new Error('The file is empty.');
  return { header: got[0].map((h) => h.trim()), rows: got.slice(1, n + 1) };
}

/**
 * Import a list. Staged, as the header describes: nothing is visible until
 * every row is in, a failure removes what it wrote, and `replace` names a
 * list to remove only once this one is complete.
 */
export async function importList(
  source: RefSource,
  meta: RefMeta,
  mapping: Mapping,
  onProgress?: (p: ImportProgress) => void,
  replace?: string | null,
): Promise<ImportResult> {
  if (!meta.name.trim() || !meta.tag.trim()) throw new Error('A list needs a name and a tag.');
  if (!mapping.name || mapping.ingredients.length === 0) {
    throw new Error('Choose the name column and at least one ingredient column.');
  }

  const id = shortId();
  const now = Date.now();
  await db.insert('med_ref_sets', {
    id,
    name: meta.name.trim(),
    tag: meta.tag.trim(),
    source_url: meta.source_url?.trim() || null,
    licence: meta.licence?.trim() || null,
    builtin: meta.builtin ? 1 : 0,
    status: 'importing',
    row_count: 0,
    skipped: 0,
    version: meta.version ?? null,
    imported_at: null,
    deleted_at: null,
  });

  const skips = emptySkips();
  const seen = new Set<string>();
  let header: string[] | null = null;
  let read = 0;
  let imported = 0;
  let n = 0;
  let pending: unknown[][] = [];

  const flush = async () => {
    if (!pending.length) return;
    imported += await db.bulkInsert('med_ref_items', COLUMNS, pending);
    pending = [];
    // A sign of life for clearStaleImports, and a running count.
    await db.update('med_ref_sets', id, { row_count: imported });
  };
  const toRow = (it: RefItem): unknown[] => [
    `${id}.${(n++).toString(36)}`,
    id,
    it.name,
    it.name_norm,
    JSON.stringify(it.ingredients),
    it.form,
    0,
    now,
    null,
  ];

  try {
    for await (const slice of slices(source)) {
      let rows = slice.rows;
      if (!header) {
        if (!rows.length) continue;
        header = rows[0].map((h) => h.trim());
        rows = rows.slice(1);
        const missing = [mapping.name, ...mapping.ingredients].filter((c) => !header!.includes(c));
        if (missing.length) throw new Error(`The file has no column called ${missing.join(', ')}.`);
      }
      read += rows.length;
      for (const it of rowsToItems(header, rows, mapping, skips, seen)) {
        pending.push(toRow(it));
        if (pending.length >= BATCH) await flush();
      }
      onProgress?.({ read, imported: imported + pending.length, skips: { ...skips }, fraction: slice.fraction });
      await breathe();
    }
    await flush();
    if (!header) throw new Error('The file is empty.');
    if (imported === 0) throw new Error('Nothing in this file could be read as a medicine with ingredients.');

    const skipped = Object.values(skips).reduce((a, b) => a + b, 0);
    await db.update('med_ref_sets', id, { status: 'ready', row_count: imported, skipped, imported_at: Date.now() });
    if (replace && replace !== id) await removeSet(replace);
  } catch (e) {
    await removeSet(id).catch(() => {});
    throw e;
  }

  const set = (await db.query<RefSet>('SELECT * FROM med_ref_sets WHERE id = ?', [id]))[0];
  onProgress?.({ read, imported, skips: { ...skips }, fraction: 1 });
  return { set, read, imported, skips };
}

// ---------------------------------------------------------------- search

export type RefHit = {
  setId: string;
  setName: string;
  tag: string;
  name: string;
  ingredients: RefIngredient[];
  form: Form | null;
};

/**
 * Medicines whose name starts with what was typed, normalised the way the
 * names were stored. A range on the index rather than LIKE, which SQLite will
 * not run off an index here.
 */
export async function searchReference(q: string, limit = 8): Promise<RefHit[]> {
  const norm = normalise(q);
  if (norm.length < 2) return [];
  const rows = await db.query<{
    set_id: string;
    set_name: string;
    tag: string;
    name: string;
    ingredients: string;
    form: string | null;
  }>(
    `SELECT i.set_id, s.name AS set_name, s.tag, i.name, i.ingredients, i.form
       FROM med_ref_items i JOIN med_ref_sets s ON s.id = i.set_id
      WHERE i.name_norm >= ? AND i.name_norm < ?
        AND i.deleted_at IS NULL AND i.discontinued = 0
        AND s.status = 'ready' AND s.deleted_at IS NULL
      ORDER BY i.name_norm LIMIT ?`,
    [norm, `${norm}￿`, limit],
  );
  return rows.map((r) => {
    let ingredients: RefIngredient[] = [];
    try {
      ingredients = JSON.parse(r.ingredients) as RefIngredient[];
    } catch {
      /* a row this app wrote will parse; one that does not offers no ingredients */
    }
    return {
      setId: r.set_id,
      setName: r.set_name,
      tag: r.tag,
      name: r.name,
      ingredients,
      form: (r.form as Form | null) ?? null,
    };
  });
}

// --------------------------------------------------------------- bundled

/**
 * The lists that ship with the app — the Singapore HSA register — loaded into
 * the same tables on first start and again whenever the bundled copy changes.
 * Not awaited by the shell: search simply has no HSA rows until it is done.
 *
 * Once per page, whoever calls. React runs a development effect twice; the
 * first build of this started two loads side by side, neither saw the other's
 * list, and Singapore was in search twice.
 */
let builtins: Promise<void> | null = null;
export function ensureBuiltins(): Promise<void> {
  builtins ??= loadBuiltins().finally(() => {
    builtins = null;
  });
  return builtins;
}

async function loadBuiltins(): Promise<void> {
  const { default: hsa } = await import('../data/hsa.json');
  const current = await db.query<RefSet>(
    "SELECT * FROM med_ref_sets WHERE builtin = 1 AND tag = 'HSA' AND status = 'ready' AND deleted_at IS NULL",
  );
  if (current.some((s) => s.version === hsa.version)) return;
  const { PRESETS } = await import('../lib/tabular');
  const preset = PRESETS.find((p) => p.id === 'hsa-singapore')!;
  await importList(
    { kind: 'rows', header: hsa.header, rows: hsa.rows },
    { name: preset.name, tag: preset.tag, source_url: preset.source_url, licence: preset.licence, builtin: true, version: hsa.version },
    preset.mapping,
    undefined,
    current[0]?.id ?? null,
  );
  // Any other copy — another tab loading at the same moment — goes, so the
  // phone settles on exactly one whatever raced.
  const now = await db.query<RefSet>(
    "SELECT * FROM med_ref_sets WHERE builtin = 1 AND tag = 'HSA' ORDER BY imported_at DESC",
  );
  for (const old of now.slice(1)) await removeSet(old.id);
}

/** Start-up work for the lists, once per page: clear the abandoned, load the bundled. */
let startup: Promise<void> | null = null;
export function startLists(): Promise<void> {
  startup ??= clearStaleImports().then(() => ensureBuiltins());
  return startup;
}
