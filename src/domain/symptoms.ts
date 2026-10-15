/**
 * Symptom logging — Ask Mealo only.
 *
 * `symptoms` is the one table no other agent may read. Everything
 * Thali and Dawa need about how the user is doing arrives through
 * `current_state`, which Ask Mealo writes deliberately. That asymmetry is the
 * whole point of the scoping layer, and this is the table it protects.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';

const db = scopedDb('doctor');

export type Symptom = {
  id: string;
  noted_at: number;
  /** When it began, if not when it was logged (v15). */
  started_at: number | null;
  raw_text: string;
  label: string | null;
  severity: number | null;
  resolved_at: number | null;
  updated_at: number;
  deleted_at: number | null;
};

export async function logSymptom(
  rawText: string,
  opts: { label?: string; severity?: number; startedAt?: number | null } = {},
): Promise<string> {
  const now = Date.now();
  return db.insert('symptoms', {
    noted_at: now,
    // Only a start before now is a start; anything else is "when logged".
    started_at: opts.startedAt != null && opts.startedAt < now ? opts.startedAt : null,
    raw_text: rawText.trim(),
    label: opts.label?.trim() || null,
    severity: opts.severity ?? null,
    resolved_at: null,
    deleted_at: null,
  });
}

/**
 * Take back a symptom logged a moment ago. Not the same as resolving it:
 * resolved means it happened and passed, this means it was never meant to be
 * recorded. Soft, like every delete here.
 */
export async function removeSymptom(id: string): Promise<void> {
  await db.softDelete('symptoms', id);
}

/** Still bothering them: logged, not resolved. */
export async function openSymptoms(): Promise<Symptom[]> {
  return db.query<Symptom>(
    `SELECT * FROM symptoms
      WHERE profile_id = ? AND deleted_at IS NULL AND resolved_at IS NULL
      ORDER BY noted_at DESC`,
    [activeProfile()],
  );
}

export async function recentSymptoms(days = 14): Promise<Symptom[]> {
  // Newest first by when it began, not when it was written down (15 Oct
  // 2026): "bloated after lunch", logged at night, sits at lunchtime.
  return db.query<Symptom>(
    `SELECT * FROM symptoms
      WHERE profile_id = ? AND deleted_at IS NULL AND noted_at >= ?
      ORDER BY COALESCE(started_at, noted_at) DESC`,
    [activeProfile(), Date.now() - days * 86_400_000],
  );
}

export async function resolveSymptom(id: string): Promise<void> {
  await db.update('symptoms', id, { resolved_at: Date.now() });
}

export async function reopenSymptom(id: string): Promise<void> {
  await db.update('symptoms', id, { resolved_at: null });
}

export async function deleteSymptom(id: string): Promise<void> {
  await db.softDelete('symptoms', id);
}

/** When a symptom began: its start if one was given, else when it was logged. */
export const beganAt = (s: Pick<Symptom, 'noted_at' | 'started_at'>) => s.started_at ?? s.noted_at;
