/**
 * Planning a day by chat: "plan tomorrow so I hit 90 g protein, using things
 * I usually eat".
 *
 * The app builds the day itself, in code, and no model takes part. On 11 Oct
 * 2026 a real model given "I just had 2 roti and dal" and a tool for the meal
 * card ignored the tool and said the meal was logged; a plan is a larger
 * thing to get wrong, with eight amounts in it instead of two. So the rule
 * here is narrower than "things you usually eat" might suggest, and it is the
 * point of the design:
 *
 *   Every meal in a plan is a meal this person logged, whole, in the last
 *   four weeks, with the dishes and the amounts they logged.
 *
 * Nothing is scaled, swapped or invented to reach a figure. The planner
 * chooses which of those meals goes in each slot so the day lands nearest
 * the aim, shows the totals it adds up to, and says how far off it is. A
 * plan that reaches 78 g against 90 g says 78 g. Stretching a portion to
 * close the gap would be the app writing an amount nobody ate, which is the
 * same thing R2 forbids for a dose.
 *
 * The parts in this file are pure. The reads and the save are in
 * `mealplanner.ts`.
 */

import { CALORIE_FLOOR } from '../safety/gates';
import { DAYS_AHEAD, NIGHT_ENDS } from './plan';
import { SLOTS, type SlotId } from './slots';

// ---------------------------------------------------------------- the ask

export type PlanAsk = {
  /** Whole days from today: 0 today, 1 tomorrow, up to DAYS_AHEAD. */
  ahead: number;
  /**
   * The day was counted from today — "tomorrow", "kal", "in 2 days", or no
   * day at all — rather than named. After midnight a count is the one
   * reading that depends on whom you ask (`asksAtNight`). Optional so that
   * a plan built with no sentence behind it need not say.
   */
  counted?: boolean;
  /** A protein figure the person typed, in grams. Never one the app chose. */
  protein: number | null;
  /** A calorie figure the person typed. */
  kcal: number | null;
};

const LEAD = '(?:(?:ok|okay|so|hey|hi|well|also|and|oh)[,:.]?\\s+)*';
const POLITE =
  "(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?(?:help\\s+me\\s+(?:to\\s+)?)?(?:i\\s+(?:want|need|would\\s+like|'d\\s+like)\\s+(?:you\\s+)?to\\s+|i\\s+(?:want|need)\\s+|let'?s\\s+)?";
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = `today|tonight|tomorrow|the day after tomorrow|day after tomorrow|${WEEKDAYS.join('|')}|${WEEKDAYS.map((d) => d.slice(0, 3)).join('|')}|kal|parso`;
const FOODISH = /\b(?:meals?|food|eating|diet|menu|breakfast|lunch|dinner|snacks?|khana)\b/i;

/**
 * A request to plan a day's meals, or null.
 *
 * It has to be a request: "what did I plan for tomorrow?" is a question
 * about the record and goes to a lookup. And it has to be about food, either
 * by naming it or by being nothing but a day: "plan tomorrow" is a meal plan
 * in this app, "plan my trip tomorrow" is not.
 *
 * With no day named the plan is for tomorrow. The card says which day it
 * built, so a wrong guess is seen before anything is saved.
 */
export function planRequest(text: string, now = new Date()): PlanAsk | null {
  const t = text
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const m = new RegExp(`^${LEAD}${POLITE}(plan|make|build|create|suggest|give\\s+me|draw\\s+up|prepare)\\b\\s*(.*)$`, 'i').exec(t);
  if (!m) return null;
  const rest = m[2];
  const planVerb = m[1].toLowerCase() === 'plan';
  // "make me a meal plan for Friday" needs the word; "plan Friday" is it.
  if (!planVerb && !/\bplan\b/i.test(rest)) return null;

  const bare = rest.replace(/^(?:(?:out|me|my|the|a|for|on|of)\s+)+/i, '');
  const startsWithDay = new RegExp(`^(?:next\\s+|this\\s+)?(?:${DAY})\\b`, 'i').test(bare) || /^in\s+\d\s+days?\b/i.test(bare);
  // "plan" alone, or "plan so I hit 90 g protein": still a day's meals.
  const nothingElse = bare === '' || /^(?:so|to|with|at|around|under|for\s+\d)/i.test(bare);
  const protein = proteinIn(t);
  const kcal = caloriesIn(t);
  // "plan a 900 kcal day for Friday" names no food and does not open with
  // the day, but a plan with calories or protein in it is a plan of meals.
  const figured = protein !== null || kcal !== null;
  if (!FOODISH.test(rest) && !startsWithDay && !nothingElse && !figured) return null;

  return { ...aheadOf(rest, now), protein, kcal };
}

