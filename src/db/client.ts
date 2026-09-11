/**
 * Main-thread API over the SQLite worker.
 *
 * Keep this interface small. The Phase 0 spike may well conclude that Evolu (or
 * some other sync engine) owns the storage layer instead — if that happens, the
 * only thing that should need rewriting is this file and db/worker.ts, not
 * every caller.
 */

import { newId, now } from '../lib/device';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export type DbInfo = { mode: 'opfs' | 'memory'; version: number };

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
 * Insert helper that fills in the three columns every table carries.
 * Returns the new row id.
 */
export async function insert(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const id = (values.id as string | undefined) ?? (await newId());
  const row: Record<string, unknown> = { ...values, id, updated_at: now() };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  await run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => row[c]),
  );
  return id;
}

/** Update helper that always bumps updated_at. */
export async function update(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const row: Record<string, unknown> = { ...values, updated_at: now() };
  const cols = Object.keys(row);
  const assignments = cols.map((c) => `${c} = ?`).join(', ');
  await run(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [
    ...cols.map((c) => row[c]),
    id,
  ]);
}

/**
 * Soft delete. A hard DELETE cannot be represented in a delta stream, so no
 * caller should ever issue one against a synced table.
 */
export async function softDelete(table: string, id: string): Promise<void> {
  const ts = now();
  await run(
    `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    [ts, ts, id],
  );
}

/** Raw bytes of the whole database, for the export button. */
export async function exportDatabase(): Promise<Uint8Array> {
  await initDb();
  return call<Uint8Array>({ type: 'export' });
}

/** Triggers a browser download of the database file. */
export async function downloadDatabase(): Promise<void> {
  const bytes = await exportDatabase();
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.sqlite3',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mealo-${stamp}.sqlite3`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
