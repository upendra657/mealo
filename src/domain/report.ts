/**
 * The "For human" report: a period of someone's records, worked out for
 * reading.
 *
 * It is built from the very same collected input as the "For AI" file
 * (`collectExport`), so the two cannot disagree about what was eaten or
 * taken: one reader, two ways of laying it out. Nothing here asks a model.
 * Every figure is arithmetic on what the person logged, which is what lets
 * the report exist for someone with no key at all.
 *
 * Pure: the screen draws what this returns and decides nothing.
 */

import type { ExportDoseDay, ExportInput, ExportMeal, Scope } from './export';
import { dateLabel, periodLabel } from './export';
import { counts } from './plan';
import { standing } from './targets';

export type MacroKey = 'energy_kcal' | 'protein_g' | 'fat_g' | 'carbs_g' | 'fibre_g';

export const MACROS: readonly { key: MacroKey; label: string; unit: string }[] = [
  { key: 'energy_kcal', label: 'Calories', unit: 'Cal' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g' },
  { key: 'fat_g', label: 'Fats', unit: 'g' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g' },
];

export type FoodReport = {
  daysLogged: number;
  /** Over logged days only. A day with nothing logged is missing data. */
  averages: { key: MacroKey; label: string; unit: string; avg: number | null; target: number | null }[];
  /** Logged days inside the calorie target, by the app's own rule; null with no target. */
  withinTarget: { days: number; of: number } | null;
  /** One entry per day of the period. `kcal` is null where nothing was logged. */
  perDay: { day: string; label: string; kcal: number | null }[];
  /** The dishes that supplied most of each figure. */
  behind: { key: MacroKey; label: string; unit: string; dishes: { name: string; amount: number; share: number }[] }[];
  /** When meals are eaten: each slot used, with how often and how much. */
  slots: { slot: string; meals: number; avgKcal: number }[];
  /** Items logged ahead and never ticked, and items marked skipped. Counted in no total. */
  planned: number;
  skipped: number;
};

export type MedsReport = {
  taken: number;
  skipped: number;
  missed: number;
  /** Today's doses not yet answered. Never counted as missed. */
  pending: number;
  due: number;
  perDay: ExportDoseDay[];
  /** Doses not taken, gathered by medicine and time of day. */
  notTaken: { medicine: string; time: string; skipped: number; missed: number }[];
  medicines: { name: string; schedule: string; stoppedOn: string | null; sickness: string | null }[];
  episodes: { name: string; from: string; to: string }[];
};

export type BodyReport = {
  weights: { day: string; label: string; kg: number }[];
  /** Last reading minus first, or null with fewer than two. */
  change: number | null;
  goalWeightKg: number | null;
  /** Over days with a burn recorded. */
  avgBurn: number | null;
  burnDays: number;
  goalBurnKcal: number | null;
  symptoms: { day: string; text: string; resolved: boolean }[];
};

export type HumanReport = {
  scope: Scope;
  title: string;
  period: string;
  days: number;
  food: FoodReport | null;
  meds: MedsReport | null;
  body: BodyReport | null;
};

const TITLES: Record<Scope, string> = { meals: 'Meals report', meds: 'Medicines report', full: 'Full report' };

/** How many dishes are named behind each figure. Past three the list stops being a finding. */
const TOP = 3;

function foodReport(x: ExportInput): FoodReport {
  const byDay = new Map<string, ExportMeal[]>();
  for (const m of x.meals) byDay.set(m.day, [...(byDay.get(m.day) ?? []), m]);

  const eatenOn = (day: string) => (byDay.get(day) ?? []).flatMap((m) => m.items).filter((i) => counts(i.plan_state));
  const sum = (day: string, key: MacroKey) => eatenOn(day).reduce((s, i) => s + (i[key] ?? 0), 0);
  const logged = x.days.filter((d) => eatenOn(d).length > 0);

  const averages = MACROS.map((m) => ({
    ...m,
    avg: logged.length ? logged.reduce((s, d) => s + sum(d, m.key), 0) / logged.length : null,
    target: x.targets[m.key],
  }));

  const target = x.targets.energy_kcal;
  const withinTarget = target && logged.length
    ? { days: logged.filter((d) => standing(sum(d, 'energy_kcal'), target, true).standing === 'good').length, of: logged.length }
    : null;

  const eaten = x.meals.flatMap((m) => m.items).filter((i) => counts(i.plan_state));
  const behind = MACROS.map((m) => {
    const total = eaten.reduce((s, i) => s + (i[m.key] ?? 0), 0);
    const byDish = new Map<string, number>();
    for (const i of eaten) byDish.set(i.name, (byDish.get(i.name) ?? 0) + (i[m.key] ?? 0));
    const dishes = [...byDish]
      .filter(([, amount]) => amount > 0)
      // By amount, then by name, so two dishes that tie come out the same way every time.
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP)
      .map(([name, amount]) => ({ name, amount, share: total > 0 ? amount / total : 0 }));
    return { ...m, dishes };
  });

  // A slot counts once per meal eaten in it, and a meal with only planned
  // items in it was not eaten.
  const slotOrder: string[] = [];
  const bySlot = new Map<string, number[]>();
  for (const m of [...x.meals].sort((a, b) => a.at - b.at)) {
    const items = m.items.filter((i) => counts(i.plan_state));
    if (items.length === 0) continue;
    if (!bySlot.has(m.slot)) slotOrder.push(m.slot);
    bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), items.reduce((s, i) => s + (i.energy_kcal ?? 0), 0)]);
  }
  const SLOT_RANK = ['Breakfast', 'Morning snack', 'Lunch', 'Evening snack', 'Dinner'];
  const rank = (s: string) => (SLOT_RANK.indexOf(s) === -1 ? SLOT_RANK.length : SLOT_RANK.indexOf(s));
  const slots = slotOrder
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((slot) => {
      const kcals = bySlot.get(slot)!;
      return { slot, meals: kcals.length, avgKcal: kcals.reduce((s, k) => s + k, 0) / kcals.length };
    });

  const all = x.meals.flatMap((m) => m.items);
  return {
    daysLogged: logged.length,
    averages,
    withinTarget,
    perDay: x.days.map((day) => ({ day, label: dateLabel(day), kcal: eatenOn(day).length ? sum(day, 'energy_kcal') : null })),
    behind,
    slots,
    planned: all.filter((i) => i.plan_state === 'planned').length,
    skipped: all.filter((i) => i.plan_state === 'skipped').length,
  };
}

