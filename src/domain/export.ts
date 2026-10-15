/**
 * The "For AI" report: a person's records for a period, as one Markdown file
 * they can hand to another AI.
 *
 * All code, no model. Nothing here is written by an AI and nothing here asks
 * one anything; the file is the person's own channel to whichever assistant
 * they choose, under that provider's rules, and no part of what comes back is
 * Mealo's answer.
 *
 * Three things shape it:
 *
 *   The reader is a language model. It adds badly and assumes freely, so the
 *   file does the arithmetic itself (a summary worked out here) and says in
 *   plain words what it does not contain. A model that is not told "the app
 *   does not record age" will pick one.
 *
 *   A day with nothing logged is missing data, not a day without food. That
 *   is said once at the top and again on every such row, because an average
 *   that quietly counts empty days as fasts is the most plausible wrong
 *   conclusion this file could produce.
 *
 *   The name is left out, and so is anything that identifies the device.
 *   Once downloaded the file is outside the app's protection, so it carries
 *   what an answer needs and nothing that is only identity.
 *
 * `buildExport` is pure and is where every sentence of the file is decided;
 * `collectExport` reads the record and shapes it. Keeping them apart is what
 * lets the wording be tested without a database.
 */

import { localDayKey } from './day';
import {
  addDays,
  describeDose,
  describeSchedule,
  scheduleOf,
  tallyOf,
  timeLabel,
} from './doses';
import { burnsSince, goalBurn } from './burn';
import { clock } from './chat';
import { mealsBetween } from './meals';
import { describeMeasure, toMeasure } from './measures';
import { listEpisodes, listStopped, listActive, medicineDetail, readLog, takenBetween } from './medications';
import { counts, type PlanState } from './plan';
import { slot } from './slots';
import { recentSymptoms } from './symptoms';
import { loadTargets, standing, type Targets } from './targets';
import { byDay, goalWeight, weightsSince } from './weight';

export type Scope = 'meals' | 'meds' | 'full';

export const SCOPES: { id: Scope; label: string }[] = [
  { id: 'meals', label: 'Meals' },
  { id: 'meds', label: 'Meds' },
  { id: 'full', label: 'Full' },
];

/** The slider's range, in days. Ninety is a season, and a file a model can still read whole. */
export const MIN_DAYS = 1;
export const MAX_DAYS = 90;
/** Where the slider starts: long enough for a pattern, short enough to read. */
export const DEFAULT_DAYS = 30;

export type ExportItem = {
  name: string;
  quantity: number | null;
  /** Canonical measure id, as logged. */
  unit: string | null;
  grams: number | null;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fibre_g: number | null;
  plan_state: PlanState | null;
};

export type ExportMeal = { day: string; at: number; slot: string; items: ExportItem[] };

export type ExportMedicine = {
  name: string;
  strength: string | null;
  ingredients: string[];
  /** Each dose as the person entered it: "1 tablet, after meal (morning)". */
  doses: string[];
  schedule: string;
  longTerm: boolean;
  startedOn: string | null;
  /** Set when it was stopped; only medicines stopped inside the period are listed. */
  endedOn: string | null;
  /** The sickness it was taken for, if it belongs to one. */
  sickness: string | null;
};

export type ExportDoseDay = {
  day: string;
  taken: number;
  skipped: number;
  missed: number;
  /** Today's doses not yet answered. Never counted as missed. */
  pending: number;
};

export type ExportInput = {
  scope: Scope;
  /** Local ISO days, oldest first, the last one being the day of export. */
  days: string[];
  targets: Targets;
  goalWeightKg: number | null;
  goalBurnKcal: number | null;
  meals: ExportMeal[];
  weights: { day: string; kg: number }[];
  burns: { day: string; kcal: number }[];
  medicines: ExportMedicine[];
  doseDays: ExportDoseDay[];
  notTaken: { day: string; medicine: string; time: string; state: 'skipped' | 'missed' }[];
  /** `at` is when it was logged; `startedAt` when it began, if that was given (v15). */
  symptoms: { at: number; text: string; resolvedAt: number | null; label?: string | null; startedAt?: number | null }[];
  /** Doses ticked taken, with when: for the patterns view and its lookup. */
  intakes?: { at: number; medicine: string }[];
  episodes: { name: string; from: string; to: string; recoveredOn: string | null }[];
};

