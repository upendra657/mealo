/**
 * Medicines as a schedule: the vocabulary, the wording, the sickness calendar,
 * and the one function that decides what is due on a day.
 *
 * Pure — no database, no clock read anywhere but the defaults. The Meds screen
 * and the Doctor's slice both need "what is this person taking today", and
 * they read through different agents' handles, so the deciding is done here
 * once and both feed it their own rows. Two copies of that rule would drift,
 * and the drift would be the Doctor thinking a finished course of antibiotics
 * is still running.
 */

import { normalise } from './foods';

// ------------------------------------------------------------ vocabulary

/**
 * The lists the v10 schema deliberately does not CHECK. Enforced here instead,
 * so a fifth form is an edit to this file rather than a table rebuild.
 */
export const FORMS = [
  { id: 'tablet', label: 'Tablet / Capsule' },
  { id: 'syrup', label: 'Syrup' },
  { id: 'powder', label: 'Powder' },
  // Eye drops and eye gel, counted the same way: a gel is applied as drops
  // are, and nobody asked the app to tell them apart.
  { id: 'drops', label: 'Drops / Gel' },
] as const;
export type Form = (typeof FORMS)[number]['id'];

export type Unit = 'tablet' | 'ml' | 'scoop' | 'g' | 'drop';

/** What an amount is counted in, by form. Powder is measured either way. */
export const UNITS_FOR: Record<Form, readonly Unit[]> = {
  tablet: ['tablet'],
  syrup: ['ml'],
  powder: ['scoop', 'g'],
  drops: ['drop'],
};

/**
 * Times of day, in the order a day runs. `slot` borrows the meal selector's
 * marks, so a morning dose and breakfast wear the same rising sun.
 */
export const TIMES = [
  { id: 'morning', label: 'Morning', slot: 'breakfast' },
  { id: 'afternoon', label: 'Afternoon', slot: 'lunch' },
  { id: 'evening', label: 'Evening', slot: 'esnack' },
  { id: 'night', label: 'Night', slot: 'dinner' },
] as const;
export type TimeOfDay = (typeof TIMES)[number]['id'];

export const MEALS = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
] as const;
export type Meal = (typeof MEALS)[number]['id'];

export const MAX_DOSES = 4;

export function isForm(v: unknown): v is Form {
  return FORMS.some((f) => f.id === v);
}
export function isTime(v: unknown): v is TimeOfDay {
  return TIMES.some((t) => t.id === v);
}

export type DoseSlot = {
  amount: number | null;
  unit: Unit | null;
  time_of_day: TimeOfDay | null;
  meal: Meal | null;
};

// --------------------------------------------------------------- wording

/** "1 tablet", "2 tablets", "0.5 tablet", "10 ml", "1 scoop", "5 g", "2 drops". */
export function fmtAmount(amount: number | null, unit: Unit | null): string {
  if (amount === null || !Number.isFinite(amount)) return 'amount not set';
  const n = String(Math.round(amount * 100) / 100);
  if (!unit) return n;
  // Counted units take a plural above one: "1.5 tablets" reads fine, but
  // "0.5 tablets" does not. ml and g are measures and never change.
  const counted = unit === 'tablet' || unit === 'scoop' || unit === 'drop';
  const word = counted && amount > 1 ? `${unit}s` : unit;
  return `${n} ${word}`;
}

/** "1 tablet · after meal". */
export function describeDose(d: DoseSlot): string {
  const parts = [fmtAmount(d.amount, d.unit)];
  if (d.meal) parts.push(`${d.meal} meal`);
  return parts.join(' · ');
}

export function timeLabel(t: TimeOfDay | null): string {
  return TIMES.find((x) => x.id === t)?.label ?? 'Any time';
}

// ------------------------------------------------------------ the library

/**
 * The library's merge key: name and strength.
 *
 * `normalise` is the food matcher's normaliser and deliberately the same one
 * (see foods.ts on why a second copy is how the parser once drifted). The one
 * thing added first is a space between a number and its unit, because
 * normalise keeps "650mg" as one token and "650 mg" as two, and both phones
 * have to arrive at the same slug for the same strip whichever way it was
 * typed.
 */
export function medSlug(name: string, strength: string | null): string {
  const s = (strength ?? '').replace(/(\d)\s*([a-zμµ])/gi, '$1 $2');
  return normalise(`${name} ${s}`);
}

/**
 * The rows for a new "times a day".
 *
 * Rows already filled in are kept — changing 2 to 3 must not wipe the amounts
 * you typed — and a new row takes the first time of day nobody has yet, in the
 * order people actually add them: morning, then night, then the middle of the
 * day. Rows come back sorted by the time they are taken.
 *
 * A new row's amount is always empty, never 1 and never a copy of the row
 * above. Either would be the app filling in a dose: the first build did both,
 * and a cough syrup was saved as "1 ml" that nobody typed. The unit and the
 * meal carry over, because those are how the medicine is taken, not how much.
 */
