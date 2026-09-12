/**
 * Symptom logging — Doctor-only.
 *
 * `symptoms` is the one table no other agent may read. Everything the
 * Nutritionist and Pharmacist need about how the user is doing arrives through
 * `current_state`, which the Doctor writes deliberately. That asymmetry is the
 * whole point of the scoping layer, and this is the table it protects.
 */

import { scopedDb } from '../db/scope';

const db = scopedDb('doctor');

export type Symptom = {
  id: string;
  noted_at: number;
  raw_text: string;
  label: string | null;
  severity: number | null;
  resolved_at: number | null;
  updated_at: number;
  deleted_at: number | null;
};

export async function logSymptom(
  rawText: string,
  opts: { label?: string; severity?: number } = {},
): Promise<string> {
  return db.insert('symptoms', {
    noted_at: Date.now(),
    raw_text: rawText.trim(),
    label: opts.label?.trim() || null,
    severity: opts.severity ?? null,
    resolved_at: null,
    deleted_at: null,
  });
}

/** Still bothering them: logged, not resolved. */
export async function openSymptoms(): Promise<Symptom[]> {
  return db.query<Symptom>(
    `SELECT * FROM symptoms
      WHERE deleted_at IS NULL AND resolved_at IS NULL
      ORDER BY noted_at DESC`,
  );
}

export async function recentSymptoms(days = 14): Promise<Symptom[]> {
  return db.query<Symptom>(
    `SELECT * FROM symptoms
      WHERE deleted_at IS NULL AND noted_at >= ?
      ORDER BY noted_at DESC`,
    [Date.now() - days * 86_400_000],
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
