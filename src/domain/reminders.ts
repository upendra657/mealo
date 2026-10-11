/**
 * Reminders: what rings, when, and what it says. The pure part.
 *
 * Two things ring. Doses that are due, at a clock time the person chose for
 * each part of the day, and one nudge in the evening on a day with no meal
 * logged. A weekly summary was the third thing asked for and is not here:
 * it needs a model, and the model's key lives in the browser, so nothing can
 * write it while the app is closed. It waits to be designed.
 *
 * How it reaches a phone, and what the relay is told (only the times), is in
 * `remindersync.ts` and `worker/index.ts`. This file decides the list.
 *
 * Tone, Upendra's decision of 10 Oct 2026: plain reminders. No guilt, no
 * streaks, nothing about calories, nothing that shames a missed day. A
 * reminder states what is due and stops.
 */

import { addDays, dateOf, DAY_TURNS_AT_HOUR, isoOf, timeLabel, TIMES, type TimeOfDay } from './doses';

/** How far ahead rings are set each time the app is used. */
export const SCHEDULE_DAYS = 14;

export type ReminderSettings = {
  /** Turned on, on this phone, by a tap. */
  on: boolean;
  /**
   * Whose medicines and meals ring here. Reminders belong to one person per
   * phone, the one who turned them on: a phone rings in one pocket, and two
   * people's doses arriving on it would put one person's medicine on the
   * other's lock screen.
   */
  profileId: string | null;
  doses: boolean;
  meals: boolean;
  /**
   * Whether a medicine's name is written on the lock screen. Off unless
   * chosen: a lock screen is read by whoever picks the phone up.
   */
  names: boolean;
  /** When each part of the day rings, "HH:MM". */
  times: Record<TimeOfDay, string>;
  /** When the meal nudge rings. */
  mealTime: string;
};

/**
 * Where the clock times start, for the person to change.
 *
 * A dose in Mealo is due in a part of the day, not at a time: nobody entered
 * "08:00", so the app has no time of theirs to ring at and these are only a
 * place to begin. Each sits inside its part as `partOfDay` draws it (morning
 * to noon, afternoon to five, evening to eight, then night), so that when a
 * reminder rings, the dose it is for shows as due on the Meds screen and not
 * as "later". They are not advice about when to take anything.
 */
export const DEFAULT_REMINDERS: ReminderSettings = {
  on: false,
  profileId: null,
  doses: true,
  meals: true,
  names: false,
  times: { morning: '08:00', afternoon: '13:00', evening: '18:00', night: '21:30' },
  mealTime: '21:00',
};

export type Ring = {
  /** ms since the epoch, on the minute. */
  at: number;
  kind: 'doses' | 'meals';
  title: string;
  body: string;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isClock = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/**
 * A clock time on a Meds day, as a moment.
 *
 * The Meds day runs until 3 am, so "night" set to 00:30 belongs to the
 * calendar day after the one it is the night of.
 */
export function clockOn(day: string, hhmm: string): number {
  const m = HHMM.exec(hhmm);
  const d = dateOf(day);
  if (!m) return d.getTime();
  const h = Number(m[1]);
  if (h < DAY_TURNS_AT_HOUR) d.setDate(d.getDate() + 1);
  d.setHours(h, Number(m[2]), 0, 0);
  return d.getTime();
}

/** What is still to be taken at one time of one day: the medicines' names, nothing else. */
export type DueGroup = { time: TimeOfDay; names: string[] };

/**
 * One ring per part of the day that has something still to take.
 *
 * The words never carry an amount, with names on or off. "Metformin" on a
 * lock screen is a choice the person made; "Metformin 500 mg, 2 tablets"
 * would be the app stating a dose where anyone can read it, and no dose is
 * ever stated by the app (R2).
 */
export function doseRings(days: { day: string; groups: DueGroup[] }[], s: ReminderSettings, now: number): Ring[] {
  if (!s.doses) return [];
  const out: Ring[] = [];
  for (const { day, groups } of days) {
    for (const g of groups) {
      if (g.names.length === 0) continue;
      const at = clockOn(day, s.times[g.time]);
      if (at <= now) continue;
      const names = [...new Set(g.names)];
      out.push({
        at,
        kind: 'doses',
        title: `${timeLabel(g.time)} medicines`,
        body: s.names ? names.join(', ') : names.length === 1 ? 'One to take. Open Mealo to tick it.' : `${names.length} to take. Open Mealo to tick them.`,
      });
    }
  }
  return out;
}

/**
 * The evening nudge, on each day that has no meal logged.
 *
 * `loggedDays` are the days already holding an eaten meal. Today drops out
 * of the list the moment one is logged, and the next schedule sent to the
 * relay no longer has its ring. A day ahead always rings until it has a
 * meal, which is right: if the app is not opened that day, nothing was
 * logged.
 */
export function mealRings(days: string[], loggedDays: ReadonlySet<string>, s: ReminderSettings, now: number): Ring[] {
  if (!s.meals) return [];
  const out: Ring[] = [];
  for (const day of days) {
    if (loggedDays.has(day)) continue;
    const at = clockOn(day, s.mealTime);
    if (at <= now) continue;
    out.push({ at, kind: 'meals', title: 'Today’s meals', body: 'Nothing logged yet today. Open Mealo to add them.' });
  }
  return out;
}

/** The days a schedule covers, today's Meds day first. */
export function scheduleDays(today: string, n = SCHEDULE_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}

/** Soonest first, and no more than the relay will hold for one browser. */
export function inOrder(rings: Ring[], cap = 100): Ring[] {
  return [...rings].sort((a, b) => a.at - b.at).slice(0, cap);
}

/** The settings as stored, with anything missing or malformed put back to its default. */
export function readSettings(stored: unknown): ReminderSettings {
  const v = (stored && typeof stored === 'object' ? stored : {}) as Partial<ReminderSettings>;
  const times = { ...DEFAULT_REMINDERS.times };
  for (const t of TIMES) {
    const got = (v.times as Record<string, unknown> | undefined)?.[t.id];
    if (isClock(got)) times[t.id] = got;
  }
  return {
    on: v.on === true,
    profileId: typeof v.profileId === 'string' ? v.profileId : null,
    doses: v.doses !== false,
    meals: v.meals !== false,
    names: v.names === true,
    times,
    mealTime: isClock(v.mealTime) ? v.mealTime : DEFAULT_REMINDERS.mealTime,
  };
}

/** Today as the nudge counts it: the calendar day, not the Meds day. */
export const calendarDay = (now: Date) => isoOf(now);
