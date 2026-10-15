/**
 * When a symptom began, read from how the person put it.
 *
 * "Bloated after lunch", logged at 11 pm, began after lunch; timed at 11 pm
 * it would pull dinner into "what was eaten before it". His instruction, 15
 * Oct 2026: the app works it out from the words, the card shows it with a
 * "Started at" to correct, and nobody has to come back later to say it
 * stopped.
 *
 * Read by code, as meals and doses are (domain/chat.ts), not by a model:
 * the same sentence gives the same time every time, and a time the app
 * cannot read is left as "when it was logged" rather than guessed at.
 *
 * After a meal means one minute after the meal as logged that day, so the
 * meal is inside every window before the symptom and nothing eaten later
 * is. With no such meal logged, the slot's usual hour (plan.ts) stands in,
 * and the card says it is the usual time.
 */

import { USUAL_HOUR } from './plan';
import type { SlotId } from './slots';

export type Started = {
  at: number;
  /** What it was read from, for the card: "after lunch (1:20 pm)". */
  why: string;
};

/** An eaten meal of the day, as much as this needs. */
export type MealAt = { at: number; slot: SlotId };

const HOUR = 3_600_000;
const MIN = 60_000;
/** How far back a logged meal can be the one "after lunch" means. */
const RECENT_MS = 18 * HOUR;

const SLOT_WORDS: [RegExp, SlotId[], string][] = [
  [/\bbreakfast|nashta|nashte\b/, ['breakfast'], 'breakfast'],
  [/\blunch\b/, ['lunch'], 'lunch'],
  [/\bdinner|supper\b/, ['dinner'], 'dinner'],
  [/\bsnack\b/, ['msnack', 'esnack'], 'a snack'],
];

/** Parts of the day, for "since this morning", as hours: placeholders, said so on the card. */
const PARTS: [RegExp, number, number, string][] = [
  // [pattern, hour, days back, words]
  [/\blast night\b|\bkal raat\b/, 22, 1, 'last night'],
  [/\b(?:this |since |in the )morning\b|\bsubah\b/, 8, 0, 'this morning'],
  [/\b(?:this |since |in the )afternoon\b|\bdopahar\b/, 14, 0, 'this afternoon'],
  [/\b(?:this |since |in the )evening\b|\bshaam\b/, 18, 0, 'this evening'],
];

function clockAt(dayStart: number, h: number, m = 0): number {
  const d = new Date(dayStart);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const clock = (t: number) => {
  const d = new Date(t);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/**
 * When the words say it began, or null for "when logged". `meals` are the
 * eaten meals of today and yesterday; only ones before `now` are used.
 */
export function startFromWords(text: string, now: Date, meals: readonly MealAt[] = []): Started | null {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  const nowMs = now.getTime();
  const today = startOfDay(nowMs);
  // Only a meal of the last 18 hours is "the" lunch or dinner meant: at 4 pm
  // with no lunch logged, "after lunch" is today's lunchtime, not yesterday's
  // lunch (found on the built app, 15 Oct 2026); at 1 am, "after dinner" is
  // still last night's.
  const before = meals.filter((m) => m.at <= nowMs && nowMs - m.at <= RECENT_MS).sort((a, b) => b.at - a.at);

  // "2 hours ago", "an hour ago", "half an hour ago", "20 mins ago".
  const ago = /\b(\d{1,2}|an?|half an?)\s*(hours?|hrs?|h|minutes?|mins?)\s*ago\b/.exec(t);
  if (ago) {
    const n = ago[1].startsWith('half') ? 0.5 : /^an?$/.test(ago[1]) ? 1 : Number(ago[1]);
    const ms = /^h/.test(ago[2]) ? n * HOUR : n * MIN;
    if (ms > 0 && ms <= 48 * HOUR) return { at: nowMs - ms, why: ago[0] };
  }

  // "at 3 pm", "at 3:30pm", "at 15:30". Later than now today means yesterday.
  const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
  if (at && (at[3] || at[2])) {
    let h = Number(at[1]);
    const m = Number(at[2] ?? 0);
    if (at[3] === 'pm' && h < 12) h += 12;
    if (at[3] === 'am' && h === 12) h = 0;
    if (h <= 23 && m <= 59) {
      let when = clockAt(today, h, m);
      if (when > nowMs) when -= 24 * HOUR;
      return { at: when, why: `at ${clock(when)}` };
    }
  }

  // "after lunch", "since breakfast", "post dinner", "lunch ke baad".
  for (const [re, slots, words] of SLOT_WORDS) {
    const after = new RegExp(`\\b(?:after|since|post|following)\\s+(?:my\\s+|the\\s+|having\\s+)?(?:${re.source})|(?:${re.source})\\s+(?:ke\\s+)?baad\\b`);
    if (!after.test(t)) continue;
    const meal = before.find((m) => slots.includes(m.slot));
    if (meal) return { at: meal.at + MIN, why: `after ${words} (${clock(meal.at)})` };
    // Not logged: the usual hour, today if it has come, else yesterday's.
    const h = USUAL_HOUR[slots[0]] ?? 13;
    let when = clockAt(today, h) + MIN;
    if (when > nowMs) when -= 24 * HOUR;
    return { at: when, why: `after ${words} (its usual time, ${clock(when - MIN)})` };
  }

  // "after eating", "after food", "after a meal": the last meal before now.
  if (/\b(?:after|since)\s+(?:eating|food|(?:a |my |the )?meal)\b|\bkhane ke baad\b/.test(t) && before[0]) {
    return { at: before[0].at + MIN, why: `after the last meal (${clock(before[0].at)})` };
  }

  for (const [re, h, back, words] of PARTS) {
    if (!re.test(t)) continue;
    const when = clockAt(today - back * 24 * HOUR, h);
    if (when < nowMs) return { at: when, why: `${words} (about ${clock(when)})` };
  }
  return null;
}
