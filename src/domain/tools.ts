/**
 * Thali and Dawa as tools: what Ask Mealo can look up.
 *
 * Ask Mealo is the only AI in the app. Thali (meals) and Dawa (medicines)
 * are plain code, and this file is where a model reaches them: it names a
 * tool and a period, the code here reads the record and returns figures.
 * They were never made models themselves, for three reasons that still
 * hold. Every extra model step costs the person tokens on their own key. A
 * model summarising medicines can invent one. And the model on top would
 * be reading another model's summary instead of the figures, so mistakes
 * would stack.
 *
 * Every tool is a view over the same collected record the reports are built
 * from (`collectExport`), so a figure in a chat answer, in the report to
 * read and in the file for another AI is the same figure. Each reads one
 * person: the reads underneath go through the scoped database, which
 * refuses any query on a body table that does not name a profile.
 *
 * None of these writes anything. Tools that write (log a meal, tick a dose)
 * come with their confirmation card, and not before.
 *
 * Dates go out as whole days and times as a clock time, never a timestamp.
 */

import { clock } from './chat';
import { dateLabel, MAX_DAYS, MIN_DAYS, type ExportInput, type Scope } from './export';
import { describeMeasure } from './measures';
import { counts } from './plan';
import { humanReport, MACROS } from './report';
import { suggestLabel, wordsForModel } from './symptomlabels';
import type { ToolDef } from '../llm/types';

const DAYS = {
  type: 'integer',
  minimum: MIN_DAYS,
  maximum: MAX_DAYS,
  description: `How many days back from today, today included (${MIN_DAYS} to ${MAX_DAYS}).`,
} as const;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/**
 * What the model is told it can ask for. The descriptions are instructions
 * to a model, so they say when to use a tool and what comes back, and
 * nothing about how.
 */
export const TOOLS: ToolDef[] = [
  fn('thali_summary',
    'Meals over a period, worked out by the app: average calories, protein, carbs, fats and fibre on logged days against the targets, days logged, days within the calorie target, the dishes that supplied the most of each, and when meals are eaten. Use for any question about eating over more than one day.',
    { days: DAYS }, ['days']),
  fn('thali_day',
    'Everything eaten on one day, meal by meal and dish by dish, with amounts and the five figures for each dish, and the day\'s totals. Use for a question about a particular day.',
    { days_ago: { type: 'integer', minimum: 0, maximum: MAX_DAYS - 1, description: '0 for today, 1 for yesterday, and so on.' } }, ['days_ago']),
  fn('thali_before_symptom',
    'What was eaten in the hours before each time a symptom was logged, and how often each dish turns up before it compared with how often it is eaten at all. Use when asked what might go with a symptom. It shows what turns up together; it cannot show a cause.',
    { symptom: { type: 'string', description: 'The symptom, in a word or two, e.g. "bloating".' },
      hours: { type: 'integer', minimum: 1, maximum: 72, description: 'How many hours before each entry to look at. 24 if unsure.' },
      days: DAYS }, ['symptom']),
  fn('dawa_adherence',
    'Medicine doses over a period, worked out by the app: taken, skipped, missed and still due; doses not taken by medicine and time of day; the medicines of the period; sick periods. Use for any question about doses or medicines taken.',
    { days: DAYS }, ['days']),
  fn('weight_trend',
    'Logged weights over a period, the change between the first and last reading, the goal weight, and average daily burn against its goal.',
    { days: DAYS }, ['days']),
  fn('symptom_log',
    'Symptoms logged over a period, each with its day and whether it is still open, in the person\'s own words.',
    { days: DAYS }, ['days']),
  fn('prepare_report',
    'Open the report sheet for the person, already filled in. Use when they ask for a report or an export. You do not write the report: the app does, after the person has seen the dates and pressed the button.',
    { scope: { type: 'string', enum: ['meals', 'meds', 'full'] }, days: DAYS,
      for: { type: 'string', enum: ['human', 'ai'], description: '"human" for a report to read, "ai" for a file to give another AI.' } }, ['scope', 'days']),
];

export type ToolName = 'thali_summary' | 'thali_day' | 'thali_before_symptom' | 'dawa_adherence' | 'weight_trend' | 'symptom_log' | 'prepare_report';