/**
 * Which day a request names, as whole days from today. Tomorrow when none,
 * and that default is a count like "tomorrow" is.
 */
function aheadOf(rest: string, now: Date): { ahead: number; counted: boolean } {
  const s = rest.toLowerCase();
  const counted = countedIn(s);
  if (counted !== null) return { ahead: counted, counted: true };
  if (/\b(?:today|tonight)\b/.test(s)) return { ahead: 0, counted: false };
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b(?:${WEEKDAYS[i]}|${WEEKDAYS[i].slice(0, 3)})\\b`).test(s)) {
      // The next one. Said on a Monday, "Monday" is a week away: today has
      // its own word. Except in the small hours, when "Thursday" said at
      // 01:30 on a Thursday is the morning ahead, whichever way the person
      // counts their nights, and never a week off.
      const gap = (i - now.getDay() + 7) % 7;
      return { ahead: gap === 0 ? (now.getHours() < NIGHT_ENDS ? 0 : 7) : gap, counted: false };
    }
  }
  return { ahead: 1, counted: true };
}

/** "tomorrow", "kal", "day after tomorrow", "parso", "in 3 days": the count, or null. */
function countedIn(s: string): number | null {
  if (/\b(?:the )?day after tomorrow\b|\bparso\b/.test(s)) return 2;
  if (/\btomorrow\b|\bkal\b/.test(s)) return 1;
  const inDays = /\bin (\d) days?\b/.exec(s);
  if (inDays) return Math.min(DAYS_AHEAD, Math.max(0, Number(inDays[1])));
  return null;
}

/**
 * The day a model's plan is for, when the person's own words count it from
 * today: read from those words rather than taken from the model, so that
 * the night's question starts from the same reading whoever opened the
 * card. Null when no word counts: with no day in the sentence the model
 * chose one, and its choice is left alone.
 */
export function countFromToday(text: string): number | null {
  return countedIn(text.toLowerCase());
}

// ------------------------------------------------- "tomorrow" after midnight

/** 'begun': the day that has just begun. 'after': the calendar's tomorrow. */
export type NightTomorrow = 'begun' | 'after';

/**
 * Whether the day of this plan turns on what the person means by
 * "tomorrow" at night. Some count the hours after midnight as the night
 * before, so their "tomorrow" is the calendar's today; some do not. His
 * decision (15 Oct 2026): ask, once, and remember.
 */
export function asksAtNight(ask: PlanAsk, now = new Date()): boolean {
  return !!ask.counted && now.getHours() < NIGHT_ENDS;
}

/** The day a counted request means, given the person's answer. */
export function nightAhead(ahead: number, meant: NightTomorrow): number {
  return meant === 'begun' ? Math.max(0, ahead - 1) : ahead;
}

/** "90 g protein", "90g of protein", "protein of 90 g". Held to a sane range. */
function proteinIn(t: string): number | null {
  const m =
    /(\d{1,3})\s*(?:g|gm|gms|grams?)\s*(?:of\s+)?protein\b/i.exec(t) ??
    /\bprotein\b[^\d]{0,12}(\d{1,3})\s*(?:g|gm|gms|grams?)\b/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 10 && n <= 400 ? n : null;
}

/**
 * "1800 kcal", "1,800 calories": the day's calories, as typed.
 *
 * Returned whatever its size, so that the caller can tell a figure under
 * the floor from no figure at all (`belowFloor`). A figure followed by the
 * name of one meal ("with a 300 kcal snack") is that meal's, not the day's,
 * and is left alone, as the gate leaves it.
 */
function caloriesIn(t: string): number | null {
  const m = /(\d{1,2},?\d{3}|\d{3,4})\s*k?cal(?:orie)?s?\b(.*)$/i.exec(t);
  if (!m) return null;
  if (/^\s*(?:snack|breakfast|lunch|dinner|meal\b(?!\s*plan)|dessert|drink|smoothie|shake)/i.test(m[2])) return null;
  const n = Number(m[1].replace(',', ''));
  return n >= 100 && n <= 6000 ? n : null;
}

/**
 * A plan asked for at fewer calories than the floor.
 *
 * The gate (R7) stops such a request before the planner sees it, when its
 * patterns recognise the sentence. Written cold on 11 Oct 2026, a set of
 * plan requests found three they did not: "plan tomorrow at 600 kcal", "plan
 * tomorrow so I eat only 700 kcal", "plan a 900 kcal day for Friday". In each
 * the figure comes after the word "plan", and the gate looks for the word
 * after the figure. Here the question is easier than the gate's: the
 * sentence is already known to ask for a day of meals, so a calorie figure
 * in it is the day's. The caller stops with the gate's own message, word for
 * word, so the turn reads back as that stop when the chat is reopened. The
 * floor is the gate's constant; there is no second number.
 */
export function belowFloor(ask: PlanAsk): boolean {
  return ask.kcal !== null && ask.kcal < CALORIE_FLOOR;
}

// ----------------------------------------------------- what is usually eaten

/** How far back a "usual" meal may come from. */
export const USUAL_DAYS = 28;
/**
 * A slot is planned only if it was logged on at least this many days of the
 * window. Three, because two can be a weekend: with fewer the "usual" lunch
 * is whatever happened once. Judgement, not a sourced figure.
 */
export const USUAL_MIN_DAYS = 3;
/** The most options weighed per slot. Six slots of five is 7,776 days at most. */
const OPTIONS_PER_SLOT = 5;

export type Five = { energy_kcal: number; protein_g: number; fat_g: number; carbs_g: number; fibre_g: number };
const NONE: Five = { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, fibre_g: 0 };
const add = (a: Five, b: Five): Five => ({
  energy_kcal: a.energy_kcal + b.energy_kcal,
  protein_g: a.protein_g + b.protein_g,
  fat_g: a.fat_g + b.fat_g,
  carbs_g: a.carbs_g + b.carbs_g,
  fibre_g: a.fibre_g + b.fibre_g,
});

/** One dish of a past meal: which, and how much, exactly as logged. */
export type PastDish = { foodId: string; name: string; quantity: number | null; unit: string | null; grams: number | null };
/** One meal from the record, already known to be made only of the person's own live dishes. */
export type PastMeal = { slot: SlotId; at: number; day: string; dishes: PastDish[] };

/** A meal eaten one or more times, as an option for its slot. */
export type Option = {
  slot: SlotId;
  dishes: PastDish[];
  /** On how many days of the window this exact meal was logged. */
  times: number;
  lastAt: number;
};

export type SlotOptions = {
  slot: SlotId;
  /** Days of the window with anything logged in this slot. */
  days: number;
  /**
   * Logged on fewer than half the days anything was logged: a slot the
   * person often goes without, so the planner may leave it empty.
   */
  optional: boolean;
  options: Option[];
};

/** The same dishes in the same amounts, whatever order they were logged in. */
const signature = (dishes: PastDish[]) =>
  dishes
    .map((d) => `${d.foodId}|${d.unit ?? ''}|${d.quantity ?? ''}|${d.quantity == null ? Math.round(d.grams ?? 0) : ''}`)
    .sort()
    .join(';');

/**
 * The meals a person has eaten, grouped into the options each slot has.
 *
 * "Something else" is never planned: it is the slot for what fits no slot,
 * so there is no usual meal for it and no time of day to plan it at.
 */
export function usualOptions(meals: PastMeal[]): SlotOptions[] {
  const loggedDays = new Set(meals.map((m) => m.day)).size;
  const out: SlotOptions[] = [];
  for (const s of SLOTS) {
    if (s.id === 'other') continue;
    const mine = meals.filter((m) => m.slot === s.id && m.dishes.length > 0);
    const days = new Set(mine.map((m) => m.day)).size;
    if (days < USUAL_MIN_DAYS) continue;
    const bySig = new Map<string, Option & { seen: Set<string> }>();
    for (const m of mine) {
      const sig = signature(m.dishes);
      const have = bySig.get(sig);
      if (have) {
        have.seen.add(m.day);
        if (m.at > have.lastAt) have.lastAt = m.at;
      } else {
        bySig.set(sig, { slot: s.id, dishes: m.dishes, times: 1, lastAt: m.at, seen: new Set([m.day]) });
      }
    }
    const options = [...bySig.values()]
      .map(({ seen, ...o }) => ({ ...o, times: seen.size }))
      // Most often first, the more recent of two equals ahead.
      .sort((a, b) => b.times - a.times || b.lastAt - a.lastAt)
      .slice(0, OPTIONS_PER_SLOT);
    out.push({ slot: s.id, days, optional: days * 2 < loggedDays, options });
  }
  return out;
}

// ------------------------------------------------------------ choosing a day

export type Aim = { protein: number | null; kcal: number | null; /** True when the protein figure was typed in this request. */ proteinAsked: boolean };

/** One slot of a planned day: the option chosen, with what it adds up to. */
export type Pick = { slot: SlotId; option: Option; totals: Five };
export type PlannedDay = {
  picks: Pick[];
  /** The picks alone. */
  totals: Five;
  /** The picks plus what the day already holds. */
  dayTotals: Five;
  usualness: number;
};

/**
 * How far a day is from the aim; smaller is nearer.
 *
 * The weights are judgement, with no source behind them, and say three
 * things. Going over the calorie target counts three times as much as
 * falling short of it by the same amount: the target is a ceiling people set
 * on purpose, and a plan that breaks it is not the one they asked for.
 * Protein counts twice. And a protein figure typed in the request counts
 * four times, because then it is the request.
 */
export function distance(total: Five, aim: Aim): number {
  let d = 0;
  if (aim.kcal && aim.kcal > 0) {
    const over = Math.max(0, total.energy_kcal - aim.kcal) / aim.kcal;
    const under = Math.max(0, aim.kcal - total.energy_kcal) / aim.kcal;
    d += 3 * over + under;
  }
  if (aim.protein && aim.protein > 0) {
    d += (aim.proteinAsked ? 4 : 2) * (Math.abs(total.protein_g - aim.protein) / aim.protein);
  }
  return d;
}

/**
 * The days that can be made from the options, nearest the aim first.
 *
 * `priced` is what each option adds up to today: the dish's current numbers
 * at the amounts logged, worked out by the caller, so a dish corrected since
 * it was eaten is planned at its corrected figures. `already` is what the day
 * holds in slots that are not being planned.
 *
 * With no aim at all the most usual day comes first. Every slot is tried
 * with each of its options, and an optional slot also with nothing; the
 * whole product is at most a few thousand days, so it is simply all tried.
 */
export function rankDays(
  slots: SlotOptions[],
  priced: (o: Option) => Five,
  aim: Aim,
  already: Five = NONE,
  keep = 5,
): PlannedDay[] {
  const usable = slots.filter((s) => s.options.length > 0);
  if (usable.length === 0) return [];
  let days: { picks: Pick[]; totals: Five; usualness: number }[] = [{ picks: [], totals: NONE, usualness: 0 }];
  for (const s of usable) {
    const next: typeof days = [];
    for (const d of days) {
      for (const o of s.options) {
        const t = priced(o);
        next.push({ picks: [...d.picks, { slot: s.slot, option: o, totals: t }], totals: add(d.totals, t), usualness: d.usualness + o.times });
      }
      if (s.optional) next.push(d);
    }
    days = next;
  }
  const aimed = !!(aim.kcal || aim.protein);
  return days
    .filter((d) => d.picks.length > 0)
    .map((d) => ({ ...d, dayTotals: add(d.totals, already) }))
    .map((d) => ({ d, far: aimed ? distance(d.dayTotals, aim) : 0 }))
    .sort((a, b) => a.far - b.far || b.d.usualness - a.d.usualness || b.d.picks.length - a.d.picks.length)
    .slice(0, keep)
    .map((x) => x.d);
}

// ------------------------------------------------------------------ wording

/**
 * The line under a plan's totals: how it stands against the aim, in the
 * person's own figures. Plain statement, no praise and no warning.
 */
export function aimLine(day: Five, aim: Aim): string | null {
  const parts: string[] = [];
  if (aim.protein) {
    const p = Math.round(day.protein_g);
    const gap = p - aim.protein;
    parts.push(
      gap === 0
        ? `${p} g protein, the ${aim.protein} g ${aim.proteinAsked ? 'you asked for' : 'target'}`
        : `${p} g protein, ${Math.abs(gap)} g ${gap < 0 ? 'under' : 'over'} the ${aim.protein} g ${aim.proteinAsked ? 'you asked for' : 'target'}`,
    );
  }
  if (aim.kcal) {
    const k = Math.round(day.energy_kcal);
    const gap = k - aim.kcal;
    const n = Math.abs(gap).toLocaleString('en-US');
    parts.push(gap === 0 ? `${k.toLocaleString('en-US')} Cal, the target` : `${n} Cal ${gap < 0 ? 'under' : 'over'} the ${aim.kcal.toLocaleString('en-US')} Cal target`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** "Planned for Mon 12 Oct: 3 meals, 7 dishes, 1,640 Cal. In Track meals." */
export function planReceipt(dayLabel: string, meals: number, dishes: number, kcal: number, meant: number): string {
  const head = `Planned for ${dayLabel}: ${meals} ${meals === 1 ? 'meal' : 'meals'}, ${dishes} ${dishes === 1 ? 'dish' : 'dishes'}, ${Math.round(kcal).toLocaleString('en-US')} Cal. In Track meals.`;
  // Written from the rows read back. If fewer went in than the card showed,
  // the receipt is where that has to be said.
  return dishes === meant ? head : `${head} The card showed ${meant} dishes; ${dishes} were saved.`;
}
