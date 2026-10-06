/**
 * The Pharmacist's domain operations.
 *
 * Everything here runs through a pharmacist-scoped database handle, so a stray
 * read of `symptoms` fails loudly instead of quietly working.
 *
 * Note what is absent: nothing in this file computes, adjusts or validates a
 * dose. `dose_text` is stored exactly as the user typed it and echoed back
 * unchanged, and every amount in med_doses is a number a person entered. That
 * is requirement R2, and it is enforced by there being no code that could do
 * otherwise.
 *
 * The one place an amount reaches someone who did not type it is the library's
 * starting schedule: adding a medicine the household already has opens the
 * form on the schedule whoever added it first was taking. It is copied, never
 * derived, and it is a form to edit before anything is saved — the same
 * confirm-before-save rule the model's drafts live under.
 */

import { scopedDb } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import {
  addDays,
  isForm,
  isRunning,
  lastDayOf,
  medDay,
  medSlug,
  planDay,
  sortByTime,
  type DayPlan,
  type DoseSlot,
  type DurationUnit,
  type Episode,
  type Form,
  type PlanDose,
  type PlanIntake,
  type PlannedDose,
} from './doses';
import { normalise } from './foods';
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
  /** v10. NULL on every medicine added before the library existed. */
  product_id: string | null;
  /** v10. 1, 0, or NULL for "never asked" — see the migration. */
  long_term: number | null;
  /** v10. Set when the medicine belongs to a sickness. */
  episode_id: string | null;
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
      WHERE profile_id = ? AND deleted_at IS NULL AND ended_on IS NULL
      ORDER BY name COLLATE NOCASE`,
    [activeProfile()],
  );
}

export async function listStopped(): Promise<Medication[]> {
  return db.query<Medication>(
    `SELECT * FROM medications
      WHERE profile_id = ? AND deleted_at IS NULL AND ended_on IS NOT NULL
      ORDER BY ended_on DESC`,
    [activeProfile()],
  );
}

/** Every intake event logged today, newest first. */
export async function intakeToday(): Promise<IntakeEvent[]> {
  return db.query<IntakeEvent>(
    `SELECT * FROM intake_events
      WHERE profile_id = ? AND deleted_at IS NULL AND taken_at >= ?
      ORDER BY taken_at DESC`,
    [activeProfile(), startOfToday()],
  );
}

/** How many days in the last `days` had at least one intake event. */
export async function loggingStreak(days = 14): Promise<number> {
  const since = startOfToday() - (days - 1) * 86_400_000;
  const rows = await db.query<{ taken_at: number }>(
    `SELECT taken_at FROM intake_events
      WHERE profile_id = ? AND deleted_at IS NULL AND taken_at >= ?`,
    [activeProfile(), since],
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

// ------------------------------------------------------------ the library

export type Product = {
  id: string;
  slug: string | null;
  name: string;
  form: string | null;
  strength_text: string | null;
  private: number;
  hidden: number;
  updated_at: number;
};

export type Ingredient = { name: string; strength_text: string | null };

/** Everything the Add meds form holds, and everything Save writes. */
export type MedForm = {
  name: string;
  form: Form | null;
  /** The strength as printed, e.g. "650 mg". Stored verbatim as dose_text. */
  strength: string | null;
  ingredients: Ingredient[];
  doses: DoseSlot[];
  long_term: boolean;
  /** Only read when Save creates a new library entry. */
  private: boolean;
};

const clean = (s: string | null | undefined) => s?.trim() || null;

function cleanIngredients(list: Ingredient[]): Ingredient[] {
  return list
    .map((i) => ({ name: i.name.trim(), strength_text: clean(i.strength_text) }))
    .filter((i) => i.name);
}

/** Same ingredients, ignoring case, spacing and how a unit was typed. */
function sameIngredients(a: Ingredient[], b: Ingredient[]): boolean {
  const key = (l: Ingredient[]) => l.map((i) => medSlug(i.name, i.strength_text)).join('|');
  return key(a) === key(b);
}

/** The household's medicines, for the search at the top of Add meds. */
export async function searchLibrary(q: string): Promise<Product[]> {
  const rows = await db.query<Product>(
    `SELECT * FROM med_products
      WHERE deleted_at IS NULL AND hidden = 0
      ORDER BY name COLLATE NOCASE`,
  );
  const words = normalise(q).split(' ').filter(Boolean);
  if (words.length === 0) return rows;
  // Every word the person typed, anywhere in name or strength: "para 650"
  // finds Paracetamol 650 mg. The library is a household's worth of rows, so
  // filtering here is cheaper than teaching SQLite the normaliser.
  return rows.filter((p) => {
    const hay = normalise(`${p.name} ${p.strength_text ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

export async function ingredientsOf(productId: string): Promise<Ingredient[]> {
  return db.query<Ingredient>(
    `SELECT name, strength_text FROM med_product_ingredients
      WHERE product_id = ? AND deleted_at IS NULL ORDER BY position`,
    [productId],
  );
}

async function templateOf(productId: string): Promise<DoseSlot[]> {
  return db.query<DoseSlot>(
    `SELECT amount, unit, time_of_day, meal FROM med_product_doses
      WHERE product_id = ? AND deleted_at IS NULL ORDER BY position`,
    [productId],
  );
}

/**
 * A library entry as a filled-in form: what someone else in the household
 * saved, ready to be checked and changed before it becomes yours.
 */
export async function draftFromLibrary(productId: string): Promise<MedForm | null> {
  const p = (await db.query<Product>('SELECT * FROM med_products WHERE id = ?', [productId]))[0];
  if (!p) return null;
  return {
    name: p.name,
    form: isForm(p.form) ? p.form : null,
    strength: p.strength_text,
    ingredients: await ingredientsOf(p.id),
    doses: sortByTime(await templateOf(p.id)),
    long_term: false,
    private: p.private === 1,
  };
}

async function writeIngredients(productId: string, list: Ingredient[]): Promise<void> {
  const old = await db.query<{ id: string }>(
    'SELECT id FROM med_product_ingredients WHERE product_id = ? AND deleted_at IS NULL',
    [productId],
  );
  for (const r of old) await db.softDelete('med_product_ingredients', r.id);
  for (const [i, ing] of list.entries()) {
    await db.insert('med_product_ingredients', {
      product_id: productId,
      position: i + 1,
      name: ing.name,
      strength_text: ing.strength_text,
      deleted_at: null,
    });
  }
}

/**
 * The library entry a form belongs to, creating it if the household has none.
 *
 * Found by name and strength. If either changed, this finds or makes a
 * different entry and leaves the old one alone — Thyroxine 25 mcg is not an
 * edit of Thyroxine 50 mcg, and somebody else may be taking the 50. What a
 * matching entry does take from the form is a corrected type or ingredient
 * list, because those are facts about the same strip and correcting them is
 * meant to reach both phones.
 */
async function libraryEntryFor(f: MedForm): Promise<string> {
  const name = f.name.trim();
  const strength = clean(f.strength);
  const slug = medSlug(name, strength);
  const ingredients = cleanIngredients(f.ingredients);

  const found = (
    await db.query<Product>(
      `SELECT * FROM med_products WHERE slug = ? AND deleted_at IS NULL
        ORDER BY updated_at LIMIT 1`,
      [slug],
    )
  )[0];

  if (!found) {
    const id = await db.insert('med_products', {
      slug,
      name,
      form: f.form,
      strength_text: strength,
      private: f.private ? 1 : 0,
      hidden: 0,
      deleted_at: null,
    });
    await writeIngredients(id, ingredients);
    // Whoever adds a medicine first gives the library their schedule.
    for (const [i, d] of f.doses.entries()) {
      await db.insert('med_product_doses', { product_id: id, position: i + 1, ...d, deleted_at: null });
    }
    return id;
  }

  const patch: Record<string, unknown> = {};
  if (f.form && f.form !== found.form) patch.form = f.form;
  // Taken up again, so back in the search for the next person.
  if (found.hidden) patch.hidden = 0;
  if (Object.keys(patch).length) await db.update('med_products', found.id, patch);
  if (!sameIngredients(ingredients, await ingredientsOf(found.id))) {
    await writeIngredients(found.id, ingredients);
  }
  return found.id;
}

function checkForm(f: MedForm) {
  if (!f.name.trim()) throw new Error('A medicine needs a name.');
  if (f.doses.length < 1 || f.doses.length > 4) {
    throw new Error('A medicine is taken between one and four times a day.');
  }
}

async function writeDoses(medicationId: string, doses: DoseSlot[]): Promise<void> {
  for (const [i, d] of sortByTime(doses).entries()) {
    await db.insert('med_doses', {
      medication_id: medicationId,
      position: i + 1,
      amount: d.amount,
      unit: d.unit,
      time_of_day: d.time_of_day,
      meal: d.meal,
      deleted_at: null,
    });
  }
}

/**
 * Save from Add meds. With `episodeId`, the medicine belongs to that sickness
 * and stops being due when it ends.
 */
export async function addMedicine(f: MedForm, episodeId: string | null = null): Promise<string> {
  checkForm(f);
  const productId = await libraryEntryFor(f);
  const id = await db.insert('medications', {
    name: f.name.trim(),
    raw_text: null,
    rxcui: null,
    dose_text: clean(f.strength),
    schedule: null,
    started_on: medDay(),
    ended_on: null,
    notes: null,
    product_id: productId,
    // A sickness's own medicine ends with it, so "keep taking when sick" has
    // nothing to mean there and is written as 0, not left unasked.
    long_term: episodeId ? 0 : f.long_term ? 1 : 0,
    episode_id: episodeId,
    deleted_at: null,
  });
  await writeDoses(id, f.doses);
  return id;
}

export type MedDetail = {
  med: Medication;
  product: Product | null;
  ingredients: Ingredient[];
  doses: PlanDose[];
  episode: Episode | null;
};

export async function medicineDetail(id: string): Promise<MedDetail | null> {
  const med = (
    await db.query<Medication>('SELECT * FROM medications WHERE id = ? AND profile_id = ?', [
      id,
      activeProfile(),
    ])
  )[0];
  if (!med) return null;
  const product = med.product_id
    ? ((await db.query<Product>('SELECT * FROM med_products WHERE id = ?', [med.product_id]))[0] ?? null)
    : null;
  const doses = await db.query<PlanDose>(
    `SELECT * FROM med_doses
      WHERE profile_id = ? AND medication_id = ? AND deleted_at IS NULL ORDER BY position`,
    [activeProfile(), id],
  );
  const episode = med.episode_id
    ? ((await listEpisodes()).find((e) => e.id === med.episode_id) ?? null)
    : null;
  return {
    med,
    product,
    ingredients: product ? await ingredientsOf(product.id) : [],
    doses: sortByTime(doses),
    episode,
  };
}

/** A saved medicine as a form, for Edit. */
export function draftFromMedicine(d: MedDetail): MedForm {
  return {
    name: d.med.name,
    form: isForm(d.product?.form) ? (d.product!.form as Form) : null,
    strength: d.med.dose_text,
    ingredients: d.ingredients,
    doses: d.doses.map(({ amount, unit, time_of_day, meal }) => ({ amount, unit, time_of_day, meal })),
    long_term: d.med.long_term === 1,
    private: d.product?.private === 1,
  };
}

/**
 * Save from Edit.
 *
 * Doses are replaced rather than updated in place when they change: the old
 * rows are soft-deleted, not rewritten, so a tick made against last week's
 * "1 tablet" still points at a row that says 1 tablet.
 */
export async function editMedicine(id: string, f: MedForm): Promise<void> {
  checkForm(f);
  const before = await medicineDetail(id);
  if (!before) throw new Error('That medicine is no longer here.');
  const productId = await libraryEntryFor(f);
  await db.update('medications', id, {
    name: f.name.trim(),
    dose_text: clean(f.strength),
    product_id: productId,
    long_term: before.med.episode_id ? 0 : f.long_term ? 1 : 0,
  });

  const key = (l: DoseSlot[]) =>
    JSON.stringify(sortByTime(l).map((d) => [d.amount, d.unit, d.time_of_day, d.meal]));
  if (key(before.doses) !== key(f.doses)) {
    for (const d of before.doses) await db.softDelete('med_doses', d.id);
    await writeDoses(id, f.doses);
  }
}

/** Out of the household's search. Anyone taking it keeps it. */
export async function hideFromLibrary(productId: string): Promise<void> {
  await db.update('med_products', productId, { hidden: 1 });
}

export async function setLongTerm(id: string, on: boolean): Promise<void> {
  await db.update('medications', id, { long_term: on ? 1 : 0 });
}

// ------------------------------------------------------------ the day

export type MedsDay = DayPlan<Medication>;

/** What this person takes on `day`, and what has been ticked. */
export async function readMedsDay(day = medDay(), now = new Date()): Promise<MedsDay> {
  const me = activeProfile();
  const [meds, doses, episodes, intake] = await Promise.all([
    db.query<Medication>(
      `SELECT * FROM medications
        WHERE profile_id = ? AND deleted_at IS NULL AND ended_on IS NULL
        ORDER BY name COLLATE NOCASE`,
      [me],
    ),
    db.query<PlanDose>(
      `SELECT * FROM med_doses WHERE profile_id = ? AND deleted_at IS NULL ORDER BY position`,
      [me],
    ),
    listEpisodes(),
    db.query<PlanIntake>(
      `SELECT id, dose_id, status, updated_at FROM intake_events
        WHERE profile_id = ? AND for_day = ? AND deleted_at IS NULL`,
      [me, day],
    ),
  ]);
  return planDay(day, meds, doses, episodes, intake, now);
}

/**
 * Tick a dose, or re-tick it as something else. Any earlier tick for the same
 * dose on the same day is soft-deleted first, so a day never holds two answers
 * for one dose.
 */
export async function markDose(
  p: PlannedDose<Medication>,
  day: string,
  status: 'taken' | 'skipped' = 'taken',
): Promise<string> {
  if (p.eventId) await db.softDelete('intake_events', p.eventId);
  return db.insert('intake_events', {
    medication_id: p.med.id,
    dose_id: p.dose.id,
    for_day: day,
    taken_at: Date.now(),
    status,
    note: null,
    deleted_at: null,
  });
}

// ------------------------------------------------------------ sickness

export async function listEpisodes(): Promise<Episode[]> {
  return db.query<Episode>(
    `SELECT * FROM sick_episodes
      WHERE profile_id = ? AND deleted_at IS NULL
      ORDER BY started_on DESC`,
    [activeProfile()],
  );
}

export async function runningEpisode(day = medDay()): Promise<Episode | null> {
  return (await listEpisodes()).find((e) => isRunning(e, day)) ?? null;
}

/** Regular medicines nobody has said yes or no to "keep taking when sick". */
export async function unaskedLongTerm(): Promise<Medication[]> {
  return db.query<Medication>(
    `SELECT * FROM medications
      WHERE profile_id = ? AND deleted_at IS NULL AND ended_on IS NULL
        AND episode_id IS NULL AND long_term IS NULL
      ORDER BY name COLLATE NOCASE`,
    [activeProfile()],
  );
}

export async function startSickness(
  name: string,
  n: number,
  unit: DurationUnit,
  day = medDay(),
): Promise<string> {
  if (!name.trim()) throw new Error('Name the sickness first.');
  if (await runningEpisode(day)) throw new Error('Sick mode is already on.');
  return db.insert('sick_episodes', {
    name: name.trim(),
    started_on: day,
    last_day: lastDayOf(day, n, unit),
    duration_n: Math.max(1, Math.floor(n)),
    duration_unit: unit,
    recovered_on: null,
    deleted_at: null,
  });
}

/**
 * Longer, from where it was going to end. The duration first picked is left
 * as it was, so history can still say what was planned.
 */
export async function extendSickness(e: Episode, n: number, unit: DurationUnit): Promise<string> {
  const last = lastDayOf(addDays(e.last_day, 1), n, unit);
  await db.update('sick_episodes', e.id, { last_day: last });
  return last;
}

export async function recoverSickness(e: Episode, day = medDay()): Promise<void> {
  await db.update('sick_episodes', e.id, { recovered_on: day });
}

export type PastMed = {
  med: Medication;
  doses: PlanDose[];
  taken: number;
  skipped: number;
};

/** One sickness with everything taken for it, for the history screen. */
export async function sicknessRecord(e: Episode): Promise<PastMed[]> {
  const me = activeProfile();
  const meds = await db.query<Medication>(
    `SELECT * FROM medications
      WHERE profile_id = ? AND episode_id = ? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE`,
    [me, e.id],
  );
  if (meds.length === 0) return [];
  const ids = meds.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');
  // The schedule as it last stood. The counts below are over every tick
  // regardless, so an edit halfway through a course loses nothing from them.
  const doses = await db.query<PlanDose>(
    `SELECT * FROM med_doses
      WHERE profile_id = ? AND medication_id IN (${marks}) AND deleted_at IS NULL
      ORDER BY position`,
    [me, ...ids],
  );
  const counts = await db.query<{ medication_id: string; status: string; n: number }>(
    `SELECT medication_id, status, COUNT(*) AS n FROM intake_events
      WHERE profile_id = ? AND deleted_at IS NULL AND medication_id IN (${marks})
      GROUP BY medication_id, status`,
    [me, ...ids],
  );
  const count = (id: string, s: string) =>
    Number(counts.find((c) => c.medication_id === id && c.status === s)?.n ?? 0);
  return meds.map((med) => ({
    med,
    doses: sortByTime(doses.filter((d) => d.medication_id === med.id)),
    taken: count(med.id, 'taken'),
    skipped: count(med.id, 'skipped'),
  }));
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
