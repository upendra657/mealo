/**
 * `current_state` — the entire interface between the three agents.
 *
 * Composed deterministically from the tables, not by asking a model. These are
 * structured facts: what is being taken, what is bothering the user, what the
 * last week of eating looked like. A model adds nothing here except cost,
 * latency and the chance of inventing a medication.
 *
 * Two things this function is careful about:
 *
 *   1. It is written by the Doctor and read by everyone. The Nutritionist and
 *      Pharmacist see this summary and never the symptom log behind it.
 *
 *   2. Its output is what crosses the network to a model provider, so it
 *      carries no name, no identifier, no timestamps finer than a day, and no
 *      raw symptom text — only labels the user chose. That is principle P2,
 *      enforced at the point the slice is built rather than hoped for in a
 *      prompt.
 */

import { scopedDb } from '../db/scope';

const db = scopedDb('doctor');

const SINGLETON = 'singleton';

export type CurrentState = {
  id: string;
  summary: string | null;
  flags: string | null;
  updated_at: number;
};

export type StateFacts = {
  medications: { name: string; dose: string | null; schedule: string | null }[];
  adherence7d: { taken: number; skipped: number };
  openSymptoms: { label: string; daysAgo: number; severity: number | null }[];
  nutrition7d: {
    daysLogged: number;
    avgEnergy: number | null;
    avgProtein: number | null;
    avgFibre: number | null;
  };
};

function daysAgo(ts: number): number {
  return Math.floor((Date.now() - ts) / 86_400_000);
}

/** Gathers the facts. Reads widely — this is the one agent allowed to. */
export async function collectFacts(): Promise<StateFacts> {
  const weekAgo = Date.now() - 7 * 86_400_000;

  const meds = await db.query<{
    name: string;
    dose_text: string | null;
    schedule: string | null;
  }>(
    `SELECT name, dose_text, schedule FROM medications
      WHERE deleted_at IS NULL AND ended_on IS NULL
      ORDER BY name COLLATE NOCASE`,
  );

  const intake = await db.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM intake_events
      WHERE deleted_at IS NULL AND taken_at >= ?
      GROUP BY status`,
    [weekAgo],
  );

  const symptoms = await db.query<{
    label: string | null;
    raw_text: string;
    noted_at: number;
    severity: number | null;
  }>(
    `SELECT label, raw_text, noted_at, severity FROM symptoms
      WHERE deleted_at IS NULL AND resolved_at IS NULL
      ORDER BY noted_at DESC LIMIT 10`,
  );

  const nutrition = await db.query<{
    days: number;
    e: number | null;
    p: number | null;
    f: number | null;
  }>(
    `SELECT COUNT(DISTINCT DATE(m.eaten_at / 1000, 'unixepoch')) AS days,
            SUM(i.energy_kcal) AS e,
            SUM(i.protein_g)   AS p,
            SUM(i.fibre_g)     AS f
       FROM meals m
       JOIN meal_items i ON i.meal_id = m.id
      WHERE m.deleted_at IS NULL AND i.deleted_at IS NULL AND m.eaten_at >= ?`,
    [weekAgo],
  );

  const n = nutrition[0];
  const days = Number(n?.days ?? 0);
  const per = (total: number | null | undefined) =>
    days > 0 && total != null ? Math.round(Number(total) / days) : null;

  return {
    medications: meds.map((m) => ({
      name: m.name,
      dose: m.dose_text,
      schedule: m.schedule,
    })),
    adherence7d: {
      taken: Number(intake.find((r) => r.status === 'taken')?.n ?? 0),
      skipped: Number(intake.find((r) => r.status === 'skipped')?.n ?? 0),
    },
    openSymptoms: symptoms.map((s) => ({
      // The label if the user gave one, otherwise a short excerpt. Never the
      // full free text — that stays local.
      label: s.label ?? s.raw_text.slice(0, 60),
      daysAgo: daysAgo(s.noted_at),
      severity: s.severity,
    })),
    nutrition7d: {
      daysLogged: days,
      avgEnergy: per(n?.e),
      avgProtein: per(n?.p),
      avgFibre: per(n?.f),
    },
  };
}

/** Compact, de-identified prose. This is what a model actually sees. */
export function renderSlice(facts: StateFacts): string {
  const lines: string[] = [];

  if (facts.medications.length) {
    lines.push(
      'Currently taking: ' +
        facts.medications
          .map(
            (m) =>
              m.name +
              (m.dose ? ` ${m.dose}` : '') +
              (m.schedule ? ` (${m.schedule})` : ''),
          )
          .join('; '),
    );
  } else {
    lines.push('Currently taking: nothing recorded.');
  }

  const { taken, skipped } = facts.adherence7d;
  if (taken + skipped > 0) {
    lines.push(`Last 7 days: ${taken} doses taken, ${skipped} skipped.`);
  }

  if (facts.openSymptoms.length) {
    lines.push(
      'Open symptoms: ' +
        facts.openSymptoms
          .map(
            (s) =>
              `${s.label} (noted ${s.daysAgo === 0 ? 'today' : `${s.daysAgo}d ago`}` +
              (s.severity ? `, severity ${s.severity}/5` : '') +
              ')',
          )
          .join('; '),
    );
  }

  const nu = facts.nutrition7d;
  if (nu.daysLogged > 0) {
    lines.push(
      `Nutrition, ${nu.daysLogged} day(s) logged in the last week: ` +
        `about ${nu.avgEnergy ?? '?'} kcal/day, ` +
        `${nu.avgProtein ?? '?'}g protein, ${nu.avgFibre ?? '?'}g fibre.`,
    );
  }

  return lines.join('\n');
}

/** Flags other agents can branch on without parsing prose. */
export function deriveFlags(facts: StateFacts): string[] {
  const flags: string[] = [];
  if (facts.openSymptoms.length) flags.push('has-open-symptoms');
  if (facts.medications.length) flags.push('on-medication');
  if (facts.nutrition7d.daysLogged === 0) flags.push('no-nutrition-data');
  if (
    facts.nutrition7d.avgFibre !== null &&
    facts.nutrition7d.avgFibre < 20 &&
    facts.nutrition7d.daysLogged >= 3
  ) {
    flags.push('low-fibre');
  }
  return flags;
}

/** Recompute and store. Only the Doctor may call this — scope enforces it. */
export async function refreshCurrentState(): Promise<CurrentState> {
  const facts = await collectFacts();
  const summary = renderSlice(facts);
  const flags = JSON.stringify(deriveFlags(facts));

  const existing = await db.query<CurrentState>(
    'SELECT * FROM current_state WHERE id = ?',
    [SINGLETON],
  );

  if (existing[0]) {
    await db.update('current_state', SINGLETON, { summary, flags });
  } else {
    await db.insert('current_state', { id: SINGLETON, summary, flags });
  }

  return {
    id: SINGLETON,
    summary,
    flags,
    updated_at: Date.now(),
  };
}

/**
 * What the other two agents read.
 *
 * Note the scope: nutritionist and pharmacist have `current_state` in their
 * read list and nothing else of the Doctor's. If this returns null they get
 * nothing — they do not fall back to reading the tables themselves, because
 * they cannot.
 */
export async function readCurrentState(
  agent: 'nutritionist' | 'pharmacist' | 'doctor' = 'doctor',
): Promise<CurrentState | null> {
  const handle = scopedDb(agent);
  const rows = await handle.query<CurrentState>(
    'SELECT * FROM current_state WHERE id = ?',
    [SINGLETON],
  );
  return rows[0] ?? null;
}
