/**
 * The weekly summary: a week's figures against the week before, and what
 * the app itself counts as better or as something to work on.
 *
 * Approved 10 Oct 2026 as "code finds the observations, the AI writes it";
 * shaped by Upendra on 16 Oct from a mock-up: it rings on Sunday, covers the
 * seven complete days just gone (Sunday to Saturday), lives in Ask Mealo,
 * and steps back through earlier weeks so one can be held against another.
 *
 * Everything here is arithmetic on what was logged. The figures come from
 * the report's own code (`humanReport`) over the same collected record, so
 * a week's protein average here and in a seven-day report of the same days
 * are one figure.
 *
 * Which changes count as better, and which as something to work on, is
 * decided here too, by rules a person can read, and never by a model. A
 * model left to judge "better" will call a lost kilo progress, and that is
 * the kind of praise the app does not give. So some things are shown and
 * never judged at all:
 *
 *   Weight. Shown as readings, never called better or worse, and never sent
 *   to the model. When the loss-rate signal the gates use fires, the cell
 *   gives way to the gate's own words.
 *   The overnight gap. A fact with no goal (his rule for the overnight line).
 *   Symptoms. Counted, with the patterns view's own verdict; what they mean
 *   is a doctor's to say.
 *   Fewer days logged. Not a failing; the reminders' rule against shaming a
 *   missed day holds here too.
 *   Calories under the target. A low logged day is nearly always a meal not
 *   entered (gates.ts), and the app does not push anyone to eat more.
 */

import { addDays, dateOf, isoOf } from './doses';
import { collectExport, dateLabel, type ExportInput } from './export';
import { fastLine } from './fasting';
import { DEFAULT_WINDOW, LOOK_DAYS, MIN_BOUTS, boutsOf, labelOf, patternFor } from './patterns';
import { counts } from './plan';
import { humanReport } from './report';
import { OVER_IS_BAD, standing, type TargetKey } from './targets';
import { lossRate, MAX_LOSS_KG_PER_WEEK } from '../safety/gates';
import type { WeekText } from '../safety/weekly';
import { activeProfile } from '../lib/active-profile';
import { kvGet, kvSet } from '../lib/kv';

const DAY = 86_400_000;

/**
 * How many weeks the arrows reach back, counting the latest as the first.
 * Set by what one read of the record can hold: the report's own limit is 90
 * days, and the oldest week needs the week before it for its comparison and
 * the month before its end for its symptom patterns. Eight weeks back is
 * 62 days, plus 25 before that week begins: 87.
 */
export const WEEKS_BACK = 8;

/** Days before a week begins that its figures read: the week before, and the patterns' month. */
const LEAD_DAYS = Math.max(7, LOOK_DAYS + 2 - 7);

/** The Sunday on or before a day. Weeks run Sunday to Saturday (his, 16 Oct 2026). */
export function weekStartOf(day: string): string {
  return addDays(day, -dateOf(day).getDay());
}

/** The Sunday of the last complete week: on a Sunday, the week that ended yesterday. */
export function latestWeek(today: string): string {
  return addDays(weekStartOf(today), -7);
}

/** The seven days of a week, Sunday first. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** "Sun 11 – Sat 17 Oct", or across a month, "Sun 27 Sep – Sat 3 Oct". */
export function weekLabel(start: string): string {
  const end = addDays(start, 6);
  const [a, b] = [dateLabel(start), dateLabel(end)];
  const sameMonth = dateOf(start).getMonth() === dateOf(end).getMonth();
  return sameMonth ? `${a.replace(/ \S+$/, '')} – ${b}` : `${a} – ${b}`;
}

export type MacroWeek = {
  avg: number | null;
  target: number | null;
  /** Logged days under 76% of the target: the app's own "low", the dial's amber. */
  short: number;
  /** Logged days over a target it is bad to exceed. */
  over: number;
};