export function resizeDoses(slots: DoseSlot[], n: number, form: Form | null): DoseSlot[] {
  const count = Math.max(1, Math.min(MAX_DOSES, n));
  const kept = slots.slice(0, count);
  const order: TimeOfDay[] = ['morning', 'night', 'afternoon', 'evening'];
  const first = kept[0];
  while (kept.length < count) {
    const used = new Set(kept.map((s) => s.time_of_day));
    kept.push({
      amount: null,
      unit: first?.unit ?? (form ? UNITS_FOR[form][0] : null),
      time_of_day: order.find((t) => !used.has(t)) ?? null,
      meal: first?.meal ?? 'after',
    });
  }
  return sortByTime(kept);
}

/** Every dose has an amount someone chose. Save waits for this. */
export function amountsSet(slots: DoseSlot[]): boolean {
  return slots.every((d) => d.amount !== null && Number.isFinite(d.amount) && d.amount > 0);
}

export function sortByTime<T extends { time_of_day: TimeOfDay | null }>(rows: T[]): T[] {
  const rank = (t: TimeOfDay | null) => (t ? TIMES.findIndex((x) => x.id === t) : TIMES.length);
  return [...rows].sort((a, b) => rank(a.time_of_day) - rank(b.time_of_day));
}

/** A unit that fits the form, keeping the current one when it already does. */
export function unitFor(form: Form, current: Unit | null): Unit {
  return current && UNITS_FOR[form].includes(current) ? current : UNITS_FOR[form][0];
}

// --------------------------------------------------------- local calendar

/**
 * Everything below works on local calendar dates as "YYYY-MM-DD" strings and
 * builds Dates from their parts, never by adding milliseconds. A day is not
 * always 86,400,000 ms long, and `DATE(ts/1000,'unixepoch')` is UTC — at
 * +05:30 that files 2 am under the wrong day.
 */
export function isoOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

/** "4 Oct", or "4 Oct 2025" when it is not this year. */
export function fmtDay(iso: string, now = new Date()): string {
  const d = dateOf(iso);
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Whole days from a to b. Through UTC so a clock change cannot shave an hour. */
export function daysFrom(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * The day the Meds screen is about.
 *
 * Until 3 am it is still yesterday. The night dose taken at 00:30 belongs to
 * the night before — that is what intake_events.for_day exists to record — and
 * a screen that had already rolled over would have no way to tick it. Three,
 * not midnight, because a late night is the case this is for; not later,
 * because someone up at five for a morning dose means that morning.
 */
export const DAY_TURNS_AT_HOUR = 3;
export function medDay(now = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < DAY_TURNS_AT_HOUR) d.setDate(d.getDate() - 1);
  return isoOf(d);
}

/**
 * Which part of the day it is, for telling a due dose from a later one.
 * Midday and five are where most prescriptions' "afternoon" and "evening"
 * begin; before DAY_TURNS_AT_HOUR it is still the night before.
 */
export function partOfDay(now = new Date()): TimeOfDay {
  const h = now.getHours();
  if (h < DAY_TURNS_AT_HOUR) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  return 'night';
}

// --------------------------------------------------------------- sickness

export const DURATION_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/**
 * The last day of a sickness that starts on `start` and lasts n units,
 * inclusive: 7 days from Tuesday the 6th ends on Monday the 12th.
 *
 * Months and years are calendar ones. Where the target month is shorter, the
 * date is held at its last day, so a month from 31 January runs to the end of
 * February rather than spilling into March the way Date.setMonth would.
 */
export function lastDayOf(start: string, n: number, unit: DurationUnit): string {
  const count = Math.max(1, Math.floor(n));
  if (unit === 'days') return addDays(start, count - 1);
  if (unit === 'weeks') return addDays(start, count * 7 - 1);
  const [y, m, d] = start.split('-').map(Number);
  const months = unit === 'months' ? count : count * 12;
  const target = new Date(y, m - 1 + months, 1);
  const lastOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastOfTarget));
  // The day before the same date next period: 6 Oct + 1 month ends 5 Nov.
  target.setDate(target.getDate() - 1);
  return isoOf(target);
}

export type Episode = {
  id: string;
  name: string;
  started_on: string;
  last_day: string;
  duration_n: number;
  duration_unit: string;
  recovered_on: string | null;
};

/**
 * Running on `day`: begun, not past its last day, not recovered. Recovered
 * means from that day on — "Recovered" this morning ends sick mode now, not at
 * midnight.
 */
export function isRunning(e: Episode, day: string): boolean {
  if (e.started_on > day || e.last_day < day) return false;
  return e.recovered_on === null || e.recovered_on > day;
}

/**
 * The last day it was actually running: the day before recovery, or the last
 * day planned. Never before it began — recovering on the first day still
 * counts that day, because whatever was taken that morning was taken for it.
 */
export function endedOn(e: Episode): string {
  if (!e.recovered_on || e.recovered_on > e.last_day) return e.last_day;
  const before = addDays(e.recovered_on, -1);
  return before < e.started_on ? e.started_on : before;
}

