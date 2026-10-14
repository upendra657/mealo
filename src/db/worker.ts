/// <reference lib="webworker" />
/**
 * SQLite runs in a worker so that OPFS access never blocks the UI thread.
 *
 * OPFS gives us a real file-backed database that survives reloads. It needs the
 * page to be cross-origin isolated (COOP/COEP) — see vite.config.ts. When that
 * is missing, or the browser has no OPFS, we fall back to an in-memory database
 * so the app still runs; the client surfaces which mode is active, because a
 * memory database silently losing everything on reload would be the worst
 * possible failure mode for a health log.
 */

import { LATEST_VERSION, MIGRATIONS } from './migrations';
import { pruneSnapshots, snapshotName, type SnapshotOutcome } from './snapshots';
import { COUNTED, refusal, sameRows, type BackupInfo } from './backup';

/**
 * Loaded from a static URL rather than imported as a package dependency.
 *
 * The OPFS VFS spawns its own async proxy worker and finds it relative to the
 * module that loaded it. Bundling breaks that path under `vite dev`: the proxy
 * fails to load, OPFS refuses to install, and SQLite quietly falls back to an
 * in-memory database. Serving the distribution untouched from /sqlite-wasm/
 * makes dev and production resolve it the same way.
 *
 * scripts/copy-sqlite.mjs puts the files there; predev and prebuild run it.
 */
const SQLITE_URL = '/sqlite-wasm/index.mjs';

const LIVE = '/mealo.sqlite3';
/** A backup file being looked at before a restore. Beside the live one, never over it. */
const CANDIDATE = '/mealo.restore-candidate.sqlite3';
/** A fresh backup, read back to prove it opens before it is handed over. */
const CHECK = '/mealo.backup-check.sqlite3';
/** What was on the phone before the last restore. Kept until the next one. */
const BEFORE = '/mealo.before-restore.sqlite3';
/**
 * The weekly copy kept inside the phone, in two slots. When the newer is a
 * week old the older is written over, so there is always a copy from this
 * week and one from the week before. Asked for on 15 Oct 2026 ("Inside the
 * phone works for now"). It guards against a fault in the app, not against
 * losing the phone or clearing its data: it lives where the database does.
 */
const WEEKLY = ['/mealo.weekly-a.sqlite3', '/mealo.weekly-b.sqlite3'] as const;
const WEEK_MS = 7 * 86_400_000;

type Sqlite3Init = (config?: Record<string, unknown>) => Promise<unknown>;

async function loadSqlite3(): Promise<unknown> {
  // Indirect import: Vite rewrites analysable dynamic imports and then refuses
  // to transform a file living in public/. Going through Function keeps the
  // URL opaque to the bundler so the distribution is fetched verbatim.
  const load = new Function('u', 'return import(u)') as (
    u: string,
  ) => Promise<{ default: Sqlite3Init }>;
  const mod = await load(SQLITE_URL);
  return mod.default();
}

type Req =
  | { id: number; type: 'init' }
  | { id: number; type: 'exec'; sql: string; bind?: unknown[] }
  | { id: number; type: 'bulk'; table: string; columns: string[]; rows: unknown[][] }
  | { id: number; type: 'export' }
  | { id: number; type: 'describe' }
  | { id: number; type: 'inspect'; bytes: Uint8Array; purpose: 'restore' | 'check' }
  | { id: number; type: 'restore' }
  | { id: number; type: 'weekly'; now: number };

type Ok = { id: number; ok: true; result: unknown };
type Err = { id: number; ok: false; error: string };

// The sqlite-wasm typings are loose around the oo1 namespace; these local
// shapes cover exactly what we use.
type OoDb = {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: string;
    returnValue?: string;
  }): unknown;
  selectValue(sql: string): unknown;
  prepare(sql: string): OoStmt;
  close(): void;
  pointer: number;
};

type OoStmt = {
  bind(values: unknown[]): OoStmt;
  stepReset(): OoStmt;
  finalize(): void;
};

type Capi = { sqlite3_js_db_export(ptr: number): Uint8Array };

/** The OPFS database class, with the one static it has that the app uses. */
type OpfsStatic = (new (path: string) => OoDb) & {
  importDb(filename: string, bytes: Uint8Array): Promise<number>;
};

let db: OoDb | null = null;
let capi: Capi | null = null;
let Opfs: OpfsStatic | null = null;
let mode: 'opfs' | 'memory' = 'memory';
let snapshot: SnapshotOutcome = { status: 'none' };