function medsReport(x: ExportInput): MedsReport {
  const total = (k: 'taken' | 'skipped' | 'missed' | 'pending') => x.doseDays.reduce((s, d) => s + d[k], 0);
  const groups = new Map<string, { medicine: string; time: string; skipped: number; missed: number }>();
  for (const n of x.notTaken) {
    const id = `${n.medicine}\u0000${n.time}`;
    const g = groups.get(id) ?? { medicine: n.medicine, time: n.time, skipped: 0, missed: 0 };
    g[n.state]++;
    groups.set(id, g);
  }
  return {
    taken: total('taken'),
    skipped: total('skipped'),
    missed: total('missed'),
    pending: total('pending'),
    due: total('taken') + total('skipped') + total('missed') + total('pending'),
    perDay: x.doseDays,
    notTaken: [...groups.values()].sort((a, b) => b.skipped + b.missed - (a.skipped + a.missed) || a.medicine.localeCompare(b.medicine)),
    medicines: x.medicines.map((m) => ({
      name: m.strength ? `${m.name} ${m.strength}` : m.name,
      schedule: m.schedule,
      stoppedOn: m.endedOn,
      sickness: m.sickness,
    })),
    episodes: x.episodes.map((e) => ({ name: e.name, from: e.from, to: e.recoveredOn ?? e.to })),
  };
}

function bodyReport(x: ExportInput): BodyReport {
  const weights = [...x.weights].sort((a, b) => a.day.localeCompare(b.day));
  return {
    weights: weights.map((w) => ({ ...w, label: dateLabel(w.day) })),
    change: weights.length >= 2 ? weights[weights.length - 1].kg - weights[0].kg : null,
    goalWeightKg: x.goalWeightKg,
    avgBurn: x.burns.length ? x.burns.reduce((s, b) => s + b.kcal, 0) / x.burns.length : null,
    burnDays: x.burns.length,
    goalBurnKcal: x.goalBurnKcal,
    symptoms: [...x.symptoms]
      .sort((a, b) => a.at - b.at)
      .map((s) => {
        const d = new Date(s.at);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { day: dateLabel(day), text: s.text, resolved: s.resolvedAt != null };
      }),
  };
}

/** The report for a period. Each part is null when the scope leaves it out. */
export function humanReport(x: ExportInput): HumanReport {
  return {
    scope: x.scope,
    title: TITLES[x.scope],
    period: periodLabel(x.days),
    days: x.days.length,
    food: x.scope !== 'meds' ? foodReport(x) : null,
    meds: x.scope !== 'meals' ? medsReport(x) : null,
    body: x.scope === 'full' ? bodyReport(x) : null,
  };
}

/**
 * Whether a typed request wants the file for another AI and not the report
 * to read. Reading is the default: it is what "my food report" means to
 * most people, and the file has to be asked for by what it is for.
 */
export function wantsAiFile(text: string): boolean {
  return /\b(?:for (?:an? |another |the )?ai|for (?:chatgpt|claude|gemini|copilot|an? llm)|to (?:give|upload|paste|share|send) (?:to|into|with) (?:an? |another )?(?:ai|chatgpt|claude|gemini)|markdown|\.md|export|text file|as a file|a file)\b/i.test(text);
}
