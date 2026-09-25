/**
 * The line under the home grid.
 *
 * The idea is someone who lives in the app and has been paying attention —
 * so it has to know what time it is, know what you ate, and say one specific
 * thing about it. Not a dashboard sentence. Not a notification.
 *
 * Three rules decide every line in here.
 *
 * **It suggests adding, not cutting.** "28g of protein left" is a thing you
 * can act on. "You're 600 over" is a verdict, and the Nutritionist's spec says
 * it never frames a suggestion in terms of restriction. When a number does run
 * high the line names it once, warmly, and points at tomorrow — a day you have
 * already finished is not a problem anyone can still solve.
 *
 * **It is never the same sentence twice in a row for no reason.** The pick is
 * deterministic — seeded by the day, the part of the day, the situation and a
 * coarse bucket of the number itself — so it is stable across re-renders and
 * shifts when either the clock or the food moves. Random would re-roll on
 * every render and read as a twitch rather than a thought.
 *
 * **It knows that a day ends when you go to bed, not at midnight.** Open it at
 * 00:30 having eaten nothing since dinner and it is still talking about the day
 * that just ended, because that is the day you are thinking about. See
 * `focusDay`.
 *
 * Everything here is pure: no database, no clock of its own, no model. The
 * model is deliberately nowhere near it — a sentence on the home screen has to
 * be instant, free and offline, and it must never state a number that is not
 * in the data. `Phrase` keeps the shape a model could later fill instead.
 */

import type { Macros } from './day';
import type { Targets } from './targets';

export type Band = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'small-hours';

export type Situation =
  /** No targets set, so there is no gap to talk about. */
  | 'no-targets'
  /** Targets exist, nothing logged for the day in focus. */
  | 'empty'
  /** Something worth adding is short, and there is still day left. */
  | 'short'
  /** Short, but the day is over — points at tomorrow. */
  | 'short-past'
  /** Energy ran high. Stated once, never judged; forward-looking once the day is done. */
  | 'high'
  /** Everything with a target landed inside it. */
  | 'all-hit'
  /** Logging, nothing notable either way. */
  | 'steady'
  /** A weight trend worth mentioning instead. */
  | 'weight';

export type Tone = 'neutral' | 'nudge' | 'good';

export type Phrase = { text: string; tone: Tone; situation: Situation };

/** The macros the banner will ever ask you to add more of. */
const ADDITIVE = [
  { key: 'protein_g' as const, idx: 1, name: 'protein' },
  { key: 'fibre_g' as const, idx: 4, name: 'fibre' },
];

export type BannerCtx = {
  /** Wall clock, in ms. Passed in so this stays pure and testable. */
  now: number;
  /** Totals for the day in focus — see focusDay. */
  totals: Macros;
  /** How many items that day holds. Zero means nothing logged. */
  itemCount: number;
  targets: Targets;
  /** True when the day in focus is not today. */
  lookingBack: boolean;
  /**
   * Weight readings, newest first, already limited to something recent.
   * Optional: the banner works fine for someone who never logs a weight.
   */
  weights?: { kg: number; measured_at: number }[];
};

// ------------------------------------------------------------------ time

export function bandOf(now: number): Band {
  const h = new Date(now).getHours();
  if (h < 4) return 'small-hours';
  if (h < 11) return 'morning';
  if (h < 15) return 'midday';
  if (h < 18) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

/**
 * Which day the banner should be talking about.
 *
 * Between midnight and four, with nothing eaten yet, the day you are thinking
 * about is the one that just ended — which is why the line at 23:45 and the
 * line at 00:05 say nearly the same thing. Log something and it moves on,
 * however early that is: a 1am plate of leftovers starts a new day whether the
 * clock agrees or not.
 */
export function focusDay(
  now: number,
  loggedToday: number,
): { dayStart: number; lookingBack: boolean } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  if (bandOf(now) === 'small-hours' && loggedToday === 0) {
    return { dayStart: today - 86_400_000, lookingBack: true };
  }
  return { dayStart: today, lookingBack: false };
}

/** True once the day is effectively finished — nothing more will be eaten. */
function dayIsDone(ctx: BannerCtx): boolean {
  return ctx.lookingBack || bandOf(ctx.now) === 'night';
}

// ------------------------------------------------------------- the gaps

type Gap = { name: string; left: number; pct: number };

/** What is short and worth adding, biggest shortfall first. */
export function shortfalls(ctx: BannerCtx): Gap[] {
  const out: Gap[] = [];
  for (const m of ADDITIVE) {
    const target = ctx.targets[m.key];
    if (!target || target <= 0) continue;
    const had = ctx.totals[m.idx] ?? 0;
    const left = target - had;
    if (left <= 0.5) continue;
    out.push({ name: m.name, left: Math.round(left), pct: had / target });
  }
  return out.sort((a, b) => a.pct - b.pct);
}

/** How far past the calorie target the day ran, or 0. */
export function overBy(ctx: BannerCtx): number {
  const t = ctx.targets.energy_kcal;
  if (!t || t <= 0) return 0;
  return Math.max(0, Math.round((ctx.totals[0] ?? 0) - t));
}