export type WeekFigures = {
  start: string;
  days: string[];
  /** Whether anything at all was logged: a meal, a dose answered, a weight, a symptom. */
  any: boolean;
  daysLogged: number;
  macros: Record<'energy_kcal' | 'protein_g' | 'fibre_g', MacroWeek>;
  /** Null when no dose was due. Past days only, so nothing is pending. */
  doses: { taken: number; due: number } | null;
  /** Doses not taken, by time of day, most first. */
  notTaken: { time: string; n: number }[];
  /** The middle overnight gap of the week's nights, and how many nights had one. */
  overnight: { ms: number; nights: number } | null;
  /** The week's last reading, and the last one before the week began. */
  weight: { last: { day: string; kg: number } | null; before: { day: string; kg: number } | null; fastLoss: boolean };
  /** Each symptom's bouts this week, with what stands out before it over the month to the week's end. */
  symptoms: { label: string; bouts: number; few: boolean; standsOut: string[] }[];
  /** For the model: the dishes behind most of the week's calories and protein. */
  topDishes: { calories: string[]; protein: string[] };
};

/** The part of a record that falls in some days, with the rest left as it is. */
function only(x: ExportInput, days: string[]): ExportInput {
  const inWeek = new Set(days);
  return {
    ...x,
    days,
    meals: x.meals.filter((m) => inWeek.has(m.day)),
    doseDays: x.doseDays.filter((d) => inWeek.has(d.day)),
    notTaken: x.notTaken.filter((n) => inWeek.has(n.day)),
    weights: x.weights.filter((w) => inWeek.has(w.day)),
    burns: x.burns.filter((b) => inWeek.has(b.day)),
  };
}

const MACRO_KEYS = ['energy_kcal', 'protein_g', 'fibre_g'] as const;

/**
 * A week's figures, from a record that reaches back far enough before it
 * (`readWeek` reads one that does).
 */
