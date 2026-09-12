/**
 * The Pharmacist's domain operations.
 *
 * Everything here runs through a pharmacist-scoped database handle, so a stray
 * read of `symptoms` fails loudly instead of quietly working.
 *
 * Note what is absent: nothing in this file suggests, computes, adjusts or
 * validates a dose. `dose_text` is stored exactly as the user typed it and
 * echoed back unchanged. That is requirement R2, and it is enforced by there
 * being no code that could do otherwise.
 */

import { scopedDb } from '../db/scope';
import { extractJson } from '../llm/extract';
import type { ProviderConfig } from '../llm/types';

const db = scopedDb('pharmacist');

export type Medication = {
  id: string;
  name: string;
  raw_text: string | null;
  rxcui: string | null;
  dose_text: string | null;
  schedule: string | null;
  started_on: string | null;
  ended_on: string | null;
  notes: string | null;
  updated_at: number;
  deleted_at: number | null;
};

export type IntakeEvent = {
  id: string;
  medication_id: string;
  taken_at: number;
  status: 'taken' | 'skipped';
  note: string | null;
  updated_at: number;
  deleted_at: number | null;
};

export type MedicationDraft = {
  name: string;
  dose_text: string | null;
  schedule: string | null;
  notes: string | null;
};

/** Local midnight, not UTC — "today" means the user's day. */
export function startOfToday(d = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function todayIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- reads

/** Things being taken right now: not deleted, not stopped. */
export async function listActive(): Promise<Medication[]> {
  return db.query<Medication>(
    `SELECT * FROM medications
      WHERE deleted_at IS NULL AND ended_on IS NULL
      ORDER BY name COLLATE NOCASE`,
  );
}

export async function listStopped(): Promise<Medication[]> {
  return db.query<Medication>(
    `SELECT * FROM medications
      WHERE deleted_at IS NULL AND ended_on IS NOT NULL
      ORDER BY ended_on DESC`,
  );
}

/** Every intake event logged today, newest first. */
export async function intakeToday(): Promise<IntakeEvent[]> {
  return db.query<IntakeEvent>(
    `SELECT * FROM intake_events
      WHERE deleted_at IS NULL AND taken_at >= ?
      ORDER BY taken_at DESC`,
    [startOfToday()],
  );
}

/** How many days in the last `days` had at least one intake event. */
export async function loggingStreak(days = 14): Promise<number> {
  const since = startOfToday() - (days - 1) * 86_400_000;
  const rows = await db.query<{ taken_at: number }>(
    `SELECT taken_at FROM intake_events
      WHERE deleted_at IS NULL AND taken_at >= ?`,
    [since],
  );
  const daysWithLogs = new Set(
    rows.map((r) => new Date(r.taken_at).setHours(0, 0, 0, 0)),
  );
  let streak = 0;
  for (let i = 0; i < days; i++) {
    const day = startOfToday() - i * 86_400_000;
    if (!daysWithLogs.has(day)) break;
    streak++;
  }
  return streak;
}

// ---------------------------------------------------------------- writes

export async function addMedication(draft: MedicationDraft): Promise<string> {
  return db.insert('medications', {
    name: draft.name.trim(),
    raw_text: null,
    rxcui: null,
    dose_text: draft.dose_text?.trim() || null,
    schedule: draft.schedule?.trim() || null,
    started_on: todayIso(),
    ended_on: null,
    notes: draft.notes?.trim() || null,
    deleted_at: null,
  });
}

export async function addMedicationFromText(
  draft: MedicationDraft,
  rawText: string,
): Promise<string> {
  const id = await addMedication(draft);
  await db.update('medications', id, { raw_text: rawText });
  return id;
}

export async function editMedication(
  id: string,
  patch: Partial<MedicationDraft>,
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.dose_text !== undefined)
    values.dose_text = patch.dose_text?.trim() || null;
  if (patch.schedule !== undefined)
    values.schedule = patch.schedule?.trim() || null;
  if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
  if (Object.keys(values).length === 0) return;
  await db.update('medications', id, values);
}

/** Stopping keeps the history. Only an explicit delete removes it. */
export async function stopMedication(id: string): Promise<void> {
  await db.update('medications', id, { ended_on: todayIso() });
}

export async function resumeMedication(id: string): Promise<void> {
  await db.update('medications', id, { ended_on: null });
}

export async function deleteMedication(id: string): Promise<void> {
  await db.softDelete('medications', id);
}

export async function logIntake(
  medicationId: string,
  status: 'taken' | 'skipped',
  note?: string,
): Promise<string> {
  return db.insert('intake_events', {
    medication_id: medicationId,
    taken_at: Date.now(),
    status,
    note: note?.trim() || null,
    deleted_at: null,
  });
}

export async function undoIntake(eventId: string): Promise<void> {
  await db.softDelete('intake_events', eventId);
}

// ---------------------------------------------------------------- parsing

/**
 * "creatine 5g every morning" → a draft the user confirms before it is saved.
 *
 * Always confirmed, never auto-saved. The model is reading words, and a
 * misheard dose that lands silently in your medication list is exactly the
 * class of error this app must not make.
 */
export async function parseMedicationText(
  cfg: ProviderConfig,
  text: string,
): Promise<MedicationDraft> {
  const draft = await extractJson<Partial<MedicationDraft>>(cfg, {
    system: [
      'You extract medication and supplement records from what someone typed.',
      'Return exactly these keys:',
      '  name       the substance, e.g. "Creatine monohydrate", "Metformin"',
      '  dose_text  the amount exactly as written, e.g. "5g", "500 mg". null if absent.',
      '  schedule   when they take it, e.g. "every morning", "twice daily". null if absent.',
      '  notes      anything else they said, or null.',
      '',
      'Copy the dose verbatim. Never convert units, never infer an amount that',
      'was not written, and never suggest one. If no dose was given, dose_text',
      'is null.',
    ].join('\n'),
    user: text,
    maxTokens: 300,
  });

  if (!draft?.name || typeof draft.name !== 'string') {
    throw new Error(
      `Could not find a substance name in "${text}". Add it manually instead.`,
    );
  }

  return {
    name: draft.name,
    dose_text: typeof draft.dose_text === 'string' ? draft.dose_text : null,
    schedule: typeof draft.schedule === 'string' ? draft.schedule : null,
    notes: typeof draft.notes === 'string' ? draft.notes : null,
  };
}