type Info = { mode: string; version: number; snapshot: SnapshotOutcome };

async function init(): Promise<Info> {
  if (db) return { mode, version: currentVersion(), snapshot };

  const sqlite3 = await loadSqlite3();

  const oo1 = (sqlite3 as unknown as { oo1: Record<string, unknown> }).oo1;
  capi = (sqlite3 as unknown as { capi: Capi }).capi;

  if ('OpfsDb' in oo1 && typeof oo1.OpfsDb === 'function') {
    Opfs = oo1.OpfsDb as OpfsStatic;
    db = new Opfs(LIVE);
    mode = 'opfs';
  } else {
    const Ctor = oo1.DB as new (path: string, flags: string) => OoDb;
    db = new Ctor(':memory:', 'ct');
    mode = 'memory';
  }

  db.exec({ sql: 'PRAGMA foreign_keys = ON;' });
  await migrate();
  return { mode, version: currentVersion(), snapshot };
}

function currentVersion(): number {
  if (!db) return 0;
  return Number(db.selectValue('PRAGMA user_version') ?? 0);
}

async function migrate(): Promise<void> {
  if (!db) throw new Error('database not open');
  const from = currentVersion();
  // Version 0 is a database no migration has touched, so there is nothing in
  // it to keep; a memory database holds nothing from before this launch.
  if (from > 0 && from < LATEST_VERSION && mode === 'opfs') {
    snapshot = await takeSnapshot(from);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec({ sql: 'BEGIN' });
    try {
      db.exec({ sql: m.sql });
      // PRAGMA cannot be parameterised; version is a literal from our own code.
      db.exec({ sql: `PRAGMA user_version = ${m.version}` });
      db.exec({ sql: 'COMMIT' });
      console.info(`[db] migrated to v${m.version} — ${m.name}`);
    } catch (e) {
      db.exec({ sql: 'ROLLBACK' });
      throw e;
    }
  }
}

/**
 * Copies the database aside before the first pending migration runs.
 *
 * VACUUM INTO rather than exporting the bytes and writing them out: SQLite
 * produces a consistent copy through the same VFS that already holds the
 * database, without the whole file passing through JS memory, and without
 * depending on an OPFS write API whose availability in workers still differs
 * between Safari versions.
 *
 * A failure here does not stop the update. Refusing to migrate would leave
 * the new build unable to open the data at all, and the likeliest cause —
 * storage full — would stop the database growing anyway. It is reported
 * instead, at the top of Dev's This phone card.
 */
