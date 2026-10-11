/**
 * Backing up and restoring the whole database: what a backup file must be
 * before the app will put it in place of what is on the phone.
 *
 * Restore is the one operation in the app that deliberately replaces
 * everything a person has logged. So it is built to be hard to get wrong:
 *
 *   1. The file is opened beside the live database, never over it, and read:
 *      is it a database, is it sound, is it Mealo's, which version, and how
 *      much is in it. Nothing on the phone has changed at this point.
 *   2. The person is shown what the file holds next to what the phone holds
 *      now, and presses the button knowing both.
 *   3. A copy of what is on the phone is taken first. Without that copy the
 *      restore does not start.
 *   4. The file is put in place, opened, checked again and brought up to the
 *      app's version. If any step fails, the copy from step 3 is put back.
 *
 * This module is the judging in steps 1 and 4, kept pure so it is tested
 * without a browser. The steps themselves are in worker.ts.
 *
 * What a backup does not hold, on purpose: the model provider and its API
 * key, and the code that pairs two phones. Both live outside the database.
 * A key written into a file in Downloads is a key that has left the place
 * built to keep it, so after a restore the provider is set up again and the
 * phones are paired again. Everything logged, the food table, the medicines,
 * the chat and every profile are in the file.
 */

/** The tables whose row counts describe a backup, and prove a restore. */
export const COUNTED = [
  'profiles',
  'meals',
  'meal_items',
  'custom_foods',
  'food_portions',
  'medications',
  'med_doses',
  'intake_events',
  'sick_episodes',
  'weights',
  'burns',
  'symptoms',
  'targets',
  'messages',
] as const;

/** Tables a file must have to be Mealo's at all. They have existed since v1 or v4. */
export const REQUIRED = ['meals', 'meal_items', 'custom_foods', 'medications', 'weights', 'symptoms'] as const;

export type BackupInfo = {
  /** SQLite's own verdict on the file: "ok", or what is wrong with it. */
  integrity: string;
  /** The schema version the file is at. */
  version: number;
  bytes: number;
  tables: string[];
  /** Rows in each counted table the file has. */
  counts: Record<string, number>;
};

/**
 * Why a file may not be restored, in words for the person, or null when it
 * may.
 *
 * A file from a newer Mealo is refused, not attempted: this build does not
 * know that version's tables, and opening them would be guessing with
 * someone's records. An older file is fine. It is brought forward by the
 * same migrations that would have run had the app simply been updated.
 */
export function refusal(info: BackupInfo, latest: number): string | null {
  if (info.integrity !== 'ok') return `This file is damaged and cannot be restored (${info.integrity.slice(0, 120)}).`;
  if (info.version === 0) return 'This file is an empty database. There is nothing in it to restore.';
  const missing = REQUIRED.filter((t) => !info.tables.includes(t));
  if (missing.length > 0) return 'This is a database, but not one made by Mealo.';
  if (info.version > latest) {
    return `This backup was made by a newer version of Mealo (its data is at version ${info.version}, this app understands up to ${latest}). Update the app, then restore.`;
  }
  return null;
}

/**
 * Whether the database in place after a restore holds what the file did.
 * Every counted table the file had must have exactly as many rows now.
 */
export function sameRows(file: BackupInfo, now: BackupInfo): string | null {
  for (const table of Object.keys(file.counts)) {
    if (now.counts[table] !== file.counts[table]) {
      return `${table}: the file has ${file.counts[table]} rows, the restored database has ${now.counts[table] ?? 'none'}`;
    }
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What a backup holds, in the few figures a person would recognise their data by. */
export function describe(info: BackupInfo): string[] {
  const c = (t: string) => info.counts[t] ?? 0;
  return [
    plural(c('meals'), 'meal'),
    `${plural(c('meal_items'), 'dish', 'dishes')} eaten`,
    `${plural(c('custom_foods'), 'dish', 'dishes')} in the food table`,
    plural(c('medications'), 'medicine'),
    `${plural(c('intake_events'), 'dose')} answered`,
    plural(c('weights'), 'weight'),
    plural(c('symptoms'), 'symptom'),
    plural(c('messages'), 'chat message'),
    plural(c('profiles'), 'profile'),
  ];
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "mealo-backup-2026-10-11.sqlite3": dated in the person's own day, not UTC. */
export function backupName(now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `mealo-backup-${d}.sqlite3`;
}