// ------------------------------------------------------------------ wording

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
/** "Sun 4 Oct". */
export const dateLabel = (iso: string) => {
  const d = dateOf(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
/** "4 Oct 2026": the year only where a date stands alone. */
const fullDate = (iso: string) => {
  const d = dateOf(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Totals = { energy_kcal: number; protein_g: number; fat_g: number; carbs_g: number; fibre_g: number };
const MACROS = ['energy_kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g'] as const;

/** What a day's eaten items add up to, or null for a day with none. */
function totalsOf(meals: ExportMeal[]): Totals | null {
  const eaten = meals.flatMap((m) => m.items).filter((i) => counts(i.plan_state));
  if (eaten.length === 0) return null;
  const t: Totals = { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, fibre_g: 0 };
  for (const i of eaten) for (const k of MACROS) t[k] += i[k] ?? 0;
  return t;
}

/**
 * One food line. The amount as logged, then its weight.
 *
 * "(weighed)" is claimed only when the person logged the amount in a weight
 * unit. Nothing stored on a meal item says how a household measure's weight
 * was arrived at, so a katori is always given as an estimate here, including
 * one whose portion was once put on a scale. Understating what is known is
 * the honest side to err on.
 */
function itemLine(i: ExportItem): string {
  const measure = i.unit ? toMeasure(i.unit) : null;
  const grams = i.grams !== null ? `${whole(i.grams)} g` : null;
  const amount =
    measure?.kind === 'weight'
      ? grams && `${grams} (weighed)`
      : // "2 × piece", not "2 pieces": the measures include "large", "regular"
        // and "whole", which no plural rule survives, and the reader is a model.
        [i.quantity && i.unit ? `${Math.round(i.quantity * 100) / 100} \u00d7 ${describeMeasure(i.unit).toLowerCase()}` : null, grams]
          .filter(Boolean)
          .join(', ');
  const macros =
    i.energy_kcal === null
      ? 'calories unknown'
      : `${whole(i.energy_kcal)} Cal (P ${whole(i.protein_g ?? 0)}, F ${whole(i.fat_g ?? 0)}, C ${whole(i.carbs_g ?? 0)}, Fi ${whole(i.fibre_g ?? 0)})`;
  const state = i.plan_state === 'planned' ? ' [planned, not eaten]' : i.plan_state === 'skipped' ? ' [planned, then skipped]' : '';
  return `${[i.name, amount, macros].filter(Boolean).join(', ')}${state}`;
}

export function fileName(scope: Scope, days: string[]): string {
  return `mealo-${scope}-${days[0]}-to-${days[days.length - 1]}.md`;
}

/** "20 Sep – 10 Oct 2026": what the sheet shows under the slider. */
export function periodLabel(days: string[]): string {
  const a = dateOf(days[0]);
  const b = dateOf(days[days.length - 1]);
  const short = (d: Date, year: boolean) => `${d.getDate()} ${MONTHS[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ''}`;
  if (days.length === 1) return short(b, true);
  return `${short(a, a.getFullYear() !== b.getFullYear())} \u2013 ${short(b, true)}`;
}

/** What a file of this scope holds, for the card under it. */
export function scopeHolds(scope: Scope): string {
  return scope === 'meals' ? 'Meals and targets' : scope === 'meds' ? 'Medicines and doses' : 'Meals, medicines, weight, symptoms';
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A typed request for a report, read by code: "give me my food report for the
 * past 3 weeks" becomes Meals, 21 days.
 *
 * It only fills in the sheet. The person still sees the dates and presses the
 * button, because "past 3 weeks" can be read more than one way and a wrong
 * guess shown is harmless where a wrong guess acted on is a wrong file. No
 * model is asked: the phrases people use for this are few, and a parser that
 * says "I do not know" by returning the default is safer than one that
 * improvises.
 *
 * Returns null when the words are not a request for a report, so that
 * "why does my report look wrong?" still goes to the chat.
 */
export function reportRequest(
  text: string,
  today = localDayKey(Date.now()),
): { scope: Scope; days: number } | null {
  const t = text.toLowerCase();
  if (!/\breports?\b/.test(t)) return null;
  const asks = /\b(give|show|make|generate|create|get|export|download|send|prepare|build|need|want|can i have|i'd like)\b/.test(t);
  if (!asks && t.trim().split(/\s+/).length > 6) return null;

  const scope: Scope = /\b(med|meds|medicine|medicines|medication|medications|dose|doses|tablet|tablets)\b/.test(t)
    ? /\b(food|meal|meals|diet|eating|nutrition)\b/.test(t)
      ? 'full'
      : 'meds'
    : /\b(food|meal|meals|diet|eating|nutrition)\b/.test(t)
      ? 'meals'
      : 'full';

  const clamp = (n: number) => Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(n)));
  const span = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month)s?\b/.exec(t);
  if (span) {
    const n = NUMBER_WORDS[span[1]] ?? Number(span[1]);
    return { scope, days: clamp(n * (span[2] === 'day' ? 1 : span[2] === 'week' ? 7 : 30)) };
  }
  const since = /\bsince\s+(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (since) {
    // Back to the most recent such day, today included in the count; "since
    // Monday" said on a Monday means today alone unless "last" is said.
    const back = (dateOf(today).getDay() - WEEKDAY_NAMES.indexOf(since[2]) + 7) % 7;
    return { scope, days: clamp((back === 0 && since[1] ? 7 : back) + 1) };
  }
  if (/\btoday\b/.test(t)) return { scope, days: 1 };
  if (/\byesterday\b/.test(t)) return { scope, days: 2 };
  if (/\b(this|last|past|previous)\s+week\b|\bweekly\b/.test(t)) return { scope, days: 7 };
  if (/\bfortnight\b/.test(t)) return { scope, days: 14 };
  if (/\b(this|last|past|previous)\s+month\b|\bmonthly\b/.test(t)) return { scope, days: 30 };
  if (/\b(quarter|quarterly)\b/.test(t)) return { scope, days: 90 };
  return { scope, days: DEFAULT_DAYS };
}

// ---------------------------------------------------------------- the file

export function buildExport(x: ExportInput): string {
  const food = x.scope !== 'meds';
  const meds = x.scope !== 'meals';
  const body = x.scope === 'full';
  const first = x.days[0];
  const last = x.days[x.days.length - 1];
  const out: string[] = [];
  const say = (...lines: string[]) => out.push(...lines);

  const mealsByDay = new Map<string, ExportMeal[]>();
  for (const m of x.meals) mealsByDay.set(m.day, [...(mealsByDay.get(m.day) ?? []), m]);
  const dayTotals = new Map(x.days.map((d) => [d, totalsOf(mealsByDay.get(d) ?? [])] as const));
  const logged = x.days.filter((d) => dayTotals.get(d));
  const weightOn = new Map(x.weights.map((w) => [w.day, w.kg]));
  const burnOn = new Map(x.burns.map((b) => [b.day, b.kcal]));
  const dosesOn = new Map(x.doseDays.map((d) => [d.day, d]));

  const what = x.scope === 'meals' ? 'Meals' : x.scope === 'meds' ? 'Medicines' : 'Health records';
  say(`# ${what} export: ${fullDate(first)} to ${fullDate(last)} (${plural(x.days.length, 'day')})`, '');
  say(
    `Exported from Mealo, a personal tracking app, on ${fullDate(last)}. Everything below was entered by the person or worked out by the app from what they entered. No part of it was written by an AI. The person's name is left out on purpose.`,
    '',
  );

  say('## How to read this', '');
  if (food) {
    say(
      '- A day with nothing logged is MISSING DATA, not a day without food. Averages below count logged days only.',
      '- Energy is in Cal (kcal). Protein (P), fat (F), carbs (C) and fibre (Fi) are in grams.',
      '- Each food line gives the amount as logged, then its weight. "(weighed)" means the person typed the weight in grams; every other weight was worked out from a household measure and is an estimate.',
      '- A planned meal that was not ticked as eaten is shown but counted in no total.',
    );
  }
  if (meds) {
    say(
      '- Doses: taken and skipped were ticked by the person. Missed means the dose was due, was never answered, and its day is over. Amounts are exactly as the person entered them.',
      '- A day with no doses listed had none scheduled, or its medicines were paused while a sickness ran.',
    );
  }
  say(`- All dates and times are the person's local time. ${fullDate(last)} is the day of export and may be incomplete.`, '');

  say('## What the app does not record', '');
  say(
    'Age, sex, height, sleep, water, exercise other than a daily burn figure, diagnoses, test results, and anything not listed in this file. Ask the person; do not assume.',
    '',
  );

  // ---- the summary, so the reader does no arithmetic
  say('## Period summary (worked out by the app)', '');
  if (food) {
    say(`- Meals logged on ${logged.length} of ${plural(x.days.length, 'day')}.`);
    if (logged.length > 0) {
      const avg = (k: (typeof MACROS)[number]) => logged.reduce((s, d) => s + dayTotals.get(d)![k], 0) / logged.length;
      say(
        `- Average on logged days: ${whole(avg('energy_kcal'))} Cal, protein ${whole(avg('protein_g'))} g, fat ${whole(avg('fat_g'))} g, carbs ${whole(avg('carbs_g'))} g, fibre ${whole(avg('fibre_g'))} g.`,
      );
      if (x.targets.energy_kcal) {
        const within = logged.filter((d) => standing(dayTotals.get(d)!.energy_kcal, x.targets.energy_kcal, true).standing === 'good');
        say(
          `- Days within the calorie target: ${within.length} of ${logged.length} logged. "Within" is the app's own rule: 76% to 100% of the target.`,
        );
      }
    }
  }
  if (meds) {
    const sum = (k: 'taken' | 'skipped' | 'missed' | 'pending') => x.doseDays.reduce((s, d) => s + d[k], 0);
    const due = sum('taken') + sum('skipped') + sum('missed') + sum('pending');
    say(
      due === 0
        ? '- No doses were scheduled in this period.'
        : `- Doses: ${sum('taken')} taken of ${due} scheduled; ${sum('skipped')} skipped, ${sum('missed')} missed${sum('pending') ? `, ${sum('pending')} still to be answered today` : ''}.`,
    );
  }
  if (body) {
    const w = x.weights;
    say(
      w.length === 0
        ? '- Weight: not recorded in this period.'
        : w.length === 1
          ? `- Weight: one reading, ${w[0].kg.toFixed(1)} kg on ${dateLabel(w[0].day)}.`
          : `- Weight: ${w[0].kg.toFixed(1)} kg on ${dateLabel(w[0].day)}, ${w[w.length - 1].kg.toFixed(1)} kg on ${dateLabel(w[w.length - 1].day)} (${plural(w.length, 'reading')}).`,
    );
  }
  say('');

  if (food) {
    const t = x.targets;
    const set = [
      t.energy_kcal && `Energy ${whole(t.energy_kcal)} Cal`,
      t.protein_g && `Protein ${whole(t.protein_g)} g`,
      t.fat_g && `Fat ${whole(t.fat_g)} g`,
      t.carbs_g && `Carbs ${whole(t.carbs_g)} g`,
      t.fibre_g && `Fibre ${whole(t.fibre_g)} g`,
    ].filter(Boolean);
    say('## Daily targets (set by the person, not by the app)', '');
    say(set.length ? set.join(' | ') : 'None set.');
    if (body && x.goalWeightKg) say(`Goal weight: ${x.goalWeightKg.toFixed(1)} kg.`);
    if (body && x.goalBurnKcal) say(`Daily burn goal: ${whole(x.goalBurnKcal)} Cal.`);
    say('');
  }

  if (meds) {
    say('## Medicines', '');
    if (x.medicines.length === 0) say('None recorded.');
    for (const m of x.medicines) {
      const facts = [
        [m.name, m.strength].filter(Boolean).join(' '),
        m.doses.length ? `Doses: ${m.doses.join('; ')}` : 'No dose times set',
        m.schedule,
        m.longTerm ? 'Long-term' : null,
        m.sickness ? `Taken for: ${m.sickness}` : null,
        m.startedOn ? `Started ${fullDate(m.startedOn)}` : null,
        m.endedOn ? `STOPPED ${fullDate(m.endedOn)}` : null,
        m.ingredients.length ? `Contains: ${m.ingredients.join('; ')}` : null,
      ].filter(Boolean);
      say(`- ${facts.join('. ')}.`);
    }
    say('');
  }

  // ---- one row per day
  say('## Day by day', '');
  const cols = [
    'Date',
    ...(food ? ['Cal', 'Protein', 'Fat', 'Carbs', 'Fibre'] : []),
    ...(body ? ['Weight kg', 'Burn Cal'] : []),
    ...(meds ? ['Doses taken', 'Scheduled', 'Skipped', 'Missed'] : []),
  ];
  say(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
  for (const d of x.days) {
    const t = dayTotals.get(d);
    const dd = dosesOn.get(d);
    const due = dd ? dd.taken + dd.skipped + dd.missed + dd.pending : 0;
    const cells = [
      dateLabel(d),
      ...(food
        ? t
          ? [whole(t.energy_kcal), whole(t.protein_g), whole(t.fat_g), whole(t.carbs_g), whole(t.fibre_g)]
          : ['not logged', '', '', '', '']
        : []),
      ...(body ? [weightOn.has(d) ? weightOn.get(d)!.toFixed(1) : '', burnOn.has(d) ? whole(burnOn.get(d)!) : ''] : []),
      ...(meds ? (due ? [String(dd!.taken), String(due), String(dd!.skipped), String(dd!.missed)] : ['', '', '', '']) : []),
    ];
    say(`| ${cells.join(' | ')} |`);
  }
  say('');

  if (food) {
    say('## Meals', '');
    // Empty days are left out here and said once: ninety days with a few
    // logged would otherwise be mostly headings, and the table above has
    // already marked each of them "not logged".
    say('A day not listed here has nothing logged: missing data, not a day without food.', '');
    for (const d of x.days) {
      const ms = [...(mealsByDay.get(d) ?? [])].sort((a, b) => a.at - b.at);
      if (ms.length === 0) continue;
      say(`### ${dateLabel(d)}`);
      for (const m of ms) say(`- ${m.slot} ${clock(m.at)}: ${m.items.map(itemLine).join('; ')}`);
      say('');
    }
  }

  if (meds) {
    say('## Doses not taken', '');
    if (x.notTaken.length === 0) say('None in this period.');
    for (const n of x.notTaken) say(`- ${dateLabel(n.day)}: ${n.medicine}, ${n.time.toLowerCase()}, ${n.state}`);
    say('');
    say('## Sick periods', '');
    if (x.episodes.length === 0) say('None in this period.');
    for (const e of x.episodes) {
      say(`- ${e.name}: ${dateLabel(e.from)} to ${dateLabel(e.to)}${e.recoveredOn ? `, recovered ${dateLabel(e.recoveredOn)}` : ''}.`);
    }
    say('');
  }

  if (body) {
    say("## Symptoms (in the person's own words)", '');
    if (x.symptoms.length === 0) say('None logged in this period.');
    for (const s of [...x.symptoms].sort((a, b) => a.at - b.at)) {
      const day = dateLabel(localDayKey(s.at));
      const end = s.resolvedAt ? `Resolved ${dateLabel(localDayKey(s.resolvedAt))}.` : 'Still open.';
      say(`- ${day}, ${clock(s.at)}: "${s.text}". ${end}`);
    }
    say('');
  }

  return out.join('\n').trimEnd() + '\n';
}

// --------------------------------------------------------------- the reader

/** The `n` local days ending today, oldest first. */
export function periodDays(n: number, today: string): string[] {
  const span = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(n)));
  return Array.from({ length: span }, (_, i) => addDays(today, i - (span - 1)));
}

/**
 * Read one person's record for the period and shape it for `buildExport`.
 *
 * Everything is read whatever the scope and the builder decides what to
 * print: a Meals file that silently skipped the medicine queries would be a
 * second code path to keep honest, for a saving nobody would notice.
 */
export async function collectExport(scope: Scope, nDays: number, now = new Date()): Promise<ExportInput> {
  const today = localDayKey(now.getTime());
  const days = periodDays(nDays, today);
  const inPeriod = new Set(days);
  const fromMs = dateOf(days[0]).getTime();
  const toMs = dateOf(addDays(today, 1)).getTime();

  const [targets, gw, gb, mealRows, weightRows, burnRows, log, active, stopped, episodes, symptomRows, intakes] = await Promise.all([
    loadTargets(),
    goalWeight(),
    goalBurn(),
    mealsBetween(fromMs, toMs),
    weightsSince(fromMs),
    burnsSince(fromMs),
    readLog(days[0], today, now),
    listActive(),
    listStopped(),
    listEpisodes(),
    recentSymptoms(days.length + 1),
    takenBetween(fromMs, toMs),
  ]);

  const meals: ExportMeal[] = mealRows.map(({ meal, items }) => ({
    day: localDayKey(meal.eaten_at),
    at: meal.eaten_at,
    slot: slot(meal.meal_type).label,
    items: items.map((i) => ({
      name: i.label,
      quantity: i.quantity,
      unit: i.unit,
      grams: i.net_weight_g,
      energy_kcal: i.energy_kcal,
      protein_g: i.protein_g,
      fat_g: i.fat_g,
      carbs_g: i.carbs_g,
      fibre_g: i.fibre_g,
      plan_state: i.plan_state,
    })),
  }));

  // A day's burn is kept as one total. Summed all the same, so that a second
  // row on a day, should one ever exist, adds to the figure instead of
  // quietly replacing it.
  const burnByDay = new Map<string, number>();
  for (const b of burnRows) {
    const d = localDayKey(b.measured_at);
    if (inPeriod.has(d)) burnByDay.set(d, (burnByDay.get(d) ?? 0) + b.kcal);
  }

  // Taken now, plus anything stopped inside the period: a medicine that ended
  // last week is part of what happened last week.
  const listed = [...active, ...stopped.filter((m) => m.ended_on && inPeriod.has(m.ended_on))];
  const medicines: ExportMedicine[] = [];
  for (const m of listed) {
    const d = await medicineDetail(m.id);
    if (!d) continue;
    const live = d.doses.filter((x) => !x.deleted_at);
    const s = live[0] ? scheduleOf(live[0].freq ?? null, live[0].freq_days ?? null, live[0].freq_from ?? null) : null;
    medicines.push({
      name: m.name,
      strength: m.dose_text,
      ingredients: d.ingredients.map((i) => [i.name, i.strength_text].filter(Boolean).join(' ')),
      doses: live.map((x) => `${describeDose(x).replace(' \u00b7 ', ', ')} (${timeLabel(x.time_of_day).toLowerCase()})`),
      schedule: s ? describeSchedule(s) : 'Every day',
      longTerm: m.long_term === 1,
      startedOn: m.started_on,
      endedOn: m.ended_on,
      sickness: d.episode?.name ?? null,
    });
  }

  const doseDays: ExportDoseDay[] = [];
  const notTaken: ExportInput['notTaken'] = [];
  for (const plan of log.plans) {
    doseDays.push({ day: plan.day, ...tallyOf(plan) });
    for (const g of plan.groups) {
      for (const p of g.doses) {
        if (p.state === 'skipped' || p.state === 'missed') {
          notTaken.push({
            day: plan.day,
            medicine: [p.med.name, p.med.dose_text].filter(Boolean).join(' '),
            time: timeLabel(p.dose.time_of_day),
            state: p.state,
          });
        }
      }
    }
  }

  return {
    scope,
    days,
    targets,
    goalWeightKg: gw,
    goalBurnKcal: gb,
    meals,
    weights: byDay(weightRows)
      .map((p) => ({ day: localDayKey(p.t), kg: p.kg }))
      .filter((w) => inPeriod.has(w.day))
      .sort((a, b) => a.day.localeCompare(b.day)),
    burns: [...burnByDay].map(([day, kcal]) => ({ day, kcal })),
    medicines,
    doseDays,
    notTaken,
    symptoms: symptomRows
      .filter((s) => inPeriod.has(localDayKey(s.noted_at)))
      .map((s) => ({ at: s.noted_at, text: s.raw_text, resolvedAt: s.resolved_at, label: s.label, startedAt: s.started_at })),
    intakes,
    episodes: episodes
      .filter((e) => e.started_on <= today && e.last_day >= days[0])
      .map((e) => ({ name: e.name, from: e.started_on, to: e.last_day, recoveredOn: e.recovered_on })),
  };
}
