/**
 * The made-up person the public demo opens on.
 *
 * Everything here is invented: the dishes and their numbers, the meals, the
 * weights, the supplements, the symptoms. The numbers are plausible and were
 * measured by nobody; do not copy any of them into a real food table. The
 * app says so in a line across the top of every screen (`lib/demo.ts`).
 *
 * It is written through the app's own save functions, the ones the screens
 * call, so what a visitor sees is the app's real behaviour on real rows, and
 * a change to how a meal is saved cannot leave the demo showing something the
 * app would no longer produce. Three things those functions will not do are
 * done with a plain UPDATE afterwards, each because the function stamps
 * "now" and a history needs a past: when a symptom was noted, when a dose
 * was ticked, and the day a medicine was started. Nothing else is written
 * behind the app's back.
 *
 * Dates are counted back from the day the demo is first opened, so the three
 * weeks always end today.
 *
 * The same person every time: the choices come from a small seeded
 * generator, not Math.random, so the screens in the README are the screens a
 * visitor gets.
 */

import { run } from '../db/client';
import { kvGet, kvSet } from '../lib/kv';
import { PRIMARY_PROFILE, renameProfile } from '../profiles/store';
import { burnOn, recordBurn, setGoalBurn } from '../domain/burn';
import { addDays, medDay, scheduleOf } from '../domain/doses';
import { saveDishFromPortion } from '../domain/import';
import { listCustomFoods } from '../domain/foods';
import { draftFromText, mealsBetween, mealsOn, saveMeal } from '../domain/meals';
import { addMedicine, listActive, markDose, readMedsDay, type MedForm } from '../domain/medications';
import { logSymptom, openSymptoms } from '../domain/symptoms';
import { suggestLabel } from '../domain/symptomlabels';
import { saveTargets } from '../domain/targets';
import { recordWeight, setGoalWeight } from '../domain/weight';
import type { SlotId } from '../domain/slots';

const SEEDED = 'demo.seeded';
/** Set before the first row: the database was empty, and what is in it since is ours. */
const SEEDING = 'demo.seeding';
export const DEMO_NAME = 'Asha';
const DAYS_BACK = 21;

/** mulberry32: small, seeded, and the same in every browser. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One portion as a person would enter it: name, measure, its weight, then the five figures for that portion. */
const DISHES: [string, string, number, number, number, number, number, number][] = [
  ['Poha', 'katori', 150, 250, 5, 8, 40, 2.5],
  ['Upma', 'katori', 160, 230, 6, 7, 36, 3],
  ['Idli', 'piece', 40, 58, 2, 0.4, 12, 0.8],
  ['Sambar', 'katori', 150, 110, 5.5, 3, 16, 4],
  ['Masala dosa', 'piece', 180, 330, 7, 11, 50, 4],
  ['Boiled egg', 'piece', 50, 78, 6.3, 5.3, 0.6, 0],
  ['Masala chai', 'cup', 150, 95, 3, 3.5, 13, 0],
  ['Filter coffee', 'cup', 150, 85, 3, 3, 11, 0],
  ['Banana', 'piece', 110, 98, 1.2, 0.3, 25, 2.8],
  ['Almonds', 'piece', 1.2, 7, 0.25, 0.6, 0.25, 0.15],
  ['Roti', 'piece', 40, 104, 3.1, 0.4, 20.6, 3.2],
  ['Dal tadka', 'katori', 150, 176, 8.4, 6.2, 21.5, 5.1],
  ['Jeera rice', 'katori', 150, 215, 4, 4.5, 39, 1],
  ['Curd', 'katori', 150, 90, 5.1, 4.9, 6.3, 0],
  ['Rajma', 'katori', 150, 190, 9.5, 5, 27, 8],
  ['Aloo gobi', 'katori', 150, 160, 3.5, 8, 18, 4],
  ['Mixed veg sabzi', 'katori', 150, 130, 3.5, 6.5, 14, 4.5],
  ['Chicken curry', 'katori', 200, 310, 29, 17, 8, 1.5],
  ['Paneer bhurji', 'katori', 150, 300, 19, 22, 7, 1.5],
  ['Khichdi', 'katori', 200, 240, 9, 5, 39, 4],
  ['Roasted chana', 'katori', 50, 185, 10, 3, 29, 8.5],
  ['Buttermilk', 'glass', 250, 60, 3, 1.5, 7, 0],
];

