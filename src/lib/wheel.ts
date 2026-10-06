/**
 * What a scroll wheel should report when it comes to rest, if anything.
 *
 * Pure, so the rule can be tested without a browser. Only a scroll someone
 * made is a choice. When the wheel moves itself — to follow a value typed in
 * the box, or to park on row 0 because its value is not on the list — the row
 * it rests on was picked by the code, and reporting it would be the app
 * choosing for them.
 *
 * The bug this exists for: the Meds form's day-of-month wheel stays mounted
 * inside its closed sheet. Fed a weekday (Sunday is 0, which 1-31 lacks), it
 * parked itself at "1st", reported 1, and turned a weekly medicine monthly.
 * The first fix refused any value not on the list, which would also have
 * stopped a person scrolling the meal flow's measure wheel off a unit that has
 * since left the vocabulary. Who moved it is the real question.
 */
export function settledValue<T>(
  values: readonly T[],
  value: T,
  scrollTop: number,
  row: number,
  byUser: boolean,
): T | null {
  if (!byUser || values.length === 0) return null;
  const i = Math.max(0, Math.min(values.length - 1, Math.round(scrollTop / row)));
  return values[i] !== value ? values[i] : null;
}
