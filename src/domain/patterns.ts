/**
 * What came before a symptom: the food and symptom patterns (approved 9 Oct
 * 2026, built 15 Oct). One calculation, used by the patterns view in
 * Symptom history and by Ask Mealo's thali_before_symptom, so the screen
 * and the chat give the same numbers.
 *
 * The method is a case-crossover comparison, the standard design for
 * something brief (a meal, a dose) before something sudden (a symptom):
 * each person is their own comparison (Maclure, "The case-crossover
 * design", Am J Epidemiol 1991;133:144-53). For every bout of the symptom,
 * what was eaten or taken in the hours before it; against that, the same
 * hours of the day on the other days of the month. Rice eaten every day is
 * then no more common before bloating than on any day, which the lookup this
 * replaces could not see: it set "entries with rice before them" against
 * "days rice was eaten", two different counts.
 *
 * His decisions, 15 Oct 2026: a month of symptoms is looked at, history
 * keeps everything; windows of 12 h, 24 h, 48 h, a week, a month; medicines
 * count, since they are taken and act on the body. What it may say is
 * "came before it more often than on other days", never "causes": counts
 * like these cannot show a cause (the rule since 9 Oct), and whether to
 * stop or change a medicine is for the doctor.
 *
 * Pure: the record in, the counts out, no clock but the `now` passed in.
 */

import type { ExportInput } from './export';
import { counts } from './plan';
import { suggestLabel } from './symptomlabels';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const WINDOWS = [
  { id: '12h', label: '12 h', words: '12 hours', ms: 12 * HOUR },
  { id: '24h', label: '24 h', words: '24 hours', ms: 24 * HOUR },
  { id: '48h', label: '48 h', words: '48 hours', ms: 48 * HOUR },
  { id: '1w', label: '1 week', words: 'week', ms: 7 * DAY },
  { id: '1m', label: '1 month', words: 'month', ms: 30 * DAY },
] as const;
export type WindowId = (typeof WINDOWS)[number]['id'];
export const DEFAULT_WINDOW: WindowId = '24h';

/** How far back symptoms are looked at: a month, his number. */
export const LOOK_DAYS = 30;

/**
 * Fewer bouts than this and nothing is called a pattern; what came before
 * each is listed and no more. Five, the number the lookup already used.
 */
export const MIN_BOUTS = 5;

/** Entries of one symptom this close together are one bout, counted once. */
export const BOUT_GAP_MS = 12 * HOUR;

/**
 * "Stands out": before at least this many bouts, at least this many times
 * as often as on other days, and unlikely to be chance once every item
 * checked is allowed for (Fisher's exact test, Bonferroni-adjusted).
 */
export const STANDS_OUT = { minBefore: 3, minRatio: 2, maxP: 0.05 } as const;

export type Tag = 'stands-out' | 'chance' | 'usual' | 'few';

export type PatternItem = {
  name: string;
  kind: 'food' | 'medicine';
  /** Bouts it came before, of how many. */
  before: number;
  of: number;
  /** Other days it came at the same hours, of how many. */
  other: number;
  ofOther: number;
  tag: Tag;
  /** One-sided Fisher p, adjusted for the number of items checked. */
  p: number;
  /** For each bout it came before: when the bout began, and when it was eaten or taken. */
  dates: { began: number; at: number }[];
};

export type Bout = {
  began: number;
  /** What was eaten or taken in the window before it, latest first. */
  before: { name: string; kind: 'food' | 'medicine'; at: number }[];
};

export type Pattern = {
  label: string;
  window: WindowId;
  bouts: Bout[];
  /** Other days each kind was compared against. */
  foodDays: number;
  medicineDays: number;
  few: boolean;
  items: PatternItem[];
};

// -------------------------------------------------------------- the maths

