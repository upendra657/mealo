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
  | { id: number; type: 'export' };

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
  close(): void;
  pointer: number;
};

type Capi = { sqlite3_js_db_export(ptr: number): Uint8Array };

let db: OoDb | null = null;
let capi: Capi | null = null;
let mode: 'opfs' | 'memory' = 'memory';
let snapshot: SnapshotOutcome = { status: 'none' };

type Info = { mode: string; version: number; snapshot: SnapshotOutcome };

async function init(): Promise<Info> {
  if (db) return { mode, version: currentVersion(), snapshot };

  const sqlite3 = await loadSqlite3();

  const oo1 = (sqlite3 as unknown as { oo1: Record<string, unknown> }).oo1;
  capi = (sqlite3 as unknown as { capi: Capi }).capi;

  if ('OpfsDb' in oo1 && typeof oo1.OpfsDb === 'function') {
    const Ctor = oo1.OpfsDb as new (path: string) => OoDb;
    db = new Ctor('/mealo.sqlite3');
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
 * instead, in the status bar.
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
      case 'export':
        reply({ id: req.id, ok: true, result: exportDb() });
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