/** What this person eats, by meal time, as they would type it. First is most usual. */
const MEALS: Record<Exclude<SlotId, 'other'>, { hour: number; often: number; said: string[] }> = {
  breakfast: { hour: 8.5, often: 0.95, said: ['1 katori poha, 1 cup masala chai', '3 piece idli, 1 katori sambar', '1 katori upma, 1 cup filter coffee', '2 piece boiled egg, 2 piece roti', '1 piece masala dosa, 1 katori sambar'] },
  msnack: { hour: 11, often: 0.45, said: ['1 piece banana', '10 piece almonds'] },
  lunch: { hour: 13.25, often: 0.95, said: ['1 katori dal tadka, 1 katori jeera rice, 1 katori curd', '1 katori rajma, 1 katori jeera rice', '2 piece roti, 1 katori aloo gobi, 1 katori curd', '1 katori chicken curry, 2 piece roti'] },
  esnack: { hour: 17, often: 0.6, said: ['1 katori roasted chana', '1 cup masala chai', '1 glass buttermilk'] },
  dinner: { hour: 20.25, often: 0.9, said: ['2 piece roti, 1 katori paneer bhurji', '1 katori khichdi, 1 katori curd', '1 katori chicken curry, 1 katori jeera rice', '2 piece roti, 1 katori mixed veg sabzi, 1 katori dal tadka'] },
};
/** Days back with nothing logged at all: a record with no gaps would not look like anyone's. */
const BLANK_DAYS = new Set([9, 16]);

const midnight = (daysAgo: number, now: Date) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
};

/** Local midnight of a day `ahead` of today. */
const dayAt = (ahead: number, now: Date) => midnight(-ahead, now);

let once: Promise<boolean> | null = null;
/**
 * Write the demo's person, if this browser has not got one yet.
 *
 * Once per page (StrictMode mounts twice in development), and only ever into
 * a database that had no dishes and no meals when it began. A real database
 * opened by a demo build, which on a developer's machine is one mistyped
 * port away, is left exactly as it is.
 */
export function seedDemo(now = new Date()): Promise<boolean> {
  once ??= write(now);
  return once;
}

/**
 * Each step can be run again and write nothing it has already written.
 *
 * The first version could not, and the first run of it showed why it had
 * to: a reload two seconds in left seven dishes and no meals, and the next
 * open, finding a database that was no longer empty, took it for somebody's
 * data and left it like that for good. Now a second marker says "this
 * database was empty and the writing is ours", so an interrupted run is
 * picked up where it stopped.
 *
 * To land on the same person, every random draw is made whether or not its
 * row is written. Skipping a draw along with its row would shift every
 * choice after it.
 */
