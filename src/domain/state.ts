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
import { activeProfile } from '../lib/active-profile';

const db = scopedDb('doctor');

export type CurrentState = {
  id: string;
  summary: string | null;
  flags: string | null;
  updated_at: number;
};

export type MealSummary = {
  type: string;
  time: string;
  items: string[];
  energy: number;
  protein: number;
  fat: number;
  carbs: number;
  fibre: number;
};

export type StateFacts = {
  medications: { name: string; dose: string | null; schedule: string | null }[];
  adherence7d: { taken: number; skipped: number };
  /** Per-medication status today — "taken at 08:15" beats "9 doses this week". */
  dosesToday: { name: string; status: string; time: string }[];
  /** What was actually eaten today, by name. Averages cannot answer
      "was my dinner alright" — only the dishes can. */
  mealsToday: MealSummary[];
  todayTotals: { energy: number; protein: number; fat: number; carbs: number; fibre: number };
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
  const me = activeProfile();
  const weekAgo = Date.now() - 7 * 86_400_000;

  const meds = await db.query<{
    name: string;
    dose_text: string | null;
    schedule: string | null;
  }>(
    `SELECT name, dose_text, schedule FROM medications
      WHERE profile_id = ? AND deleted_at IS NULL AND ended_on IS NULL
      ORDER BY name COLLATE NOCASE`,
    [me],
  );

  const intake = await db.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM intake_events
      WHERE profile_id = ? AND deleted_at IS NULL AND taken_at >= ?
      GROUP BY status`,
    [me, weekAgo],
  );

  const symptoms = await db.query<{
    label: string | null;
    raw_text: string;
    noted_at: number;
    severity: number | null;
  }>(
    `SELECT label, raw_text, noted_at, severity FROM symptoms
      WHERE profile_id = ? AND deleted_at IS NULL AND resolved_at IS NULL
      ORDER BY noted_at DESC LIMIT 10`,
    [me],
  );

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayMs = dayStart.getTime();

  const dosesToday = await db.query<{
    name: string;
    status: string;
    taken_at: number;
  }>(
    `SELECT m.name, e.status, e.taken_at
       FROM intake_events e
       JOIN medications m ON m.id = e.medication_id
      WHERE e.profile_id = ? AND e.deleted_at IS NULL AND e.taken_at >= ?
      ORDER BY e.taken_at`,
    [me, todayMs],
  );

  const mealRows = await db.query<{
    id: string;
    meal_type: string | null;
    eaten_at: number;
  }>(
    `SELECT id, meal_type, eaten_at FROM meals
      WHERE profile_id = ? AND deleted_at IS NULL AND eaten_at >= ?
      ORDER BY eaten_at`,
    [me, todayMs],
  );

  const itemRows = mealRows.length
    ? await db.query<{
        meal_id: string;
        label: string;
        quantity: number | null;
        unit: string | null;
        net_weight_g: number | null;
        energy_kcal: number | null;
        protein_g: number | null;
        fat_g: number | null;
        carbs_g: number | null;
        fibre_g: number | null;
      }>(
        `SELECT meal_id, label, quantity, unit, net_weight_g,
                energy_kcal, protein_g, fat_g, carbs_g, fibre_g
           FROM meal_items
          WHERE profile_id = ? AND deleted_at IS NULL
            AND meal_id IN (${mealRows.map(() => '?').join(',')})`,
        [me, ...mealRows.map((m) => m.id)],
      )
    : [];

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const mealsToday = mealRows.map((m) => {
    const mine = itemRows.filter((i) => i.meal_id === m.id);
    const sum = (k: 'energy_kcal' | 'protein_g' | 'fat_g' | 'carbs_g' | 'fibre_g') =>
      r1(mine.reduce((a, i) => a + (i[k] ?? 0), 0));
    return {
      type: m.meal_type ?? 'meal',
      time: new Date(m.eaten_at).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      // Portion first, then the weight it worked out to. "1 katori dal (150g)"
      // lets the model reason about the amount; "dal" does not.
      items: mine.map((i) => {
        const amount =
          i.quantity && i.unit ? `${i.quantity} ${i.unit} ` : '';
        const weight = i.net_weight_g ? ` (${Math.round(i.net_weight_g)}g)` : '';
        return `${amount}${i.label}${weight}`;
      }),
      energy: sum('energy_kcal'),
      protein: sum('protein_g'),
      fat: sum('fat_g'),
      carbs: sum('carbs_g'),
      fibre: sum('fibre_g'),
    };
  });

  const todayTotals = mealsToday.reduce(
    (a, m) => ({
      energy: r1(a.energy + m.energy),
      protein: r1(a.protein + m.protein),
      fat: r1(a.fat + m.fat),
      carbs: r1(a.carbs + m.carbs),
      fibre: r1(a.fibre + m.fibre),
    }),
    { energy: 0, protein: 0, fat: 0, carbs: 0, fibre: 0 },
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
      WHERE m.profile_id = ? AND m.deleted_at IS NULL
        AND i.deleted_at IS NULL AND m.eaten_at >= ?`,
    [me, weekAgo],
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
    dosesToday: dosesToday.map((d) => ({
      name: d.name,
      status: d.status,
      time: new Date(d.taken_at).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    })),
    mealsToday,
    todayTotals,
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

  if (facts.dosesToday.length) {
    lines.push(
      'Doses today: ' +
        facts.dosesToday
          .map((d) => `${d.name} ${d.status} at ${d.time}`)
          .join('; '),
    );
  } else if (facts.medications.length) {
    lines.push('Doses today: nothing logged yet.');
  }

  const { taken, skipped } = facts.adherence7d;
  if (taken + skipped > 0) {
    lines.push(`Last 7 days: ${taken} doses taken, ${skipped} skipped.`);
  }

  if (facts.mealsToday.length) {
    lines.push('Eaten today:');
    for (const m of facts.mealsToday) {
      lines.push(
        `  ${m.type} ${m.time} — ${m.items.join(', ') || 'unspecified'} ` +
          `(${m.energy} kcal, protein ${m.protein}g, fat ${m.fat}g, ` +
          `carbs ${m.carbs}g, fibre ${m.fibre}g)`,
      );
    }
    const t = facts.todayTotals;
    lines.push(
      `  Day so far: ${t.energy} kcal, protein ${t.protein}g, fat ${t.fat}g, ` +
        `carbs ${t.carbs}g, fibre ${t.fibre}g.`,
    );
  } else {
    lines.push('Eaten today: nothing logged yet.');
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

/**
 * Recompute and store. Only the Doctor may call this — scope enforces it.
 *
 * One row per profile, keyed by the profile id. `current_state` is the only
 * thing the other two agents can read about the person's condition, so mixing
 * two people into one row would put her symptoms in front of his Nutritionist.
 */
export async function refreshCurrentState(): Promise<CurrentState> {
  const me = activeProfile();
  const facts = await collectFacts();
  const summary = renderSlice(facts);
  const flags = JSON.stringify(deriveFlags(facts));

  const existing = await db.query<CurrentState>(
    'SELECT * FROM current_state WHERE id = ?',
    [me],
  );

  if (existing[0]) {
    await db.update('current_state', me, { summary, flags });
  } else {
    await db.insert('current_state', { id: me, summary, flags });
  }

  return { id: me, summary, flags, updated_at: Date.now() };
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
    [activeProfile()],
  );
  return rows[0] ?? null;
}
