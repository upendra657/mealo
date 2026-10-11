/**
 * The chat thread as the Ask Mealo screen draws it.
 *
 * Pure, so the two things the screen must never get wrong are tested without
 * a browser: which lines carry the "AI" tag, and which do not.
 *
 * Every AI-written line is tagged, and a line the app wrote itself is not.
 * The stop message is the case that matters. It is written by
 * safety/redflags.ts before any model is called, and it is stored in
 * `messages` as an assistant row because that table's CHECK knows no other
 * role for it. Read back naively it would wear the AI tag, on the one message
 * that most needs to be believed as coming from the app.
 */

import { triage } from '../safety/redflags';

export type Entry =
  /** What the person asked. */
  | { kind: 'asked'; text: string; at: number }
  /** What the model said, after the dose filter. Tagged AI. */
  | { kind: 'answer'; text: string; at: number }
  /** A red-flag stop. Written by code; no model saw the message. */
  | { kind: 'stop'; text: string; at: number };

type Stored = { role: string; content: string; created_at: number };

/**
 * Stored rows to entries.
 *
 * A reply is a stop only if the message before it trips triage today AND the
 * reply is exactly what triage says. The second half is what keeps a pattern
 * added later from relabelling an old model answer as the app's own words.
 * The cost is the other way round: reword a red flag's advice and stops saved
 * under the old wording read back as AI answers. That is the safer mistake of
 * the two, and a reason not to reword advice casually.
 */
export function entriesFrom(stored: Stored[]): Entry[] {
  const out: Entry[] = [];
  stored.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ kind: 'asked', text: m.content, at: m.created_at });
      return;
    }
    if (m.role !== 'assistant') return;
    const before = stored[i - 1];
    const flagged = before?.role === 'user' ? triage(before.content) : null;
    const stop = !!flagged && flagged.triggered && flagged.message === m.content;
    out.push({ kind: stop ? 'stop' : 'answer', text: m.content, at: m.created_at });
  });
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Today · 2:14 pm", "Yesterday · 9:05 am", "8 Oct · 2:14 pm".
 *
 * Built by hand rather than with toLocaleString: the same phone showed
 * "Oct 12" in one browser and "12 Oct" in another, and a label over every
 * question should not change with the engine.
 */
export function entryTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const midnight = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  // Rounded, because a day with a clock change is 23 or 25 hours long.
  const daysAgo = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  const day =
    daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} · ${clock(at)}`;
}

/** "2:14 pm". */
export function clock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * The questions offered on an empty chat.
 *
 * They are there to show what the thing is for, so each one must be
 * answerable from what the model is actually given today: the slice in
 * domain/state.ts (today's meals and doses, the last seven days). A question
 * it cannot answer from the record would teach the wrong scope on the first
 * screen anyone sees.
 */
export const TRY_ASKING = [
  'How has my week looked?',
  'What have I eaten today?',
  'Which doses are left today?',
] as const;

// ------------------------------------------------------------- the pills
//
// "Log a meal", "Tick my doses" and "Log a symptom" under the chat bar. None
// of them calls a model: each asks one question, shows a card of exactly what
// would be written, and writes only on a tap. The wording lives here so the
// card, its button and the receipt it leaves behind cannot drift apart.

export type Pill = 'meal' | 'doses' | 'symptom';

/** Each pill's name, and the one question it asks. */
export const PILLS: Record<Pill, { label: string; asks: string }> = {
  meal: { label: 'Log a meal', asks: 'What did you eat?' },
  doses: { label: 'Tick my doses', asks: 'Due now, or earlier today' },
  symptom: { label: 'Log a symptom', asks: 'What are you feeling?' },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A drafted meal, summed for its card.
 *
 * Only dishes found in the food table are logged from the chat. A row with no
 * match would save with no calories at all, and from a card that shows a
 * total, that reads as "counted" when it was not. The card names what it
 * could not place and logs the rest.
 */
export function mealSummary(items: { food: unknown | null; energy_kcal: number | null }[]): {
  known: number;
  unknown: number;
  kcal: number;
  /** The confirm button's words, or null when there is nothing to log. */
  action: string | null;
  hint: string | null;
} {
  const known = items.filter((i) => i.food !== null);
  const unknown = items.length - known.length;
  const kcal = Math.round(known.reduce((sum, i) => sum + (i.energy_kcal ?? 0), 0));
  const action =
    known.length === 0 ? null : unknown === 0 ? 'Log meal' : `Log ${plural(known.length, 'dish', 'dishes')}`;
  const hint =
    unknown === 0
      ? null
      : known.length === 0
        ? 'None of this is in your food table yet. Add the dish in Track meals first.'
        : `${unknown === 1 ? 'One dish is' : `${unknown} dishes are`} not in your food table and will not be logged.`;
  return { known: known.length, unknown, kcal, action, hint };
}

export function mealReceipt(slotLabel: string, dishes: number, kcal: number): string {
  return `Logged to ${slotLabel.toLowerCase()} \u00b7 ${plural(dishes, 'dish', 'dishes')} \u00b7 ${kcal.toLocaleString('en-US')} Cal`;
}

/** A symptom's receipt names its label, so a wrong one is seen while Undo is still there. */
export function symptomReceipt(label: string | null): string {
  return label ? `Saved to your symptoms · ${label}` : 'Saved to your symptoms';
}

/** What a dose's circle holds on the card, before anything is saved. */
export type Mark = 'taken' | 'skipped' | null;

/**
 * Empty, taken, skipped, empty: the same turn the Track meds circle makes,
 * so a second tap means "skipped" in both places. Every dose starts empty.
 * The card never ticks one for you (Upendra's rule: "user should tick").
 */
export function nextMark(m: Mark): Mark {
  return m === null ? 'taken' : m === 'taken' ? 'skipped' : null;
}

/** The confirm button on the doses card, or null with nothing ticked. */
export function dosesAction(marks: Mark[]): string | null {
  const n = marks.filter((m) => m !== null).length;
  if (n === 0) return null;
  return marks.some((m) => m === 'skipped') ? `Save ${plural(n, 'dose')}` : `Tick ${plural(n, 'dose')}`;
}

export function dosesReceipt(marks: Mark[]): string {
  const taken = marks.filter((m) => m === 'taken').length;
  const skipped = marks.filter((m) => m === 'skipped').length;
  if (skipped === 0) return `${plural(taken, 'dose')} ticked`;
  if (taken === 0) return `${plural(skipped, 'dose')} marked skipped`;
  return `${taken} taken, ${skipped} skipped`;
}
