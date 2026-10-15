/**
 * Main-thread API over the SQLite worker.
 *
 * Keep this interface small. The Phase 0 spike may well conclude that Evolu (or
 * some other sync engine) owns the storage layer instead — if that happens, the
 * only thing that should need rewriting is this file and db/worker.ts, not
 * every caller.
 */

import { newId, now } from '../lib/device';
import type { SnapshotOutcome } from './snapshots';
import { backupName, refusal, type BackupInfo } from './backup';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export type DbInfo = {
  mode: 'opfs' | 'memory';
  version: number;
  /** What happened to the pre-update copy on this launch; see snapshots.ts. */
  snapshot: SnapshotOutcome;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let infoPromise: Promise<DbInfo> | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as
      | { id: number; ok: true; result: unknown }
      | { id: number; ok: false; error: string };
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(`database worker failed: ${ev.message}`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  return worker;
}

function call<T>(payload: Record<string, unknown>): Promise<T> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    w.postMessage({ id, ...payload });
  });
}

/** Opens the database and runs migrations. Safe to call repeatedly. */
export function initDb(): Promise<DbInfo> {
  if (!infoPromise) {
    infoPromise = call<DbInfo>({ type: 'init' });
  }
  return infoPromise;
}

/** Run SQL and get rows back as objects. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  bind?: unknown[],
): Promise<T[]> {
  await initDb();
  return call<T[]>({ type: 'exec', sql, bind });
}

/** Run SQL for effect. */
export async function run(sql: string, bind?: unknown[]): Promise<void> {
  await initDb();
  await call<unknown>({ type: 'exec', sql, bind });
}

/**
 * Many rows in one transaction. The worker allows this into the medicine
 * reference table only; see BULK_TABLES there.
 */
export async function bulkInsert(table: string, columns: string[], rows: unknown[][]): Promise<number> {
  await initDb();
  return call<number>({ type: 'bulk', table, columns, rows });
}

/**
 * Insert helper that fills in the three columns every table carries.
 * Returns the new row id.
 */
/** One write, as a value: what `transaction` runs, in order. */
export type Stmt = { sql: string; bind: unknown[] };

/** The INSERT `insert` runs, and the id it gives the row. */
export async function insertStmt(
  table: string,
  values: Record<string, unknown>,
): Promise<{ stmt: Stmt; id: string }> {
  const id = (values.id as string | undefined) ?? (await newId());
  const row: Record<string, unknown> = { ...values, id, updated_at: now() };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  return {
    stmt: { sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, bind: cols.map((c) => row[c]) },
    id,
  };
}

/** The UPDATE `update` runs, which always bumps updated_at. */
export function updateStmt(table: string, id: string, values: Record<string, unknown>): Stmt {
  const row: Record<string, unknown> = { ...values, updated_at: now() };
  const cols = Object.keys(row);
  return {
    sql: `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    bind: [...cols.map((c) => row[c]), id],
  };
}

/** The soft delete `softDelete` runs. */
export function softDeleteStmt(table: string, id: string): Stmt {
  const ts = now();
  return { sql: `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, bind: [ts, ts, id] };
}

/** Several writes as one unit, in one message to the worker (db/worker.ts). */
export async function transaction(statements: Stmt[]): Promise<void> {
  await initDb();
  await call<number>({ type: 'tx', statements });
}

export async function insert(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const { stmt, id } = await insertStmt(table, values);
  await run(stmt.sql, stmt.bind);
  return id;
}

/** Update helper that always bumps updated_at. */
export async function update(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const stmt = updateStmt(table, id, values);
  await run(stmt.sql, stmt.bind);
}

/**
 * Soft delete. A hard DELETE cannot be represented in a delta stream, so no
 * caller should ever issue one against a synced table.
 */
export async function softDelete(table: string, id: string): Promise<void> {
  const stmt = softDeleteStmt(table, id);
  await run(stmt.sql, stmt.bind);
}

/** Raw bytes of the whole database, for the export button. */
export async function exportDatabase(): Promise<Uint8Array> {
  await initDb();
  return call<Uint8Array>({ type: 'export' });
}

/** What this phone holds now, counted the way a backup is. */
/**
 * The weekly copy inside the phone (db/worker.ts), taken if this week's is
 * missing. Called once after start; it is a VACUUM INTO of a few megabytes.
 */
export async function keepWeeklyCopy(now = Date.now()): Promise<{ taken: boolean; at: number | null }> {
  await initDb();
  return call<{ taken: boolean; at: number | null }>({ type: 'weekly', now });
}

export async function describeDatabase(): Promise<BackupInfo> {
  await initDb();
  return call<BackupInfo>({ type: 'describe' });
}

/**
 * A backup of everything, proved readable before it is handed over.
 *
 * The bytes are written to a spare file, opened as a database and counted.
 * A backup nobody has opened is a hope; this one has been opened once, and
 * its counts are shown so the person can see it is the whole of their data.
 */
export async function makeBackup(): Promise<{ file: File; info: BackupInfo }> {
  const bytes = await exportDatabase();
  const info = await call<BackupInfo>({ type: 'inspect', bytes, purpose: 'check' });
  const why = refusal(info, info.version);
  if (why) throw new Error(`The backup did not pass its own check and was not saved. ${why}`);
  // octet-stream, not a SQLite type: a phone's share sheet turns away files
  // whose type it does not know, and this one must reach Files.
  return { file: new File([bytes as BlobPart], backupName(), { type: 'application/octet-stream' }), info };
}

/** Look inside a backup file. Changes nothing on this phone. */
export async function inspectBackup(file: Blob): Promise<BackupInfo> {
  await initDb();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return call<BackupInfo>({ type: 'inspect', bytes, purpose: 'restore' });
}

/** Replace this phone's data with the backup last inspected. See worker.ts. */
export async function restoreBackup(): Promise<{ restored: BackupInfo; before: BackupInfo }> {
  await initDb();
  return call<{ restored: BackupInfo; before: BackupInfo }>({ type: 'restore' });
}

/** Hands a blob to the browser as a download. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