export function weekFigures(x: ExportInput, start: string): WeekFigures {
  const days = weekDays(start);
  const from = dateOf(start).getTime();
  const end = dateOf(addDays(start, 7)).getTime();
  const wk = only(x, days);
  const report = humanReport({ ...wk, scope: 'full' });
  const food = report.food!;
  const meds = report.meds!;

  const eatenOn = (day: string) => wk.meals.filter((m) => m.day === day).flatMap((m) => m.items).filter((i) => counts(i.plan_state));
  const logged = days.filter((d) => eatenOn(d).length > 0);
  const macro = (key: (typeof MACRO_KEYS)[number]): MacroWeek => {
    const target = x.targets[key as TargetKey];
    const avg = food.averages.find((a) => a.key === key)?.avg ?? null;
    let short = 0;
    let over = 0;
    for (const d of logged) {
      const s = standing(eatenOn(d).reduce((t, i) => t + (i[key] ?? 0), 0), target, OVER_IS_BAD[key as TargetKey]).standing;
      if (s === 'low') short++;
      if (s === 'over') over++;
    }
    return { avg, target, short, over };
  };

  const byTime = new Map<string, number>();
  for (const n of wk.notTaken) byTime.set(n.time, (byTime.get(n.time) ?? 0) + 1);

  // Every eaten meal in the record, not only the week's: Sunday's overnight
  // gap began on Saturday night, which belongs to the week before.
  const eatenAt = x.meals.filter((m) => m.items.some((i) => counts(i.plan_state))).map((m) => m.at);
  const gaps = days
    .map((d) => fastLine(dateOf(d).getTime(), eatenAt, end))
    .flatMap((l) => (l?.kind === 'overnight' ? [l.ms] : []))
    .sort((a, b) => a - b);

  const weights = [...x.weights].sort((a, b) => a.day.localeCompare(b.day));
  const inside = weights.filter((w) => w.day >= start && w.day <= days[6]);
  const before = weights.filter((w) => w.day < start);
  // Read at midday: only the day is carried, and the signal measures weeks.
  const rate = lossRate(weights.filter((w) => w.day <= days[6]).map((w) => ({ at: dateOf(w.day).getTime() + DAY / 2, kg: w.kg })), end);

  const labels = [...new Set(x.symptoms.map(labelOf).filter((l): l is string => !!l))];
  const symptoms = labels
    .map((label) => {
      const bouts = boutsOf(x, label, end - 1).filter((t) => t >= from).length;
      if (bouts === 0) return null;
      const p = patternFor(x, label, DEFAULT_WINDOW, end - 1);
      return { label, bouts, few: p.bouts.length < MIN_BOUTS, standsOut: p.items.filter((i) => i.tag === 'stands-out').map((i) => i.name) };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.bouts - a.bouts || a.label.localeCompare(b.label));

  const behind = (key: 'energy_kcal' | 'protein_g') => food.behind.find((b) => b.key === key)?.dishes.map((d) => d.name) ?? [];

  return {
    start,
    days,
    any: logged.length > 0 || meds.taken + meds.skipped > 0 || inside.length > 0 || symptoms.length > 0,
    daysLogged: food.daysLogged,
    macros: { energy_kcal: macro('energy_kcal'), protein_g: macro('protein_g'), fibre_g: macro('fibre_g') },
    doses: meds.due > 0 ? { taken: meds.taken, due: meds.due - meds.pending } : null,
    notTaken: [...byTime].map(([time, n]) => ({ time, n })).sort((a, b) => b.n - a.n || a.time.localeCompare(b.time)),
    overnight: gaps.length ? { ms: gaps[Math.floor((gaps.length - 1) / 2)], nights: gaps.length } : null,
    weight: {
      last: inside.length ? inside[inside.length - 1] : null,
      before: before.length ? before[before.length - 1] : null,
      fastLoss: rate != null && rate > MAX_LOSS_KG_PER_WEEK,
    },
    symptoms,
    topDishes: { calories: behind('energy_kcal'), protein: behind('protein_g') },
  };
}

// ------------------------------------------------------------ observations

export type Observation = { kind: 'better' | 'work_on'; what: string; facts: Record<string, string | number> };

const LABEL: Record<(typeof MACRO_KEYS)[number], string> = { energy_kcal: 'calories', protein_g: 'protein', fibre_g: 'fibre' };
const UNIT: Record<(typeof MACRO_KEYS)[number], string> = { energy_kcal: 'Cal', protein_g: 'g', fibre_g: 'g' };
const r = (n: number) => Math.round(n);

/**
 * What changed for the better against the week before, and what is worth
 * working on, by the rules in the header. In order of weight, so the model,
 * told to keep two of each, keeps the first two.
 *
 * "Better" only ever means nearer the person's own targets, more days
 * logged, or more doses taken. "To work on" only ever states how the week
 * stood against those same targets, or which doses were not taken.
 */
export function observations(cur: WeekFigures, prev: WeekFigures | null): Observation[] {
  const out: Observation[] = [];
  const better = (what: string, facts: Observation['facts']) => out.push({ kind: 'better', what, facts });
  const work = (what: string, facts: Observation['facts']) => out.push({ kind: 'work_on', what, facts });
  const p = prev && prev.any ? prev : null;

  // Better: things that are good to have more of, moving towards their target.
  for (const key of ['protein_g', 'fibre_g'] as const) {
    const c = cur.macros[key];
    const b = p?.macros[key];
    if (c.target && c.avg != null && b?.avg != null && b.avg < c.target && r(c.avg) > r(b.avg)) {
      better(`${LABEL[key]} average went up, towards the target`, { this_week: `${r(c.avg)} ${UNIT[key]}`, week_before: `${r(b.avg)} ${UNIT[key]}`, target: `${c.target} ${UNIT[key]}` });
    }
  }
  const kc = cur.macros.energy_kcal;
  if (p && kc.target && p.macros.energy_kcal.over > 0 && kc.over < p.macros.energy_kcal.over) {
    better('fewer days over the calorie target', { this_week: kc.over, week_before: p.macros.energy_kcal.over });
  }
  if (cur.doses && p?.doses && cur.doses.due > 0 && p.doses.due > 0 && cur.doses.taken / cur.doses.due > p.doses.taken / p.doses.due) {
    better('more of the doses due were taken', { this_week: `${cur.doses.taken} of ${cur.doses.due}`, week_before: `${p.doses.taken} of ${p.doses.due}` });
  }
  if (p && cur.daysLogged > p.daysLogged) {
    better('meals logged on more days', { this_week: `${cur.daysLogged} of 7`, week_before: `${p.daysLogged} of 7` });
  }

  // To work on: how the week stood against the person's own targets.
  // Half the logged days or more, so that one odd day is not a thing to work on.
  const half = Math.max(2, Math.ceil(cur.daysLogged / 2));
  for (const key of ['protein_g', 'fibre_g'] as const) {
    const c = cur.macros[key];
    if (c.target && c.short >= half) {
      work(`${LABEL[key]} short of the target on most logged days`, { days_short: c.short, logged_days: cur.daysLogged, target: `${c.target} ${UNIT[key]}`, rule: 'short means under 76% of the target' });
    }
  }
  if (kc.target && kc.over >= 2) {
    work('over the calorie target on some days', { days_over: kc.over, logged_days: cur.daysLogged, target: `${kc.target} Cal` });
  }
  if (cur.doses && cur.notTaken.length) {
    const top = cur.notTaken[0];
    work('doses not taken', { not_taken: cur.doses.due - cur.doses.taken, of_due: cur.doses.due, most_often_at: top.time.toLowerCase(), times_at_that_time: top.n });
  }
  return out;
}

/**
 * What the model is given: the two weeks' meal and medicine figures and the
 * app's observations. No weight, no overnight gap, no symptom: see the
 * header for why each is shown and never judged.
 */
export function weekData(cur: WeekFigures, prev: WeekFigures | null) {
  const fig = (w: WeekFigures) => ({
    days_with_meals_logged: `${w.daysLogged} of 7`,
    average_on_logged_days: Object.fromEntries(
      MACRO_KEYS.map((k) => [LABEL[k], w.macros[k].avg == null ? null : { average: `${r(w.macros[k].avg!)} ${UNIT[k]}`, target: w.macros[k].target ? `${w.macros[k].target} ${UNIT[k]}` : null }]),
    ),
    doses: w.doses ? `${w.doses.taken} taken of ${w.doses.due} due` : 'none due',
  });
  return {
    week: weekLabel(cur.start),
    this_week: fig(cur),
    week_before: prev?.any ? { week: weekLabel(prev.start), ...fig(prev) } : 'nothing logged',
    dishes_behind_most_calories: cur.topDishes.calories,
    dishes_behind_most_protein: cur.topDishes.protein,
    better: observations(cur, prev).filter((o) => o.kind === 'better').map((o) => ({ what: o.what, ...o.facts })),
    to_work_on: observations(cur, prev).filter((o) => o.kind === 'work_on').map((o) => ({ what: o.what, ...o.facts })),
  };
}

// ----------------------------------------------------------------- reading

/**
 * A week and the week before it, read from the record. Only as far back as
 * that week needs: the record is read again for each week the arrows reach.
 */
export async function readWeek(start: string, now = new Date()): Promise<{ cur: WeekFigures; prev: WeekFigures }> {
  const today = isoOf(now);
  const from = addDays(start, -LEAD_DAYS);
  const n = Math.round((dateOf(today).getTime() - dateOf(from).getTime()) / DAY) + 1;
  const x = await collectExport('full', n, now);
  return { cur: weekFigures(x, start), prev: weekFigures(x, addDays(start, -7)) };
}

// ----------------------------------------------------------------- keeping

/**
 * What Ask Mealo wrote for a week, kept so that the week costs one request
 * and not one per opening. In IndexedDB beside the reminder list, not in
 * the database: it is a reading of the record, not part of it, and the
 * figures under it are worked out again each time from the record itself.
 *
 * `basis` is the data the words were written from. When it no longer
 * matches (a meal logged late for that week), the screen says so and offers
 * to write it again, rather than showing a summary of a week that has since
 * changed under it.
 */
export type KeptWeek = WeekText & { at: number; basis: string };

const keyOf = (what: string, start?: string) => `week.${what}.${activeProfile()}${start ? `.${start}` : ''}`;

export const basisOf = (data: ReturnType<typeof weekData>) => JSON.stringify(data);

export async function keptWeek(start: string): Promise<KeptWeek | null> {
  return (await kvGet<KeptWeek>(keyOf('text', start))) ?? null;
}

export async function keepWeek(start: string, text: WeekText, basis: string): Promise<KeptWeek> {
  const kept = { ...text, at: Date.now(), basis };
  await kvSet(keyOf('text', start), kept);
  return kept;
}

/**
 * Whether Ask Mealo writes the latest week by itself when Ask Mealo is
 * opened. Off until chosen, per person: it spends a request on a key.
 */
export async function writesItself(): Promise<boolean> {
  return (await kvGet<boolean>(keyOf('auto'))) === true;
}

export async function setWritesItself(on: boolean): Promise<void> {
  await kvSet(keyOf('auto'), on);
}

/**
 * The latest week Ask Mealo has put in the thread. A week arrives once, on
 * the first opening after it ends; after that it is a tap on "Your week".
 */
export async function weekShown(): Promise<string | null> {
  return (await kvGet<string>(keyOf('shown'))) ?? null;
}

export async function markWeekShown(start: string): Promise<void> {
  await kvSet(keyOf('shown'), start);
}