/** A request to open the report sheet: the one thing a tool asks the screen to do. */
export type OpenReport = { scope: Scope; days: number; aud: 'human' | 'ai' };

const whole = (n: number | null) => (n == null ? null : Math.round(n));
const tenth = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** A whole number of days inside the slider's range, whatever was sent. */
export function daysArg(value: unknown, fallback = 7): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(n))) : fallback;
}

const NOTE_LOGGED = 'Averages are over days with something logged. A day with nothing logged is missing data, not a day without food, and a logged day may be only partly logged.';

export function thaliSummary(x: ExportInput) {
  const f = humanReport({ ...x, scope: 'meals' }).food!;
  return {
    period: `${dateLabel(x.days[0])} to ${dateLabel(x.days[x.days.length - 1])}`,
    days_in_period: x.days.length,
    days_logged: f.daysLogged,
    average_per_logged_day: Object.fromEntries(f.averages.map((a) => [a.label.toLowerCase(), { average: whole(a.avg), target: a.target, unit: a.unit }])),
    days_within_calorie_target: f.withinTarget ? { days: f.withinTarget.days, of_logged_days: f.withinTarget.of, rule: '76% to 100% of the calorie target' } : null,
    top_dishes_by_share: Object.fromEntries(f.behind.map((b) => [b.label.toLowerCase(), b.dishes.map((d) => ({ dish: d.name, percent_of_period_total: Math.round(d.share * 100) }))])),
    meals_by_slot: f.slots.map((s) => ({ slot: s.slot, meals: s.meals, average_calories: whole(s.avgKcal) })),
    planned_not_eaten: f.planned + f.skipped,
    note: NOTE_LOGGED,
  };
}

export function thaliDay(x: ExportInput, day: string) {
  const meals = x.meals.filter((m) => m.day === day).sort((a, b) => a.at - b.at);
  const eaten = meals.flatMap((m) => m.items).filter((i) => counts(i.plan_state));
  const total = (k: (typeof MACROS)[number]['key']) => whole(eaten.reduce((s, i) => s + (i[k] ?? 0), 0));
  return {
    day: dateLabel(day),
    meals: meals.map((m) => ({
      slot: m.slot,
      time: clock(m.at),
      dishes: m.items.map((i) => ({
        dish: i.name,
        amount: i.quantity != null && i.unit ? `${i.quantity} ${describeMeasure(i.unit).toLowerCase()}` : null,
        grams: whole(i.grams),
        calories: whole(i.energy_kcal),
        protein_g: tenth(i.protein_g),
        carbs_g: tenth(i.carbs_g),
        fat_g: tenth(i.fat_g),
        fibre_g: tenth(i.fibre_g),
        ...(counts(i.plan_state) ? {} : { not_eaten: i.plan_state }),
      })),
    })),
    totals_eaten: eaten.length
      ? { calories: total('energy_kcal'), protein_g: total('protein_g'), carbs_g: total('carbs_g'), fat_g: total('fat_g'), fibre_g: total('fibre_g') }
      : null,
    targets: { calories: x.targets.energy_kcal, protein_g: x.targets.protein_g, carbs_g: x.targets.carbs_g, fat_g: x.targets.fat_g, fibre_g: x.targets.fibre_g },
    note: meals.length === 0 ? 'Nothing is logged for this day. That is missing data, not a day without food.' : 'A dish marked not_eaten was planned and is counted in no total.',
  };
}

/**
 * Below this many entries of a symptom, what precedes it is an anecdote.
 * The app's own number: with fewer than five, one dish eaten most days will
 * "precede" every one of them. The tool says so instead of leaving it out,
 * because the person asked and a small sample honestly labelled is still
 * theirs to see.
 */
export const FEW_EPISODES = 5;

