/**
 * Meals planned ahead: when a logged meal is a plan, and what its circle says.
 *
 * Pure on purpose — no database — so the rules are tested in node with the
 * rest of the arithmetic, and the Day screen, the log flow and the readers
 * of totals all ask the same functions.
 *
 * The rule Upendra set: a meal recorded while or after it is eaten is just
 * logged, with no circle. Only a meal recorded *before* its time is planned —
 * any meal on a later day, or a meal later today ("tonight's dinner, added at
 * lunch"). A planned meal counts toward nothing until it is ticked.
 */

import { slot, type SlotId } from './slots';

/** NULL in the column: logged as eaten, never planned. */
export type PlanState = 'planned' | 'eaten' | 'skipped';

/**
 * How far ahead a meal can be planned, in days after today. His number: a
 * week is as far as anyone's kitchen plans, and a limit keeps the calendar
 * from offering a blank year.
 */
export const DAYS_AHEAD = 7;

/** Whether an item counts toward totals: logged as eaten, or planned and ticked. */
export function counts(state: PlanState | null | undefined): boolean {
  return state == null || state === 'eaten';
}

/** Still a plan — neither ticked nor skipped. */
export function isPlanned(state: PlanState | null | undefined): boolean {
  return state === 'planned';
}

function midnight(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * Whole local days from today to `dayStart`; negative is the past.
 *
 * Rounded rather than divided exactly: across a daylight-saving change a
 * local day is 23 or 25 hours, and a floor would put the Sunday after the
 * change a day early.
 */
export function daysFromToday(dayStart: number, now = new Date()): number {
  return Math.round((dayStart - midnight(now)) / 86_400_000);
}

/** Local midnight of the furthest day a meal can be planned for. */
export function lastPlannableDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + DAYS_AHEAD);
  return d.getTime();
}

/**
 * Whether a meal saved now for this day and slot is a plan.
 *
 * Today, a slot is ahead when it starts after the current hour — the same
 * start hours the log flow already uses to guess the slot, so lunch is
 * planned until noon and dinner until seven. "Something else" is never
 * planned on today (his decision): it is late nights and meals that fit no
 * slot, so it has no time to be ahead of.
 */
export function plansAt(dayStart: number, slotId: SlotId, now = new Date()): boolean {
  const ahead = daysFromToday(dayStart, now);
  if (ahead > 0) return true;
  if (ahead < 0) return false;
  if (slotId === 'other') return false;
  return slot(slotId).from > now.getHours();
}

/**
 * What a tap does, in the order the Meds circle goes: a plan becomes eaten,
 * eaten becomes skipped, skipped goes back to a plan. A meal logged as eaten
 * (NULL) has no circle, so it has no next state.
 */
export function nextPlanState(state: PlanState | null): PlanState | null {
  if (state === 'planned') return 'eaten';
  if (state === 'eaten') return 'skipped';
  if (state === 'skipped') return 'planned';
  return null;
}

/**
 * What the circle draws. 'ahead' is a plan on a later day, which cannot be
 * ticked yet; 'unticked' is a plan whose day is over, drawn amber the way
 * the medicine log draws a missed dose.
 */
export type Circle = 'eaten' | 'skipped' | 'planned' | 'ahead' | 'unticked';

export function circleOf(
  state: PlanState | null,
  dayStart: number,
  now = new Date(),
): Circle | null {
  if (state == null) return null;
  if (state !== 'planned') return state;
  const ahead = daysFromToday(dayStart, now);
  return ahead > 0 ? 'ahead' : ahead < 0 ? 'unticked' : 'planned';
}

/** Whether a tap on this day's circles may write. Not before the day comes. */
export function canTick(dayStart: number, now = new Date()): boolean {
  return daysFromToday(dayStart, now) <= 0;
}

/** The line under the date: "Today", "Tomorrow", "In 3 days", or nothing. */
export function dayLabel(dayStart: number, now = new Date()): string {
  const n = daysFromToday(dayStart, now);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1) return `In ${n} days`;
  return '';
}
