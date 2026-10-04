/**
 * Copies of the database taken just before an update migrates it.
 *
 * A migration's transaction rolls back SQL that errors. It cannot roll back
 * SQL that is valid and wrong — that commits, on the only copy there is, and
 * the tests in scripts/ are the only thing standing in front of it. This is
 * what is left if one gets through: the file exactly as it was before the
 * update touched it, sitting next to the database in OPFS.
 *
 * Named by the schema version they hold, not by date: "the database before v9"
 * is the question anyone restoring one is asking.
 */

import { LATEST_VERSION } from './migrations';

/**
 * Two, not one. The newest is the state right before the update just
 * installed; the one before covers damage that was only noticed after the
 * next update had already landed on top of it. Each costs one copy of a
 * database measured in hundreds of kilobytes.
 */
export const KEEP = 2;

export type SnapshotOutcome =
  | { status: 'none' }
  | { status: 'saved'; version: number }
  | { status: 'failed'; version: number; error: string };

export type Snapshot = {
  /** The schema version the copy holds. */
  version: number;
  name: string;
  bytes: number;
  takenAt: number;
};

export function snapshotName(version: number): string {
  return `mealo.pre-v${version}.sqlite3`;
}

/**
 * Probes each possible name rather than listing the directory. The set of
 * names is small and known, and directory iteration is the part of OPFS whose
 * typings and support still vary between the browsers this runs in.
 */
export async function listSnapshots(): Promise<Snapshot[]> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return [];
  const root = await navigator.storage.getDirectory();
  const found: Snapshot[] = [];
  for (let v = LATEST_VERSION - 1; v >= 1; v--) {
    try {
      const file = await (await root.getFileHandle(snapshotName(v))).getFile();
      found.push({ version: v, name: file.name, bytes: file.size, takenAt: file.lastModified });
    } catch {
      /* no copy from before this version */
    }
  }
  return found;
}

/** Removes all but the newest KEEP, counting the one just taken at `newest`. */
export async function pruneSnapshots(
  root: FileSystemDirectoryHandle,
  newest: number,
): Promise<void> {
  let kept = 1;
  for (let v = newest - 1; v >= 1; v--) {
    const name = snapshotName(v);
    try {
      await root.getFileHandle(name);
    } catch {
      continue;
    }
    if (kept < KEEP) kept++;
    else await root.removeEntry(name);
  }
}

export async function snapshotFile(s: Snapshot): Promise<File> {
  const root = await navigator.storage.getDirectory();
  return (await root.getFileHandle(s.name)).getFile();
}