const logFact = (() => {
  const cache = [0];
  return (n: number) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();
const logChoose = (n: number, k: number) => logFact(n) - logFact(k) - logFact(n - k);

/**
 * P(at least `a` of the `n` bouts exposed), when `a + b` exposures fall at
 * random among `n + m` windows: Fisher's exact test, one-sided, from the
 * hypergeometric distribution.
 */
export function fisherAtLeast(a: number, n: number, b: number, m: number): number {
  const N = n + m;
  const K = a + b;
  let p = 0;
  for (let x = a; x <= Math.min(n, K); x++) {
    if (K - x > m) continue;
    p += Math.exp(logChoose(K, x) + logChoose(N - K, n - x) - logChoose(N, n));
  }
  return Math.min(1, p);
}

// ------------------------------------------------------------ the record

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The label a logged symptom counts under: the one chosen, else the one its words suggest. */
export const labelOf = (s: { text: string; label?: string | null }) => s.label || suggestLabel(s.text);

/** The bouts of one symptom in the month, oldest first, repeat entries folded in. */
export function boutsOf(x: Pick<ExportInput, 'symptoms'>, label: string, now: number): number[] {
  const since = now - LOOK_DAYS * DAY;
  const began = x.symptoms
    .filter((s) => labelOf(s) === label)
    .map((s) => s.startedAt ?? s.at)
    .filter((t) => t >= since && t <= now)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of began) if (out.length === 0 || t - out[out.length - 1] > BOUT_GAP_MS) out.push(t);
  return out;
}

/** Every symptom label with a bout in the month, with how many, most first. */
export function labelsInMonth(x: Pick<ExportInput, 'symptoms'>, now: number): { label: string; bouts: number }[] {
  const labels = new Set(x.symptoms.map(labelOf).filter((l): l is string => !!l));
  return [...labels]
    .map((label) => ({ label, bouts: boutsOf(x, label, now).length }))
    .filter((l) => l.bouts > 0)
    .sort((a, b) => b.bouts - a.bouts || a.label.localeCompare(b.label));
}

type Exposure = { key: string; name: string; kind: 'food' | 'medicine'; at: number };

function exposuresOf(x: Pick<ExportInput, 'meals' | 'intakes'>): Exposure[] {
  const food = x.meals.flatMap((m) =>
    m.items.filter((i) => counts(i.plan_state)).map((i) => ({ key: `f:${i.name.toLowerCase()}`, name: i.name, kind: 'food' as const, at: m.at })),
  );
  const meds = (x.intakes ?? []).map((i) => ({ key: `m:${i.medicine.toLowerCase()}`, name: i.medicine, kind: 'medicine' as const, at: i.at }));
  return [...food, ...meds];
}

/**
 * What came before one symptom, in one window.
 *
 * Other days are the days of the month with something of that kind logged
 * (a meal eaten; a dose due) and no bout of this symptom: a day with
 * nothing logged is missing, not a day without food, and counts neither
 * way. Each is looked at up to the time of day the symptom usually began.
 */
export function patternFor(
  x: Pick<ExportInput, 'symptoms' | 'meals' | 'intakes' | 'doseDays'>,
  label: string,
  window: WindowId,
  now: number,
): Pattern {
  const w = WINDOWS.find((v) => v.id === window)!.ms;
  const boutTimes = boutsOf(x, label, now);
  const exposures = exposuresOf(x);
  const boutDays = new Set(boutTimes.map(dayKey));
  const since = startOfDay(now - LOOK_DAYS * DAY);

  // The time of day it usually began: the median minute.
  const minutes = boutTimes.map((t) => (t - startOfDay(t)) / 60_000).sort((a, b) => a - b);
  const median = minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)] : 12 * 60;

  const otherDays = (logged: Set<string>) => {
    const points: number[] = [];
    for (let d = since; d <= now; d += DAY) {
      const day = startOfDay(d + HOUR);
      const key = dayKey(day);
      const at = day + median * 60_000;
      if (at <= now && logged.has(key) && !boutDays.has(key)) points.push(at);
    }
    return points;
  };
  const foodPoints = otherDays(new Set(x.meals.filter((m) => m.items.some((i) => counts(i.plan_state))).map((m) => m.day)));
  // A medicine day is one with doses due, or with any dose ticked: a
  // medicine added after the fact has ticks on days its schedule never
  // covered, and those days still say what was taken (15 Oct 2026, on the
  // built app: every medicine read "0 of 0" other days).
  const medPoints = otherDays(
    new Set([
      ...(x.doseDays ?? []).filter((d) => d.taken + d.skipped + d.missed > 0).map((d) => d.day),
      ...(x.intakes ?? []).map((i) => dayKey(i.at)),
    ]),
  );

  const within = (e: Exposure, t: number) => e.at <= t && e.at > t - w;
  const bouts: Bout[] = boutTimes.map((began) => ({
    began,
    before: exposures
      .filter((e) => within(e, began))
      .sort((a, b) => b.at - a.at)
      .map((e) => ({ name: e.name, kind: e.kind, at: e.at })),
  }));

  const keys = new Map<string, Exposure>();
  for (const b of boutTimes) for (const e of exposures) if (within(e, b) && !keys.has(e.key)) keys.set(e.key, e);
  const few = boutTimes.length < MIN_BOUTS;

  const raw = [...keys.values()].map((e) => {
    const mine = exposures.filter((x2) => x2.key === e.key);
    const points = e.kind === 'food' ? foodPoints : medPoints;
    const dates = boutTimes
      .map((began) => ({ began, at: mine.filter((x2) => within(x2, began)).sort((a, b) => b.at - a.at)[0]?.at }))
      .filter((d): d is { began: number; at: number } => d.at !== undefined);
    const other = points.filter((t) => mine.some((x2) => within(x2, t))).length;
    return { name: e.name, kind: e.kind, before: dates.length, of: boutTimes.length, other, ofOther: points.length, dates };
  });
  // Allowing for how many were checked: the more foods looked at, the more
  // one will look unusual by chance alone (Bonferroni).
  const checked = Math.max(1, raw.length);
  const items: PatternItem[] = raw.map((r) => {
    const p = Math.min(1, fisherAtLeast(r.before, r.of, r.other, r.ofOther) * checked);
    const rateBefore = r.before / r.of;
    const rateOther = r.ofOther ? r.other / r.ofOther : 0;
    const tag: Tag = few
      ? 'few'
      : r.before >= STANDS_OUT.minBefore && rateBefore >= STANDS_OUT.minRatio * rateOther && p < STANDS_OUT.maxP && r.ofOther > 0
        ? 'stands-out'
        : rateBefore > rateOther
          ? 'chance'
          : 'usual';
    return { ...r, tag, p };
  });
  const rank: Record<Tag, number> = { 'stands-out': 0, chance: 1, usual: 2, few: 3 };
  items.sort(
    (a, b) => rank[a.tag] - rank[b.tag] || b.before / b.of - (b.ofOther ? b.other / b.ofOther : 0) - (a.before / a.of - (a.ofOther ? a.other / a.ofOther : 0)) || a.name.localeCompare(b.name),
  );

  return { label, window, bouts, foodDays: foodPoints.length, medicineDays: medPoints.length, few, items };
}