/**
 * Every target that exists was met — including not sailing past the calorie
 * one. Protein and fibre alone are not "everything": a day that hit both and
 * ran 700 over would otherwise get congratulated for it, which is both wrong
 * and the kind of thing that teaches you to stop reading the banner.
 */
function allHit(ctx: BannerCtx): boolean {
  const keys = [
    ['protein_g', 1],
    ['fibre_g', 4],
  ] as const;
  let any = false;
  for (const [key, idx] of keys) {
    const t = ctx.targets[key];
    if (!t || t <= 0) continue;
    any = true;
    if ((ctx.totals[idx] ?? 0) < t) return false;
  }
  return any && overBy(ctx) <= 250;
}

/**
 * Weight movement over the readings given, in kg, or null.
 *
 * First minus last, so negative is down. Deliberately just the two ends: a
 * regression line over five noisy bathroom readings implies a precision the
 * scale does not have.
 */
export function weightTrend(
  weights: { kg: number; measured_at: number }[] | undefined,
): { delta: number; days: number } | null {
  if (!weights || weights.length < 2) return null;
  const newest = weights[0];
  const oldest = weights[weights.length - 1];
  const days = Math.round((newest.measured_at - oldest.measured_at) / 86_400_000);
  if (days < 3) return null;
  const delta = Math.round((newest.kg - oldest.kg) * 10) / 10;
  if (Math.abs(delta) < 0.3) return null;
  return { delta, days };
}

// ------------------------------------------------------------- situation

export function situationOf(ctx: BannerCtx): Situation {
  const hasTargets = ADDITIVE.some((m) => (ctx.targets[m.key] ?? 0) > 0)
    || (ctx.targets.energy_kcal ?? 0) > 0;
  if (!hasTargets) return 'no-targets';
  if (ctx.itemCount === 0) return 'empty';

  const done = dayIsDone(ctx);
  const gaps = shortfalls(ctx);

  if (gaps.length > 0 && gaps[0].pct < 0.85) return done ? 'short-past' : 'short';
  if (overBy(ctx) > 250) return 'high';
  if (allHit(ctx)) return 'all-hit';
  // Nothing pressing. A weight trend is a better thing to say than nothing.
  if (weightTrend(ctx.weights)) return 'weight';
  return 'steady';
}

// ----------------------------------------------------------- the phrases

type Vars = {
  gap: Gap | null;
  over: number;
  kcal: number;
  trend: { delta: number; days: number } | null;
  yesterday: boolean;
};

type Candidate = {
  /** Which parts of the day this line suits. Absent means any. */
  bands?: Band[];
  say: (v: Vars) => string;
  tone: Tone;
};

const n = (x: number) => x.toLocaleString();
/** "yesterday" or "today", so one line serves both sides of midnight. */
const when = (v: Vars) => (v.yesterday ? 'yesterday' : 'today');

