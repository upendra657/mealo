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
 * None of these writes anything, and none ever will. The three "propose"
 * tools are how a model starts an entry: each puts the app's own confirm
 * card on screen, the same card the pills under the chat bar open, filled
 * with the person's words. The card shows exactly what would be saved, and
 * the person presses the button or does not. A model can ask for a card;
 * only a tap can write. That is rule two of the four ("the AI suggests, the
 * person confirms") built so that it cannot be broken from the model's side:
 * there is no tool here that takes a dose amount, a target or a weight, so
 * there is nothing for a model to fill in.
 *
 * Dates go out as whole days and times as a clock time, never a timestamp.
 */

import { clock } from './chat';
import { dateLabel, MAX_DAYS, MIN_DAYS, measureWords, type ExportInput, type Scope } from './export';
import { counts, DAYS_AHEAD } from './plan';
import { humanReport, MACROS } from './report';
import { suggestLabel, SYMPTOM_LABELS, wordsForModel } from './symptomlabels';
import { daysNeeded, LOOK_DAYS, MIN_BOUTS, patternFor, sharedWords, TAG_WORDS, windowForHours, WINDOWS } from './patterns';
import type { ToolDef } from '../llm/types';

const DAYS = {
  type: 'integer',
  minimum: MIN_DAYS,
  maximum: MAX_DAYS,
  description: 'Days back, today included.',
} as const;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/**
 * What the model is told it can ask for. The descriptions are instructions
 * to a model, so they say when to use a tool and what comes back, and
 * nothing about how.
 *
 * Short on purpose (15 Oct 2026). This list goes with every request, and at
 * ~5,900 characters it was the largest fixed cost of a question: about 1,500
 * tokens before the person had said anything, against a free tier of 8,000
 * tokens a minute. What a description must not lose is its limit, kept in
 * every one that has one: a lookup shows what turns up together and not a
 * cause; a card saves nothing until the person presses it; nothing says what
 * to take or how much; the app, not the model, builds a plan or a report.
 */
export const TOOLS: ToolDef[] = [
  fn('thali_summary',
    'Eating over several days: average calories and macros against targets, days logged, top dishes, meal times.',
    { days: DAYS }, ['days']),
  fn('thali_day',
    'Everything eaten on one day, by meal and dish, with amounts and totals.',
    { days_ago: { type: 'integer', minimum: 0, maximum: MAX_DAYS - 1, description: '0 today, 1 yesterday.' } }, ['days_ago']),
  fn('thali_before_symptom',
    'Foods eaten and medicines taken before each bout of a symptom in the last month, against the same hours on other days. Shows what came before it more often, not a cause.',
    { symptom: { type: 'string', description: 'A word or two, e.g. "bloating".' },
      hours: { type: 'integer', minimum: 1, maximum: 720, description: 'Hours to look back: 12, 24, 48, 168 or 720; 24 if unsure.' } }, ['symptom']),
  fn('dawa_adherence',
    'Medicine doses over a period: taken, skipped, missed, due, by medicine and time of day; sick periods.',
    { days: DAYS }, ['days']),
  fn('weight_trend',
    'Weights over a period, the change, the goal weight, and average daily burn.',
    { days: DAYS }, ['days']),
  fn('symptom_log',
    'Symptoms logged over a period, in the person\'s words, open or not.',
    { days: DAYS }, ['days']),
  fn('propose_meal',
    'Show a card to log a meal they say they had, from their own words. Saves nothing until they press it. Add no dishes or amounts they did not say.',
    { text: { type: 'string', description: 'Their words, e.g. "2 roti and 1 katori dal".' } }, ['text']),
  fn('propose_doses',
    'Show the card of doses due, when they say they took or skipped medicines; they tick each. Never say what to take or how much.',
    {}),
  fn('propose_symptom',
    'Show a card to log a symptom they describe, in their words. Saves nothing until they press it.',
    { words: { type: 'string', description: 'Their words.' } }, ['words']),
  fn('propose_plan',
    'Show a card that plans a day, when they ask. The app builds it from meals they logged; do not list dishes or amounts. Saves nothing until they press it.',
    { words: { type: 'string', description: 'Their request, in their words.' },
      days_ahead: { type: 'integer', minimum: 0, maximum: DAYS_AHEAD, description: '0 today, 1 tomorrow.' } }, ['words', 'days_ahead']),
  fn('prepare_report',
    'Open the report sheet, filled in, when they ask for a report or export. The app writes it after they press the button.',
    { scope: { type: 'string', enum: ['meals', 'meds', 'full'] }, days: DAYS,
      for: { type: 'string', enum: ['human', 'ai'], description: '"human" to read, "ai" for another AI.' } }, ['scope', 'days']),
];

export type ToolName =
  | 'thali_summary' | 'thali_day' | 'thali_before_symptom' | 'dawa_adherence' | 'weight_trend' | 'symptom_log'
  | 'propose_meal' | 'propose_doses' | 'propose_symptom' | 'propose_plan' | 'prepare_report';

/** A confirm card a tool asked for: which one, and the words to fill it with. */
export type ProposedCard =
  | { pill: 'meal' | 'doses' | 'symptom'; said: string | null }
  /**
   * A day to plan. The day is the only thing a model supplies besides the
   * person's words; a protein or calorie figure is read by the app from
   * those words, so there is no argument here for a model to put one in.
   */
  | { pill: 'plan'; said: string; ahead: number };

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
        amount: i.quantity != null && i.unit ? `${i.quantity} ${measureWords(i)}` : null,
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

/** Fewer bouts than this and nothing is called a pattern: patterns.ts, MIN_BOUTS. */
export const FEW_EPISODES = MIN_BOUTS;

/** The end of the record's last day, or now if that is still to come: the "now" a pattern is worked out at. */
const recordNow = (x: ExportInput) => {
  const last = x.days[x.days.length - 1];
  const [y, m, d] = last.split('-').map(Number);
  return Math.min(Date.now(), new Date(y, m - 1, d + 1).getTime() - 1);
};

/**
 * What came before a symptom, for the model: the same calculation as the
 * patterns view in Symptom history (patterns.ts), so the chat and the
 * screen give the same numbers. Replaced on 15 Oct 2026 a version that set
 * "entries with a dish before them" against "days the dish was eaten", two
 * different counts, and guessed the label from the words every time.
 *
 * No words of the person's leave here: a bout is its day and time and what
 * came before it. The phone number someone typed into a symptom stays home.
 */
export function thaliBeforeSymptom(x: ExportInput, symptom: string, hours: number, now = recordNow(x)) {
  const want = symptom.trim();
  const label = SYMPTOM_LABELS.find((l) => l.toLowerCase() === want.toLowerCase()) ?? (want ? suggestLabel(want) : null);
  if (!label) {
    return { symptom, bouts_found: 0, caution: 'No symptom label matches that word, so nothing was looked up. Ask which symptom they mean.' };
  }
  const window = windowForHours(hours);
  const p = patternFor(x, label, window, now);
  const when = (t: number) => {
    const d = new Date(t);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day: dateLabel(day), time: clock(t) };
  };
  return {
    symptom: label,
    looked_back: WINDOWS.find((w) => w.id === window)!.label,
    over: `the last ${LOOK_DAYS} days`,
    bouts_found: p.bouts.length,
    bouts: p.bouts.map((b) => ({ ...when(b.began), came_before: b.before.map((e) => ({ [e.kind]: e.name, ...when(e.at) })) })),
    compared_with: { other_days_with_meals: p.foodDays, other_days_with_doses_due: p.medicineDays },
    // Counted apart, likeness named (his call): say which share a word,
    // never add their counts together.
    names_sharing_a_word: [...sharedWords(p.items.map((i) => i.name))].map((word) => ({
      word,
      items: p.items.filter((i) => i.name.toLowerCase().split(/[^a-z\u0900-\u097f]+/).includes(word)).map((i) => i.name),
    })),
    items: p.items.slice(0, 10).map((i) => ({
      [i.kind]: i.name,
      before_bouts: i.before,
      of_bouts: i.of,
      same_hours_on_other_days: i.other,
      of_other_days: i.ofOther,
      finding: TAG_WORDS[i.tag],
    })),
    caution:
      p.bouts.length === 0
        ? 'No bout of this symptom was logged in the last month.'
        : `${p.few ? `Only ${p.bouts.length} ${p.bouts.length === 1 ? 'bout' : 'bouts'}: too few to show a pattern. Report what came before each, nothing more. ` : ''}` +
          'Each item is compared with the same hours on other days of the month. "Stands out" means it came before this symptom more often than on other days, too often to be chance alone; that is all it means. It cannot show that a food or a medicine causes the symptom. Say "came before it more often", never "causes" or "triggers". Each dish is counted on its own: you may point out names that share a word (names_sharing_a_word), never add their counts together. Whether to stop or change any medicine, or to cut out a food, is for their doctor.',
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

export type ToolOutcome = { result: unknown; open?: OpenReport; card?: ProposedCard };

const CARD_SHOWN = 'A card is on screen under your answer. Nothing has been saved: the person saves it by pressing the button on the card, or cancels. Tell them that in one short line and say nothing about what the card will show.';

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
      const hours = Math.min(720, Math.max(1, Math.round(Number(args.hours) || 24)));
      return { result: thaliBeforeSymptom(await read(daysNeeded(windowForHours(hours))), args.symptom, hours) };
    }
    case 'dawa_adherence':
      return { result: dawaAdherence(await read(daysArg(args.days))) };
    case 'weight_trend':
      return { result: weightTrend(await read(daysArg(args.days, 30))) };
    case 'symptom_log':
      return { result: symptomLog(await read(daysArg(args.days, 30))) };
    case 'propose_meal': {
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, 300) : '';
      if (!text) return { result: { error: 'Say what was eaten, in the person\'s words.' } };
      return { result: { shown: true, note: CARD_SHOWN }, card: { pill: 'meal', said: text } };
    }
    case 'propose_doses':
      // No arguments are read. Which doses are due is the app's to say, and
      // which were taken is the person's.
      return { result: { shown: true, note: CARD_SHOWN }, card: { pill: 'doses', said: null } };
    case 'propose_symptom': {
      const words = typeof args.words === 'string' ? args.words.trim().slice(0, 500) : '';
      if (!words) return { result: { error: 'Say what the person is feeling, in their words.' } };
      return { result: { shown: true, note: CARD_SHOWN }, card: { pill: 'symptom', said: words } };
    }
    case 'propose_plan': {
      const words = typeof args.words === 'string' ? args.words.trim().slice(0, 300) : '';
      if (!words) return { result: { error: 'Pass the request in the person\'s words.' } };
      const ahead = Math.min(DAYS_AHEAD, Math.max(0, Math.round(Number(args.days_ahead) || 0)));
      return { result: { shown: true, note: CARD_SHOWN }, card: { pill: 'plan', said: words, ahead } };
    }
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
    case 'propose_meal':
      return 'a meal card';
    case 'propose_doses':
      return 'the doses card';
    case 'propose_symptom':
      return 'a symptom card';
    case 'propose_plan':
      return 'a plan card';
    case 'prepare_report':
      return 'the report sheet';
    default:
      return name;
  }
}