export function thaliBeforeSymptom(x: ExportInput, symptom: string, hours: number) {
  const want = symptom.trim().toLowerCase();
  const label = suggestLabel(want);
  const episodes = x.symptoms
    .filter((s) => want !== '' && (s.text.toLowerCase().includes(want) || (label != null && suggestLabel(s.text) === label)))
    .sort((a, b) => a.at - b.at);
  const eatenMeals = x.meals.map((m) => ({ ...m, items: m.items.filter((i) => counts(i.plan_state)) })).filter((m) => m.items.length > 0);
  const window = hours * 3_600_000;

  const before = episodes.map((e) => {
    const dishes = [...new Set(eatenMeals.filter((m) => m.at <= e.at && m.at > e.at - window).flatMap((m) => m.items.map((i) => i.name)))];
    const d = new Date(e.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day: dateLabel(day), time: clock(e.at), words: wordsForModel(e.text), dishes_in_the_hours_before: dishes };
  });

  const loggedDays = new Set(eatenMeals.map((m) => m.day));
  const daysWith = (dish: string) => new Set(eatenMeals.filter((m) => m.items.some((i) => i.name === dish)).map((m) => m.day)).size;
  const tally = new Map<string, number>();
  for (const b of before) for (const dish of b.dishes_in_the_hours_before) tally.set(dish, (tally.get(dish) ?? 0) + 1);
  const seen = [...tally]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([dish, n]) => ({ dish, before_entries: n, of_entries: before.length, eaten_on_logged_days: daysWith(dish), of_logged_days: loggedDays.size }));

  return {
    symptom,
    hours_before: hours,
    entries_found: before.length,
    entries: before,
    dishes_seen_before: seen,
    caution:
      before.length === 0
        ? 'No entry of this symptom was found in the period.'
        : `${before.length < FEW_EPISODES ? `Only ${before.length} ${before.length === 1 ? 'entry' : 'entries'}: too few to show a pattern. ` : ''}` +
          'This shows what was eaten before the symptom, and how often those dishes are eaten anyway. It can show that things turn up together. It cannot show that one causes the other. Say "these show up together", never "this causes it".',
  };
}

export function dawaAdherence(x: ExportInput) {
  const m = humanReport({ ...x, scope: 'meds' }).meds!;
  return {
    period: `${dateLabel(x.days[0])} to ${dateLabel(x.days[x.days.length - 1])}`,
    doses: { scheduled: m.due, taken: m.taken, skipped: m.skipped, missed: m.missed, still_due_today: m.pending },
    not_taken: m.notTaken.map((n) => ({ medicine: n.medicine, time_of_day: n.time, skipped: n.skipped, missed: n.missed })),
    // The amounts are the person's own entries, quoted. Never a suggestion.
    medicines: x.medicines.map((med) => ({
      name: med.strength ? `${med.name} ${med.strength}` : med.name,
      as_entered_by_the_person: med.doses,
      schedule: med.schedule,
      ...(med.endedOn ? { stopped_on: dateLabel(med.endedOn) } : {}),
      ...(med.sickness ? { taken_for: med.sickness } : {}),
    })),
    sick_periods: m.episodes.map((e) => ({ name: e.name, from: dateLabel(e.from), to: dateLabel(e.to) })),
    note: 'Missed means a dose was due, was never answered, and its day is over. Whether to take, skip or change any medicine is for the prescriber, never for you.',
  };
}

export function weightTrend(x: ExportInput) {
  const b = humanReport({ ...x, scope: 'full' }).body!;
  return {
    readings: b.weights.map((w) => ({ day: w.label, kg: tenth(w.kg) })),
    change_first_to_last_kg: tenth(b.change),
    goal_weight_kg: b.goalWeightKg,
    average_daily_burn: b.avgBurn == null ? null : { calories: whole(b.avgBurn), over_days: b.burnDays, goal: b.goalBurnKcal },
    note: b.weights.length < 2 ? 'Fewer than two readings: no change can be worked out.' : 'The days between readings are not measured. Setting a weight or calorie goal is not for you to do.',
  };
}

export function symptomLog(x: ExportInput) {
  const b = humanReport({ ...x, scope: 'full' }).body!;
  return {
    entries: b.symptoms.map((s) => ({ day: s.day, words: wordsForModel(s.text), state: s.resolved ? 'resolved' : 'still open' })),
    note: b.symptoms.length === 0 ? 'No symptoms were logged in this period.' : 'These are the person\'s own words. What a symptom means is for a doctor to say.',
  };
}

