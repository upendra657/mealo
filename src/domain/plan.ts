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
 * When a meal logged for a day is stamped as having happened, unless the
 * person says (the "Eaten at" box, 15 Oct 2026).
 *
 * Today gets the real clock so the order of meals is right. A past day
 * gets its slot's usual hour (USUAL_HOUR), his choice the same night: still
 * a placeholder, since pretending to know that Tuesday's lunch was at 13:42
 * is inventing a fact, but one inside the slot, so breakfast sorts before
 * dinner and the overnight line is not measured to a noon nobody ate at. A
 * day ahead is a plan, and keeps noon until its tick gives it a time; noon
 * is kept too for "Something else" and a call with no slot.
 *
 * Here, and not in the log screen where it began, because a plan made in
 * Ask Mealo has to land at the same moment one made in Track meals would.
 */
export function stampFor(dayStart: number, now = new Date(), slotId?: SlotId): number {
  if (dayStart === midnight(now)) return now.getTime();
  const past = dayStart < midnight(now);
  return dayStart + ((past && slotId && USUAL_HOUR[slotId]) || 12) * 3_600_000;
}

/**
 * Until this hour the day has begun on the calendar and not yet for anyone
 * in it. Breakfast's start hour is 0, so a breakfast planned at 01:30 for
 * the morning ahead saved as eaten at 01:30 (15 Oct 2026). Moving that hour
 * to 5 would have mended breakfast alone; the night is named instead
 * because "tomorrow", said to Ask Mealo before five, turns on the same
 * boundary. Five is his choice: late enough to cover planning after
 * midnight, early enough that a meal logged at dawn is one being eaten.
 */
export const NIGHT_ENDS = 5;

/**
 * Whether a meal saved now for this day and slot is a plan.
 *
 * Today, a slot is ahead when it starts after the current hour — the same
 * start hours the log flow already uses to guess the slot, so lunch is
 * planned until noon and dinner until seven — and every slot is ahead
 * before NIGHT_ENDS. "Something else" is never planned on today (his
 * decision): it is late nights and meals that fit no slot, so it has no
 * time to be ahead of.
 */
export function plansAt(dayStart: number, slotId: SlotId, now = new Date()): boolean {
  const ahead = daysFromToday(dayStart, now);
  if (ahead > 0) return true;
  if (ahead < 0) return false;
  if (slotId === 'other') return false;
  return Math.max(slot(slotId).from, NIGHT_ENDS) > now.getHours();
}

/**
 * When each slot is usually eaten, for a plan ticked after its day. Inside
 * the window `guessSlot` gives each slot, so the hour reads as that meal.
 * "Something else" has none: it is the slot for what fits no time.
 */
export const USUAL_HOUR: Partial<Record<SlotId, number>> = {
  breakfast: 8,
  msnack: 11,
  lunch: 13,
  esnack: 17,
  dinner: 20,
};

/**
 * When a plan ticked eaten was eaten, as best the app can say.
 *
 * A plan keeps the moment it was made (01:30 for every slot of a day
 * planned after midnight) or noon for a later day, and the lookup of what
 * was eaten before a symptom reads that time. His rule, 15 Oct 2026: ticked
 * on its own day, it was eaten about now; ticked on a later day, at its
 * slot's usual hour. Null leaves the time as it is.
 */
export function tickStamp(dayStart: number, slotId: SlotId, now = new Date()): number | null {
  const n = daysFromToday(dayStart, now);
  if (n > 0) return null;
  if (n === 0) return now.getTime();
  const h = USUAL_HOUR[slotId];
  if (h === undefined) return null;
  const d = new Date(dayStart);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
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
