/**
 * The reads and the one write behind a plan made in Ask Mealo.
 *
 * The choosing is in `mealplan.ts` and is pure. This file fetches what it
 * needs — the last four weeks of meals, the person's own dishes, what the day
 * already holds — prices each past meal at the dish's numbers as they stand
 * today, and saves a plan the person confirmed as ordinary planned meals, the
 * same rows Track meals writes when a dish is logged ahead of its time.
 */

import { localDayKey } from './day';
import { listCustomFoods, scaleMacros, type Food } from './foods';
import {
  aimLine,
  belowFloor,
  rankDays,
  usualOptions,
  USUAL_DAYS,
  type Aim,
  type Five,
  type Option,
  type PastMeal,
  type PlanAsk,
  type SlotOptions,
} from './mealplan';
import { itemsFor, mealsBetween, mealsOn, saveMeal, type DraftItem } from './meals';
import { counts, isPlanned, plansAt, stampFor } from './plan';
import { resolveFor } from './portions';
import { normaliseSlot, type SlotId } from './slots';
import { loadTargets } from './targets';

const NONE: Five = { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, fibre_g: 0 };
const sum = (rows: { energy_kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null; fibre_g: number | null }[]): Five =>
  rows.reduce<Five>(
    (t, r) => ({
      energy_kcal: t.energy_kcal + (r.energy_kcal ?? 0),
      protein_g: t.protein_g + (r.protein_g ?? 0),
      fat_g: t.fat_g + (r.fat_g ?? 0),
      carbs_g: t.carbs_g + (r.carbs_g ?? 0),
      fibre_g: t.fibre_g + (r.fibre_g ?? 0),
    }),
    NONE,
  );

/** Local midnight `ahead` days from today. */
export function dayAhead(ahead: number, now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ahead);
  return d.getTime();
}

/**
 * The meals of the last four weeks that can be planned again.
 *
 * Eaten only: a plan that was never ticked is not something the person
 * usually eats. And only meals made wholly of their own live dishes. A meal
 * with one dish since deleted, or one line the food table never matched,
 * cannot be offered whole, and offering the rest of it would be a meal
 * nobody ate.
 */
export async function pastMeals(now = new Date()): Promise<{ meals: PastMeal[]; foods: Map<string, Food> }> {
  const foods = new Map((await listCustomFoods()).map((f) => [f.id, f]));
  const rows = await mealsBetween(dayAhead(-USUAL_DAYS, now), now.getTime());
  const meals: PastMeal[] = [];
  for (const { meal, items } of rows) {
    const eaten = items.filter((i) => counts(i.plan_state));
    if (eaten.length === 0) continue;
    if (!eaten.every((i) => i.food_id !== null && foods.has(i.food_id))) continue;
    meals.push({
      slot: normaliseSlot(meal.meal_type),
      at: meal.eaten_at,
      day: localDayKey(meal.eaten_at),
      dishes: eaten.map((i) => ({
        foodId: i.food_id as string,
        name: foods.get(i.food_id as string)!.name,
        quantity: i.quantity,
        unit: i.unit,
        grams: i.net_weight_g,
      })),
    });
  }
  return { meals, foods };
}

/**
 * A past meal as rows ready to save, at today's numbers.
 *
 * The amounts are the ones logged; the grams and the five figures are worked
 * out again from the dish as it stands, through the same resolver the log
 * screen uses. A dish whose calories were corrected last week is planned at
 * the corrected figure, not at what the old entry happened to store.
 */
async function draftOf(option: Option, foods: Map<string, Food>): Promise<DraftItem[]> {
  const out: DraftItem[] = [];
  for (const d of option.dishes) {
    const food = foods.get(d.foodId)!;
    // An entry logged by weight alone has no measure to resolve; its grams
    // are the amount.
    const byWeight = d.quantity == null || d.unit == null;
    const res = await resolveFor(food.id, byWeight ? d.grams : d.quantity, byWeight ? 'g' : d.unit);
    out.push({
      label: food.name,
      quantity: byWeight ? d.grams : d.quantity,
      unit: res.measure,
      food,
      grams: res.grams,
      basis: res.basis,
      portionNote: res.note,
      portionMeasured: res.measured,
      matchScore: 1,
      // 'direct': the dish was picked by its id, not matched from words, so
      // saving it must not teach the matcher an alias.
      source: 'direct',
      ...scaleMacros(food, res.grams),
    });
  }
  return out;
}