export type ToolOutcome = { result: unknown; open?: OpenReport };

/**
 * Run one tool call.
 *
 * `read` is how the record is reached, passed in so that the screen can
 * read each period once per question however many tools ask for it, and so
 * that the tests can hand in a record without a database.
 *
 * An unknown name or a bad argument gets an answer the model can read, not
 * an exception: a thrown error would end the person's turn over a model's
 * typo.
 */
export async function runTool(name: string, args: Record<string, unknown>, read: (days: number) => Promise<ExportInput>): Promise<ToolOutcome> {
  switch (name) {
    case 'thali_summary':
      return { result: thaliSummary(await read(daysArg(args.days))) };
    case 'thali_day': {
      const ago = Math.min(MAX_DAYS - 1, Math.max(0, Math.round(Number(args.days_ago) || 0)));
      const x = await read(ago + 1);
      return { result: thaliDay(x, x.days[0]) };
    }
    case 'thali_before_symptom': {
      if (typeof args.symptom !== 'string' || !args.symptom.trim()) return { result: { error: 'Say which symptom, in a word or two.' } };
      const hours = Math.min(72, Math.max(1, Math.round(Number(args.hours) || 24)));
      return { result: thaliBeforeSymptom(await read(daysArg(args.days, 30)), args.symptom, hours) };
    }
    case 'dawa_adherence':
      return { result: dawaAdherence(await read(daysArg(args.days))) };
    case 'weight_trend':
      return { result: weightTrend(await read(daysArg(args.days, 30))) };
    case 'symptom_log':
      return { result: symptomLog(await read(daysArg(args.days, 30))) };
    case 'prepare_report': {
      const scope: Scope = args.scope === 'meals' || args.scope === 'meds' ? args.scope : 'full';
      const days = daysArg(args.days, 30);
      const aud = args.for === 'ai' ? 'ai' : 'human';
      return {
        result: { opened: true, note: 'The report sheet is open, filled in. The person sees the real dates and presses the button themselves. Tell them so in one line; do not describe the report.' },
        open: { scope, days, aud },
      };
    }
    default:
      return { result: { error: `There is no tool called "${name}".` } };
  }
}

/** The figure-and-target pairs in a summary, for the numbers check's arithmetic. */
export function pairsOf(result: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.average === 'number' && typeof o.target === 'number') out.push([o.average, o.target]);
    if (typeof o.calories === 'number' && typeof o.goal === 'number') out.push([o.calories, o.goal]);
    if (typeof o.taken === 'number' && typeof o.scheduled === 'number') out.push([o.taken, o.scheduled]);
    if (typeof o.days === 'number' && typeof o.of_logged_days === 'number') out.push([o.days, o.of_logged_days]);
    if (o.totals_eaten && o.targets && typeof o.totals_eaten === 'object' && typeof o.targets === 'object') {
      const t = o.totals_eaten as Record<string, unknown>;
      const g = o.targets as Record<string, unknown>;
      for (const k of Object.keys(t)) if (typeof t[k] === 'number' && typeof g[k] === 'number') out.push([t[k] as number, g[k] as number]);
    }
    Object.values(o).forEach(walk);
  };
  walk(result);
  return out;
}

/** A tool call in a few words, for the line that says what was looked up. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const days = (fallback: number) => {
    const n = daysArg(args.days, fallback);
    return `${n} ${n === 1 ? 'day' : 'days'}`;
  };
  switch (name) {
    case 'thali_summary':
      return `Thali: meals, ${days(7)}`;
    case 'thali_day': {
      const ago = Math.max(0, Math.round(Number(args.days_ago) || 0));
      return `Thali: meals, ${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`}`;
    }
    case 'thali_before_symptom':
      return `Thali: meals before ${typeof args.symptom === 'string' ? args.symptom.trim().toLowerCase().slice(0, 24) : 'a symptom'}`;
    case 'dawa_adherence':
      return `Dawa: doses, ${days(7)}`;
    case 'weight_trend':
      return `weight, ${days(30)}`;
    case 'symptom_log':
      return `symptoms, ${days(30)}`;
    case 'prepare_report':
      return 'the report sheet';
    default:
      return name;
  }
}