const BANK: Record<Situation, Candidate[]> = {
  'no-targets': [
    { say: () => 'Set your daily targets and this line starts meaning something.', tone: 'neutral' },
    { say: () => 'No targets yet — set them and I can tell you where you are.', tone: 'neutral' },
  ],

  empty: [
    { bands: ['morning'], say: () => 'Nothing logged yet. What was breakfast?', tone: 'nudge' },
    { bands: ['midday'], say: () => 'Still a blank day. Worth catching up while you remember.', tone: 'nudge' },
    { bands: ['afternoon'], say: () => 'Nothing down for today yet.', tone: 'nudge' },
    { bands: ['evening', 'night'], say: () => 'Nothing logged today — even a rough entry beats a blank day.', tone: 'nudge' },
    { bands: ['small-hours'], say: () => 'Yesterday went unlogged. No harm; today is clean.', tone: 'neutral' },
    { say: () => 'Nothing logged yet today.', tone: 'nudge' },
  ],

  short: [
    { bands: ['morning'], say: (v) => `${v.gap!.left}g of ${v.gap!.name} to go, and the whole day to do it in.`, tone: 'nudge' },
    { bands: ['morning'], say: (v) => `${v.gap!.name[0].toUpperCase()}${v.gap!.name.slice(1)} is the one to chase today — ${v.gap!.left}g left.`, tone: 'nudge' },
    { bands: ['midday', 'afternoon'], say: (v) => `${v.gap!.left}g of ${v.gap!.name} left. Plenty of day for it.`, tone: 'nudge' },
    { bands: ['midday', 'afternoon'], say: (v) => `Running light on ${v.gap!.name} — ${v.gap!.left}g to go.`, tone: 'nudge' },
    { bands: ['evening'], say: (v) => `${v.gap!.left}g short on ${v.gap!.name}. Dinner is a good place to fix that.`, tone: 'nudge' },
    { bands: ['evening'], say: (v) => `${v.gap!.name} needs ${v.gap!.left}g more before the day is out.`, tone: 'nudge' },
    { say: (v) => `${v.gap!.left}g of ${v.gap!.name} left ${when(v)}.`, tone: 'nudge' },
  ],

  'short-past': [
    { say: (v) => `${when(v)[0].toUpperCase()}${when(v).slice(1)} finished ${v.gap!.left}g short on ${v.gap!.name}. Worth a stronger breakfast.`, tone: 'neutral' },
    { say: (v) => `${v.gap!.name[0].toUpperCase()}${v.gap!.name.slice(1)} came up ${v.gap!.left}g short. Easy one to put right tomorrow.`, tone: 'neutral' },
    { bands: ['small-hours'], say: (v) => `${v.gap!.left}g short on ${v.gap!.name} yesterday. Fresh slate now.`, tone: 'neutral' },
    { bands: ['night'], say: (v) => `${v.gap!.left}g of ${v.gap!.name} missing today. Tomorrow, then.`, tone: 'neutral' },
  ],

  // Mid-day this states the number and stops — there is still a day to eat,
  // and a running total is not a verdict. Once the day is done it looks
  // forward, because a finished day is not a problem anyone can still solve.
  high: [
    { bands: ['morning', 'midday', 'afternoon', 'evening'], say: (v) => `${n(v.kcal)} so far today.`, tone: 'neutral' },
    { bands: ['morning', 'midday', 'afternoon', 'evening'], say: (v) => `${n(v.kcal)} in already today.`, tone: 'neutral' },
    { bands: ['night'], say: (v) => `A big day — ${n(v.kcal)}. Tomorrow evens it out.`, tone: 'neutral' },
    { bands: ['night'], say: (v) => `${n(v.kcal)} today. One day never decides anything.`, tone: 'neutral' },
    { bands: ['small-hours'], say: (v) => `Yesterday ran to ${n(v.kcal)}. Today starts at zero.`, tone: 'neutral' },
    { bands: ['small-hours'], say: (v) => `${n(v.kcal)} yesterday. Clean slate now.`, tone: 'neutral' },
    { say: (v) => `${n(v.kcal)} ${when(v)}.`, tone: 'neutral' },
  ],

  'all-hit': [
    { say: (v) => `Everything landed ${when(v)}. Protein, fibre, the lot.`, tone: 'good' },
    { say: (v) => `Good ${when(v)} — every target met.`, tone: 'good' },
    { bands: ['midday', 'afternoon'], say: () => 'All targets met already, and the day is not over.', tone: 'good' },
  ],

  weight: [
    { say: (v) => `${v.trend!.delta < 0 ? 'Down' : 'Up'} ${Math.abs(v.trend!.delta)}kg over the last ${v.trend!.days} days.`, tone: 'neutral' },
    { say: (v) => `Weight has moved ${Math.abs(v.trend!.delta)}kg ${v.trend!.delta < 0 ? 'down' : 'up'} in ${v.trend!.days} days.`, tone: 'neutral' },
  ],

  steady: [
    { say: (v) => `${n(v.kcal)} in ${when(v)}, and nothing out of place.`, tone: 'good' },
    { say: () => 'Holding steady. Nothing needs chasing.', tone: 'good' },
    { bands: ['morning'], say: () => 'Off to a tidy start.', tone: 'good' },
  ],
};

/**
 * A small stable hash, so the same inputs always choose the same line.
 *
 * Stability is the point: the banner re-renders on a timer and on every log,
 * and a line that re-rolled each time would read as a twitch. It moves when
 * the day, the part of the day, or the size of the number moves — which is
 * often enough to feel awake and rarely enough to feel restless.
 */
function pick<T>(list: T[], seed: string): T {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[Math.abs(h) % list.length];
}

export function banner(ctx: BannerCtx): Phrase {
  const situation = situationOf(ctx);
  const band = bandOf(ctx.now);
  const gaps = shortfalls(ctx);
  const vars: Vars = {
    gap: gaps[0] ?? null,
    over: overBy(ctx),
    kcal: Math.round(ctx.totals[0] ?? 0),
    trend: weightTrend(ctx.weights),
    yesterday: ctx.lookingBack,
  };

  // A line written for this part of the day beats a general one outright.
  // Pooling them together let the catch-all win the draw half the time, so
  // "Yesterday went unlogged" lost to "Nothing logged yet today" at 2am —
  // generic, and wrong about which day it meant.
  const all = BANK[situation];
  const forBand = all.filter((c) => c.bands?.includes(band));
  const generic = all.filter((c) => !c.bands);
  const pool = forBand.length > 0 ? forBand : generic.length > 0 ? generic : all;

  // The number goes in the seed in coarse buckets: logging something that
  // moves the gap changes the sentence, a rounding difference does not.
  const bucket = Math.round((vars.gap?.left ?? vars.kcal) / 10);
  const d = new Date(ctx.now);
  const seed = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${band}|${situation}|${bucket}`;
  const chosen = pick(pool, seed);

  return { text: chosen.say(vars), tone: chosen.tone, situation };
}