async function takeSnapshot(from: number): Promise<SnapshotOutcome> {
  if (!db) throw new Error('database not open');
  try {
    const root = await navigator.storage.getDirectory();
    // A copy under this name can only be left by an earlier attempt at this
    // same update that never advanced the version, so the database is still
    // what that copy holds and replacing it loses nothing. VACUUM INTO will
    // not write over an existing file.
    await root.removeEntry(snapshotName(from)).catch(() => {});
    db.exec({ sql: 'VACUUM INTO ?', bind: [`/${snapshotName(from)}`] });
    // An old copy that outlives its turn costs space and nothing else, so a
    // failed prune is not a failed snapshot.
    await pruneSnapshots(root, from).catch(() => {});
    return { status: 'saved', version: from };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[db] no copy taken before migrating from v${from}: ${error}`);
    return { status: 'failed', version: from, error };
  }
}

function exec(sql: string, bind?: unknown[]): unknown[] {
  if (!db) throw new Error('database not open');
  return db.exec({
    sql,
    bind,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown[];
}

/**
 * The only tables a bulk write may touch. Enforced here, in the worker, below
 * every other layer: a quarter of a million rows of an imported medicine list
 * go through this path, and it must be impossible for any of them — or any
 * mistake in the code that sends them — to land in meals, dishes, portions or
 * anyone's medicines.
 */
const BULK_TABLES = new Set(['med_ref_items']);

/**
 * Many rows in one transaction with one prepared statement: an import of
 * 240,000 rows one message at a time would take minutes. All of a batch goes
 * in or none of it does.
 */
function bulk(table: string, columns: string[], rows: unknown[][]): number {
  if (!db) throw new Error('database not open');
  if (!BULK_TABLES.has(table)) throw new Error(`bulk writes are not allowed into ${table}`);
  if (!columns.length || !columns.every((c) => /^[a-z_]+$/.test(c))) {
    throw new Error('bulk write with an unusable column list');
  }
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  db.exec({ sql: 'BEGIN' });
  let stmt: OoStmt | null = null;
  try {
    stmt = db.prepare(sql);
    for (const r of rows) {
      if (r.length !== columns.length) throw new Error('a bulk row does not match its columns');
      stmt.bind(r).stepReset();
    }
    stmt.finalize();
    stmt = null;
    db.exec({ sql: 'COMMIT' });
    return rows.length;
  } catch (e) {
    try {
      stmt?.finalize();
    } catch {
      /* already gone */
    }
    db.exec({ sql: 'ROLLBACK' });
    throw e;
  }
}

/**
 * Serialise the whole database to a byte array — this is the plain, unencrypted
 * export that Phase 1 ships as a "download my data" button. Encryption and a
 * separate export password come in Phase 5; the point of having it this early
 * is that from Phase 1 onward there is real logged data that cannot be
 * regenerated by writing more code.
 */
function exportDb(): Uint8Array {
  if (!db || !capi) throw new Error('database not open');
  if (typeof capi.sqlite3_js_db_export !== 'function') {
    throw new Error('this sqlite-wasm build has no sqlite3_js_db_export');
  }
  return capi.sqlite3_js_db_export(db.pointer);
}

// ------------------------------------------------------ backup and restore

/** What a database holds: sound or not, which version, how many rows of what. */
function summarise(d: OoDb, bytes: number): BackupInfo {
  // integrity_check returns one row saying "ok", or up to a hundred rows of
  // what is wrong; the first is enough to refuse on.
  const integrity = String(d.selectValue('PRAGMA integrity_check') ?? 'no answer');
  const version = Number(d.selectValue('PRAGMA user_version') ?? 0);
  const tables = (
    d.exec({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'", rowMode: 'array', returnValue: 'resultRows' }) as unknown[][]
  ).map((r) => String(r[0]));
  const counts: Record<string, number> = {};
  for (const t of COUNTED) {
    // The names are this app's own constants, never a file's.
    if (tables.includes(t)) counts[t] = Number(d.selectValue(`SELECT COUNT(*) FROM ${t}`) ?? 0);
  }
  return { integrity, version, bytes, tables, counts };
}

function needOpfs(): OpfsStatic {
  if (!Opfs || mode !== 'opfs') {
    throw new Error('This browser is not keeping Mealo on disk, so a backup cannot be checked or restored here.');
  }
  return Opfs;
}

async function fileBytes(name: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(name.slice(1))).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function removeFile(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name.slice(1)).catch(() => {});
}

/**
 * Open a backup beside the live database and say what is in it.
 *
 * `importDb` refuses anything that does not start as a SQLite file; a file
 * that starts right and is broken further in is caught by integrity_check.
 * The live database is not touched, opened or closed by any of this.
 */
async function inspect(bytes: Uint8Array, purpose: 'restore' | 'check'): Promise<BackupInfo> {
  const O = needOpfs();
  const path = purpose === 'restore' ? CANDIDATE : CHECK;
  await removeFile(path);
  try {
    await O.importDb(path, bytes);
  } catch {
    throw new Error('This file is not a Mealo backup: it is not a database at all.');
  }
  let d: OoDb | null = null;
  try {
    d = new O(path);
    return summarise(d, bytes.byteLength);
  } catch (e) {
    await removeFile(path);
    throw new Error(`This file could not be opened as a database (${e instanceof Error ? e.message : String(e)}).`);
  } finally {
    d?.close();
    // A fresh backup's copy has done its job once it has been read.
    if (purpose === 'check') await removeFile(path);
  }
}

/** Put a file in place of the live database and open it. The caller has closed `db`. */
async function putInPlace(O: OpfsStatic, bytes: Uint8Array): Promise<void> {
  // A journal left beside the old file belongs to the old file. Applied to
  // the new one it would "roll back" pages of someone's restored records.
  await removeFile(`${LIVE}-journal`);
  await removeFile(`${LIVE}-wal`);
  await O.importDb(LIVE, bytes);
  db = new O(LIVE);
  db.exec({ sql: 'PRAGMA foreign_keys = ON;' });
}

/**
 * Replace everything on this phone with the backup last inspected.
 *
 * In this order, and the order is the safety:
 *   - the file is judged again, here, so nothing but a file that passed can
 *     be restored whatever the screen did;
 *   - a copy of the live database is taken, and if that fails nothing else
 *     happens;
 *   - the live database is replaced, opened, checked, brought up to this
 *     app's version, and its rows counted against the file's;
 *   - any failure after the replacement puts the copy back.
 */
async function restore(): Promise<{ restored: BackupInfo; before: BackupInfo }> {
  const O = needOpfs();
  if (!db) throw new Error('database not open');

  let bytes: Uint8Array;
  let file: BackupInfo;
  try {
    bytes = await fileBytes(CANDIDATE);
    const d = new O(CANDIDATE);
    try {
      file = summarise(d, bytes.byteLength);
    } finally {
      d.close();
    }
  } catch {
    throw new Error('Choose a backup file first.');
  }
  const why = refusal(file, LATEST_VERSION);
  if (why) throw new Error(why);

  const before = summarise(db, 0);
  await removeFile(BEFORE);
  try {
    db.exec({ sql: 'VACUUM INTO ?', bind: [BEFORE] });
  } catch (e) {
    throw new Error(
      `Nothing was changed. A copy of what is on this phone could not be made first, so the restore did not start (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  const safety = await fileBytes(BEFORE);

  db.close();
  db = null;
  try {
    await putInPlace(O, bytes);
    const opened = summarise(db!, bytes.byteLength);
    if (opened.integrity !== 'ok') throw new Error(`the restored database did not pass its check (${opened.integrity.slice(0, 120)})`);
    // An older backup is brought forward exactly as an update would have.
    await migrate();
    const restored = summarise(db!, bytes.byteLength);
    const differs = sameRows(file, restored);
    if (differs) throw new Error(`the restored database does not hold what the file did (${differs})`);
    await removeFile(CANDIDATE);
    return { restored, before };
  } catch (e) {
    // Back to exactly what was here. If even this fails, the copy is still
    // on disk under BEFORE and the error says so.
    const reason = e instanceof Error ? e.message : String(e);
    try {
      (db as OoDb | null)?.close();
      db = null;
      await putInPlace(O, safety);
    } catch (again) {
      throw new Error(
        `The restore failed (${reason}) and what was on this phone could not be put back automatically (${again instanceof Error ? again.message : String(again)}). It is still saved on this phone; do not clear the app's data. Close and reopen Mealo.`,
      );
    }
    throw new Error(`Nothing was changed. The restore failed and what was on this phone was put back (${reason}).`);
  }
}

/**
 * Take this week's copy if the newest is a week old or there is none. The
 * empty slot is filled first, then the older of the two. `now` is passed in
 * so the test can stand a week later; the files' own times say how old the
 * copies are.
 */
async function weekly(now: number): Promise<{ taken: boolean; at: number | null }> {
  if (!db || mode !== 'opfs') return { taken: false, at: null };
  const root = await navigator.storage.getDirectory();
  const ages = await Promise.all(
    WEEKLY.map(async (name) => {
      try {
        return (await (await root.getFileHandle(name.slice(1))).getFile()).lastModified;
      } catch {
        return null;
      }
    }),
  );
  const newest = Math.max(0, ...ages.map((a) => a ?? 0));
  if (newest > 0 && now - newest < WEEK_MS) return { taken: false, at: newest };
  const slot = ages[0] === null ? 0 : ages[1] === null ? 1 : ages[0] <= ages[1] ? 0 : 1;
  // VACUUM INTO will not write over a file, and the old copy in this slot is
  // the one this replaces.
  await removeFile(WEEKLY[slot]);
  db.exec({ sql: 'VACUUM INTO ?', bind: [WEEKLY[slot]] });
  return { taken: true, at: now };
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  const reply = (msg: Ok | Err) => (self as DedicatedWorkerGlobalScope).postMessage(msg);
  try {
    switch (req.type) {
      case 'init':
        reply({ id: req.id, ok: true, result: await init() });
        break;
      case 'exec':
        reply({ id: req.id, ok: true, result: exec(req.sql, req.bind) });
        break;
      case 'bulk':
        reply({ id: req.id, ok: true, result: bulk(req.table, req.columns, req.rows) });
        break;
      case 'export':
        reply({ id: req.id, ok: true, result: exportDb() });
        break;
      case 'describe':
        if (!db) throw new Error('database not open');
        reply({ id: req.id, ok: true, result: summarise(db, 0) });
        break;
      case 'inspect':
        reply({ id: req.id, ok: true, result: await inspect(req.bytes, req.purpose) });
        break;
      case 'restore':
        reply({ id: req.id, ok: true, result: await restore() });
        break;
      case 'weekly':
        reply({ id: req.id, ok: true, result: await weekly(req.now) });
        break;
    }
  } catch (e) {
    reply({
      id: req.id,
      ok: false,
      error: e instanceof Error ? `${e.message}` : String(e),
    });
  }
};