async function write(now: Date): Promise<boolean> {
  if (await kvGet<boolean>(SEEDED)) return false;
  if (!(await kvGet<boolean>(SEEDING))) {
    const anyMeals = (await mealsBetween(0, now.getTime() + 30 * 86_400_000)).length > 0;
    if (anyMeals || (await listCustomFoods()).length > 0) {
      // Somebody's data. Not ours to add to, now or on any later open.
      await kvSet(SEEDED, true);
      return false;
    }
    await kvSet(SEEDING, true);
  }
  const pick = seeded(20261011);

  await renameProfile(PRIMARY_PROFILE, DEMO_NAME);
  // Refuses a name it already has, so a second pass adds only what is missing.
  for (const [name, measure, netWeightG, energy, protein, fat, carbs, fibre] of DISHES) {
    await saveDishFromPortion({ name, quantity: 1, measure, netWeightG, energy, protein, fat, carbs, fibre });
  }
  await saveTargets({ energy_kcal: 1900, protein_g: 75, fat_g: 65, carbs_g: 240, fibre_g: 30 });

  // ---- three weeks of meals, ending now
  const rajmaDays: number[] = [];
  for (let ago = DAYS_BACK; ago >= 0; ago--) {
    if (BLANK_DAYS.has(ago)) continue;
    // By meal time, not by day: a run cut short at lunch has still to write dinner.
    const have = new Set((await mealsOn(midnight(ago, now))).map((m) => m.meal_type));
    for (const [slot, m] of Object.entries(MEALS) as [Exclude<SlotId, 'other'>, (typeof MEALS)['lunch']][]) {
      const at = midnight(ago, now) + Math.round((m.hour + (pick() - 0.5) * 0.6) * 3_600_000);
      const eaten = pick() < m.often;
      // Squared, so the first of each list comes up most: a usual breakfast.
      const said = m.said[Math.floor(pick() * pick() * m.said.length)];
      if (!eaten || at > now.getTime()) continue;
      if (slot === 'lunch' && said.includes('rajma')) rajmaDays.push(ago);
      if (!have.has(slot)) await saveMeal(await draftFromText(said), { rawText: said, mealType: slot, eatenAt: at });
    }
  }
  // Tomorrow, planned ahead, so the plan-ahead circles have something to show.
  if ((await mealsOn(dayAt(1, now))).length === 0) {
    for (const [slot, said] of [['lunch', '1 katori dal tadka, 1 katori jeera rice, 1 katori curd'], ['dinner', '2 piece roti, 1 katori paneer bhurji']] as const) {
      await saveMeal(await draftFromText(said), { rawText: said, mealType: slot, eatenAt: dayAt(1, now) + 12 * 3_600_000, planned: true });
    }
  }

  // ---- weight and burn. A second weight on a day replaces the first; a
  // second burn would be added to it, so that one is looked for.
  await setGoalWeight(70);
  await setGoalBurn(450);
  for (let ago = DAYS_BACK; ago >= 0; ago -= 3) {
    const kg = 71.4 + (ago / DAYS_BACK) * 1.2 + (pick() - 0.5) * 0.3;
    const at = midnight(ago, now) + 7.2 * 3_600_000;
    if (at <= now.getTime()) await recordWeight(Math.round(kg * 10) / 10, at);
  }
  for (let ago = DAYS_BACK; ago >= 1; ago--) {
    const skip = pick() < 0.2;
    const kcal = Math.round((300 + pick() * 260) / 10) * 10;
    if (skip || (await burnOn(midnight(ago, now)))) continue;
    await recordBurn(kcal, midnight(ago, now) + 19 * 3_600_000);
  }

  // ---- three supplements, started a month ago
  const today = medDay(now);
  const started = addDays(today, -30);
  const dose = (time_of_day: 'morning' | 'night') => ({ amount: 1, unit: 'tablet' as const, time_of_day, meal: 'after' as const });
  const have = new Set((await listActive()).map((m) => m.name));
  const supplement = async (f: MedForm) => {
    if (have.has(f.name)) return;
    const id = await addMedicine(f);
    await run('UPDATE medications SET started_on = ? WHERE id = ?', [started, id]);
    await run('UPDATE med_doses SET from_day = NULL WHERE medication_id = ?', [id]);
  };
  const always = { form: 'tablet' as const, ingredients: [], long_term: true, private: true };
  await supplement({ ...always, name: 'Vitamin B12', strength: '1500 mcg', doses: [dose('morning')], schedule: scheduleOf('daily', null, null) });
  await supplement({ ...always, name: 'Calcium + Vitamin D3', strength: '500 mg', doses: [dose('night')], schedule: scheduleOf('daily', null, null) });
  await supplement({ ...always, name: 'Vitamin D3', strength: '60000 IU', doses: [dose('morning')], schedule: scheduleOf('weekdays', String(now.getDay()), null) });

  // Two weeks of ticks: most taken, a few skipped, a few never answered.
  for (let ago = 14; ago >= 0; ago--) {
    const day = addDays(today, -ago);
    const plan = await readMedsDay(day, now);
    for (const g of plan.groups) {
      for (const p of g.doses) {
        const at = midnight(ago, now) + (g.time === 'morning' ? 8.2 : 21.7) * 3_600_000;
        const roll = pick();
        if (at > now.getTime() || roll > 0.94 || p.eventId) continue;
        const eventId = await markDose(p, day, roll > 0.86 ? 'skipped' : 'taken');
        await run('UPDATE intake_events SET taken_at = ? WHERE id = ?', [at, eventId]);
      }
    }
  }

  // ---- symptoms, last and all together: if any is there, all are. Bloating
  // after the rajma lunches, so "what was eaten before each time" has a
  // pattern to find; the app will still say it cannot show a cause.
  if ((await openSymptoms()).length === 0) {
    const noted = async (text: string, ago: number, hour: number, open: boolean) => {
      const at = midnight(ago, now) + hour * 3_600_000;
      if (at > now.getTime()) return;
      const id = await logSymptom(text, { label: suggestLabel(text) ?? undefined });
      await run('UPDATE symptoms SET noted_at = ?, resolved_at = ? WHERE id = ?', [at, open ? null : at + 5 * 3_600_000, id]);
    };
    for (const ago of rajmaDays.slice(0, 4)) await noted('Bloating after lunch', ago, 15.5, false);
    await noted('Headache in the evening', 11, 18.5, false);
    await noted('Acidity at night', 5, 22, false);
    // The one left open, and written last: its being there is what says the
    // others are.
    await noted('Feeling tired, slept badly', 1, 21.5, true);
  }

  await kvSet(SEEDED, true);
  return true;
}