export type PlanMeal = { slot: SlotId; items: DraftItem[]; totals: Five; times: number };
export type PlanChoice = { meals: PlanMeal[]; totals: Five; dayTotals: Five; line: string | null };
export type DayPlan = {
  dayStart: number;
  aim: Aim;
  /** Slots left alone because the day already has something in them. */
  kept: SlotId[];
  /** What those slots add up to, eaten or planned. */
  already: Five;
  /** Nearest the aim first. Empty when there is nothing to plan from. */
  choices: PlanChoice[];
  /** Why `choices` is empty, in words for the card. */
  empty: string | null;
  /** How many of the last four weeks' days had a plannable meal. */
  daysRead: number;
};

/**
 * Build the choices for one day.
 *
 * A slot the day already has something in is left alone and counted: asking
 * for a plan on a day with lunch decided is asking for the rest of the day.
 * Today, a slot whose time has passed is not planned either, by the same
 * clock rule Track meals uses to tell a plan from a meal.
 */
export async function buildPlan(ask: PlanAsk, now = new Date()): Promise<DayPlan> {
  const dayStart = dayAhead(ask.ahead, now);
  const targets = await loadTargets();
  const aim: Aim = {
    protein: ask.protein ?? targets.protein_g ?? null,
    // The caller has already stopped a figure under the floor with the
    // gate's message. Should one arrive anyway, it is not planned to.
    kcal: (belowFloor(ask) ? null : ask.kcal) ?? targets.energy_kcal ?? null,
    proteinAsked: ask.protein !== null,
  };

  const onDay = await mealsOn(dayStart);
  const dayItems = (await itemsFor(onDay.map((m) => m.id))).filter((i) => counts(i.plan_state) || isPlanned(i.plan_state));
  const slotOf = new Map(onDay.map((m) => [m.id, normaliseSlot(m.meal_type)]));
  const kept = [...new Set(dayItems.map((i) => slotOf.get(i.meal_id)!))];
  const already = sum(dayItems);

  const { meals, foods } = await pastMeals(now);
  const daysRead = new Set(meals.map((m) => m.day)).size;
  const usual: SlotOptions[] = usualOptions(meals);
  const open = usual.filter((s) => !kept.includes(s.slot) && plansAt(dayStart, s.slot, now));

  const base = { dayStart, aim, kept, already, daysRead };
  if (usual.length === 0) {
    return {
      ...base,
      choices: [],
      empty: `Not enough to plan from yet. A plan is built from meals you logged in the last ${USUAL_DAYS} days, and a meal time needs at least three days of them.`,
    };
  }
  if (open.length === 0) {
    return { ...base, choices: [], empty: 'Nothing left to plan on that day: every meal time you usually log already has something in it, or has passed.' };
  }

  const priced = new Map<Option, { items: DraftItem[]; totals: Five }>();
  for (const s of open) {
    for (const o of s.options) {
      const items = await draftOf(o, foods);
      priced.set(o, { items, totals: sum(items) });
    }
  }
  const days = rankDays(open, (o) => priced.get(o)!.totals, aim, already);
  return {
    ...base,
    empty: null,
    choices: days.map((d) => ({
      meals: d.picks.map((p) => ({ slot: p.slot, items: priced.get(p.option)!.items, totals: p.totals, times: p.option.times })),
      totals: d.totals,
      dayTotals: d.dayTotals,
      line: aimLine(d.dayTotals, aim),
    })),
  };
}

/**
 * Save a confirmed plan: one planned meal per slot, on the day.
 *
 * Whether each is a plan is decided here, at the tap, against the clock
 * then, as the log screen decides it. Returns the meal ids so the receipt
 * can be written from the rows read back and Undo can remove exactly these.
 */
export async function savePlan(dayStart: number, choice: PlanChoice, said: string | null, now = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (const m of choice.meals) {
    ids.push(
      await saveMeal(m.items, {
        rawText: said,
        mealType: m.slot,
        eatenAt: stampFor(dayStart, now),
        planned: plansAt(dayStart, m.slot, now),
      }),
    );
  }
  return ids;
}