/** "Day 3 of 7" and "5 days to go" — today counts as one still to go. */
export function progress(e: Episode, day: string) {
  const total = daysFrom(e.started_on, e.last_day) + 1;
  const dayN = Math.min(total, Math.max(1, daysFrom(e.started_on, day) + 1));
  const toGo = Math.max(0, daysFrom(day, e.last_day) + 1);
  return { day: dayN, total, toGo };
}

/** How long it planned and how long it ran, for history. */
export function lengths(e: Episode) {
  const planned = daysFrom(e.started_on, lastDayOf(e.started_on, e.duration_n,
    (DURATION_UNITS as readonly string[]).includes(e.duration_unit)
      ? (e.duration_unit as DurationUnit)
      : 'days')) + 1;
  const lasted = daysFrom(e.started_on, endedOn(e)) + 1;
  return { planned, lasted };
}

export function durationLabel(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit.replace(/s$/, '') : unit}`;
}

// ------------------------------------------------------- the day's plan

export type PlanMed = {
  id: string;
  name: string;
  dose_text: string | null;
  schedule: string | null;
  long_term: number | null;
  episode_id: string | null;
};

export type PlanDose = DoseSlot & { id: string; medication_id: string; position: number };

export type PlanIntake = {
  id: string;
  dose_id: string | null;
  status: 'taken' | 'skipped';
  updated_at: number;
};

export type DoseState = 'taken' | 'skipped' | 'due' | 'later';

export type PlannedDose<M extends PlanMed> = {
  med: M;
  dose: PlanDose;
  state: DoseState;
  /** The tick behind a taken or skipped state, so it can be undone. */
  eventId: string | null;
};

export type DayPlan<M extends PlanMed> = {
  day: string;
  /** The sickness running on this day, if any. */
  episode: Episode | null;
  /** Doses to take, grouped by time of day, in day order. */
  groups: { time: TimeOfDay; doses: PlannedDose<M>[] }[];
  /** Regular medicines set aside while a sickness runs. */
  paused: { med: M; doses: PlanDose[] }[];
  /** Medicines from before dose slots, shown as written until given some. */
  unscheduled: M[];
};

/**
 * What one person takes on one day.
 *
 * `meds` are medicines not stopped; `episodes` every sickness on record. A
 * medicine belonging to a sickness is due only while that sickness runs — once
 * it ends, the course is history, not something still being taken. A regular
 * medicine is set aside while any sickness runs unless it is long-term; one
 * nobody was ever asked about (long_term NULL) is set aside too, which is why
 * the start-sick sheet asks before it starts.
 *
 * `now` only decides due versus later, and only when `day` is today.
 */
export function planDay<M extends PlanMed>(
  day: string,
  meds: M[],
  doses: PlanDose[],
  episodes: Episode[],
  intake: PlanIntake[],
  now = new Date(),
): DayPlan<M> {
  const episode = episodes.find((e) => isRunning(e, day)) ?? null;

  const byMed = new Map<string, PlanDose[]>();
  for (const d of doses) {
    byMed.set(d.medication_id, [...(byMed.get(d.medication_id) ?? []), d]);
  }

  // The newest tick per dose wins, so undo-then-redo reads as the redo.
  const tick = new Map<string, PlanIntake>();
  for (const e of intake) {
    if (!e.dose_id) continue;
    const prev = tick.get(e.dose_id);
    if (!prev || e.updated_at >= prev.updated_at) tick.set(e.dose_id, e);
  }

  const isToday = day === medDay(now);
  const nowRank = TIMES.findIndex((t) => t.id === partOfDay(now));
  const stateOf = (d: PlanDose): DoseState => {
    const t = tick.get(d.id);
    if (t) return t.status;
    // A past day has nothing still to come; a future one has nothing due yet.
    if (!isToday) return day < medDay(now) ? 'due' : 'later';
    const rank = d.time_of_day ? TIMES.findIndex((x) => x.id === d.time_of_day) : 0;
    return rank <= nowRank ? 'due' : 'later';
  };

  const taking: PlannedDose<M>[] = [];
  const paused: DayPlan<M>['paused'] = [];
  const unscheduled: M[] = [];

  for (const med of meds) {
    if (med.episode_id !== null) {
      if (med.episode_id !== episode?.id) continue;
    } else if (episode && med.long_term !== 1) {
      paused.push({ med, doses: sortByTime(byMed.get(med.id) ?? []) });
      continue;
    }

    const mine = byMed.get(med.id) ?? [];
    if (mine.length === 0) {
      unscheduled.push(med);
      continue;
    }
    for (const dose of mine) {
      taking.push({ med, dose, state: stateOf(dose), eventId: tick.get(dose.id)?.id ?? null });
    }
  }

  const groups = TIMES.map((t) => ({
    time: t.id as TimeOfDay,
    doses: taking
      .filter((p) => (p.dose.time_of_day ?? 'morning') === t.id)
      .sort((a, b) => a.med.name.localeCompare(b.med.name) || a.dose.position - b.dose.position),
  })).filter((g) => g.doses.length > 0);

  return { day, episode, groups, paused, unscheduled };
}