/** The window nearest a number of hours, for a lookup that asks in hours. */
export function windowForHours(hours: number): WindowId {
  if (hours <= 12) return '12h';
  if (hours <= 24) return '24h';
  if (hours <= 48) return '48h';
  if (hours <= 7 * 24) return '1w';
  return '1m';
}

/** Days of record a pattern needs: the month, and the window before its first day. */
export const daysNeeded = (window: WindowId) => LOOK_DAYS + Math.ceil(WINDOWS.find((v) => v.id === window)!.ms / DAY) + 1;

/** In words, for the screen and the lookup alike. */
export const TAG_WORDS: Record<Tag, string> = {
  'stands-out': 'Stands out',
  chance: 'Could be chance',
  usual: 'No more than usual',
  few: 'Too few to tell',
};

/** Words too common to mean two dishes have something in common. */
const NOT_SHARED = new Set(['and', 'with', 'the', 'of', 'in', 'aur', 'ka', 'ki', 'ke', 'wala', 'wali', 'mg', 'tablet', 'capsule']);

/**
 * Words found in more than one of these names: "paneer" in Paneer bhurji
 * and Paneer tikka masala. His call, 15 Oct 2026: dishes are never counted
 * together (a paneer bhurji is not a paneer tikka), but the word they share
 * is shown, in bold, so the likeness is seen and the counts stay honest.
 */
export function sharedWords(names: readonly string[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const name of new Set(names)) {
    for (const w of name.toLowerCase().split(/[^a-z\u0900-\u097f]+/)) {
      if (w.length < 3 || NOT_SHARED.has(w)) continue;
      seen.set(w, (seen.get(w) ?? new Set()).add(name));
    }
  }
  return new Set([...seen].filter(([, n]) => n.size > 1).map(([w]) => w));
}
