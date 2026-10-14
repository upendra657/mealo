/**
 * Keeping the record safe: when the last backup was, when the household last
 * synced, and when either has gone long enough to say so.
 *
 * Everything a person logs lives on their phone and nowhere else, and the
 * relay forgets a household's changes after 30 days. Neither failure makes a
 * sound: a phone that was never backed up looks exactly like one that was,
 * until it is lost. So the app says, in the Dev screen always and on Home
 * once it matters (his decision, 15 Oct 2026).
 *
 * The thresholds and the wording are pure, for the tests; the two dates are
 * kept in the browser's own store, like the rest of this phone's settings.
 */

import { kvGet, kvSet } from '../lib/kv';

/** Days without a backup before Home says so. His number, 15 Oct 2026. */
export const BACKUP_NUDGE_DAYS = 7;
/** Days without a sync before the Household card turns amber. His, the same night. */
export const SYNC_AMBER_DAYS = 7;
/** How long the relay keeps a batch: KEEP_DAYS in worker/index.ts. */
export const RELAY_KEEP_DAYS = 30;
/**
 * When the warning becomes "sync before it is too late": five days before
 * the relay forgets, so a weekend away does not run out the clock.
 */
export const SYNC_URGENT_DAYS = RELAY_KEEP_DAYS - 5;

const DAY_MS = 86_400_000;
const LAST_BACKUP_KV = 'upkeep.lastBackup';

/** Whole days since `at`. */
export function daysSince(at: number, now: number): number {
  return Math.floor((now - at) / DAY_MS);
}

/**
 * Whether Home should ask for a backup. Not on a phone with nothing on it:
 * a new install asked to back up an empty database learns to ignore the ask.
 */
export function backupDue(last: number | null, now: number, hasRecords: boolean): boolean {
  if (!hasRecords) return false;
  return last === null || daysSince(last, now) >= BACKUP_NUDGE_DAYS;
}

export type SyncTone = 'ok' | 'amber' | 'urgent' | 'never';

export function syncTone(last: number | null, now: number): SyncTone {
  if (last === null) return 'never';
  const d = daysSince(last, now);
  if (d >= SYNC_URGENT_DAYS) return 'urgent';
  if (d >= SYNC_AMBER_DAYS) return 'amber';
  return 'ok';
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "12 days ago". */
export function ago(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = daysSince(at, now);
  return days <= 1 ? 'yesterday' : `${days} days ago`;
}

/** When this phone last made a backup it handed over, or null for never. */
export async function lastBackupAt(): Promise<number | null> {
  return (await kvGet<number>(LAST_BACKUP_KV)) ?? null;
}

/**
 * Called once a backup has been handed to the share sheet or downloaded, and
 * not when the sheet was closed: a backup that was never saved must not
 * quieten the reminder to make one.
 */
export async function noteBackup(at = Date.now()): Promise<void> {
  await kvSet(LAST_BACKUP_KV, at);
}
