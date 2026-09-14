/**
 * The storage-layer test body. See harness.html for why this exists.
 *
 * Everything here goes through the same modules the app uses — scoped db
 * handles, migrations, the OPFS worker — so a failure means the app is broken,
 * not the test.
 */

import { initDb, query, run as sql } from '../../src/db/client';
import { ProfileScopeError, ScopeError, scopedDb } from '../../src/db/scope';
import {
  createProfile,
  initProfiles,
  listProfiles,
  setActiveProfile,
  PRIMARY_PROFILE,
} from '../../src/profiles/store';
import { activeProfile } from '../../src/lib/active-profile';
import { importPersonalFoods } from '../../src/domain/import';
import { matchFood } from '../../src/domain/foods';
import { draftFromText, saveMeal, mealsOn, itemsFor } from '../../src/domain/meals';
import { portionsFor, resolveFor } from '../../src/domain/portions';
import { collectFacts, renderSlice } from '../../src/domain/state';

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  results.push({ name, ok, detail });
}
function step(s: string) {
  console.log(`--- ${s}`);
}
function near(name: string, actual: number, expected: number, tol = 0.6) {
  check(name, Math.abs(actual - expected) <= tol, `${actual} vs ${expected}`);
}

const SHEET = [
  'Meal/Ingredient,Quantity (Numeric eg: 1.0),Measure (String),Net weight (g),Calories (Kcal),Protein (g),Fats (g),Carbs (g),Fiber (g)',
  'Dal tadka,1,katori,150,176,8.4,6.2,21.5,5.1',
  'Dal tadka,1,bowl,250,293,14,10.3,35.8,8.5',
  'Roti,1,piece,40,104,3.1,0.4,20.6,3.2',
  '"Curd, plain",1,katori,150,90,5.1,4.9,6.3,0',
].join('\n');

async function main() {
  step('initDb');
  const info = await initDb();
  check(`schema migrated to v4 (got v${info.version}, ${info.mode})`, info.version >= 4);

  // A fresh database each run — this harness must not depend on leftovers.
  // Raw client, not a scoped handle: wiping is not an agent action, and the
  // profile guard would (correctly) refuse an unfiltered DELETE.
  for (const t of ['meal_items', 'meals', 'food_portions', 'custom_foods', 'food_aliases']) {
    await sql(`DELETE FROM ${t}`);
  }
  await sql('DELETE FROM profiles WHERE id != ?', [PRIMARY_PROFILE]);

  step('initProfiles');
  const { active } = await initProfiles();
  check('starts on the primary profile', active === PRIMARY_PROFILE, active);

  // ---- import ----------------------------------------------------------
  step('import');
  const report = await importPersonalFoods(SHEET);
  check('3 dishes created', report.dishesCreated === 3, String(report.dishesCreated));
  check('4 portions saved', report.portionsSaved === 4, String(report.portionsSaved));
  check('no unusable rows', report.issues.length === 0, JSON.stringify(report.issues));

  const dal = await matchFood('dal tadka');
  check('dal matches after import', !!dal, dal?.food.name);
  near('dal stored per-100g', dal?.food.energy_kcal ?? 0, 117, 1);

  const anchors = dal ? await portionsFor(dal.food.id) : [];
  check('dal has both anchors', anchors.length === 2, String(anchors.length));
  check('katori is the default', anchors.find((a) => a.is_default)?.measure === 'katori');

  // ---- elastic resolution through the database -------------------------
  const id = dal!.food.id;
  near('1 katori', (await resolveFor(id, 1, 'katori')).grams, 150);
  near('1.5 katori', (await resolveFor(id, 1.5, 'katori')).grams, 225);
  near('1 bowl', (await resolveFor(id, 1, 'bowl')).grams, 250);
  const cup = await resolveFor(id, 1, 'cup');
  near('1 cup, never in the sheet', cup.grams, 240);
  check('cup came from density', cup.basis === 'density', cup.basis);

  // ---- drafting from text ----------------------------------------------
  step('draft');
  const draft = await draftFromText('1.5 katori dal tadka, 2 roti, 1 katori curd');
  check('three items parsed', draft.length === 3, String(draft.length));
  check('all matched locally', draft.every((d) => d.food !== null));

  const d0 = draft[0];
  near('dal portion', d0.grams, 225);
  near('dal kcal scales with it', d0.energy_kcal ?? 0, 264, 3);
  check('and says where it came from', d0.portionMeasured && d0.basis === 'anchor', d0.basis);

  const d1 = draft[1];
  near('"2 roti" is 80g, not 200g', d1.grams, 80);
  near('roti kcal', d1.energy_kcal ?? 0, 208, 3);
  check('roti used its default portion', d1.basis === 'default', d1.basis);

  // ---- saving and reading back ------------------------------------------
  step('saveMeal');
  await saveMeal(draft,{ rawText: 'test', mealType: 'lunch' });
  const meals = await mealsOn();
  const items = await itemsFor(meals.map((m) => m.id));
  check('meal saved with 3 items', items.length === 3, String(items.length));
  check(
    'net weight persisted',
    items.every((i) => (i.net_weight_g ?? 0) > 0),
    JSON.stringify(items.map((i) => i.net_weight_g)),
  );

  // ---- what the Doctor sees ---------------------------------------------
  step('slice');
  const slice = renderSlice(await collectFacts());
  check('slice names the dish', slice.includes('Dal tadka') || slice.includes('dal tadka'), slice);
  check('slice carries the weight', /\(\d+g\)/.test(slice), slice);

  // ---- the boundary still holds -----------------------------------------
  let threw = false;
  try {
    await scopedDb('pharmacist').query('SELECT * FROM food_portions');
  } catch (e) {
    threw = e instanceof ScopeError;
  }
  check('pharmacist cannot read food_portions', threw);

  let threwWrite = false;
  try {
    await scopedDb('pharmacist').insert('food_portions', { food_id: 'x', measure: 'katori', net_weight_g: 1 });
  } catch (e) {
    threwWrite = e instanceof ScopeError;
  }
  check('pharmacist cannot write food_portions', threwWrite);

  // ---- re-import is idempotent ------------------------------------------
  const again = await importPersonalFoods(SHEET);
  check('re-import creates nothing new', again.dishesCreated === 0, String(again.dishesCreated));
  const rows = await query<{ n: number }>('SELECT COUNT(*) AS n FROM food_portions WHERE deleted_at IS NULL');
  check('and does not duplicate portions', Number(rows[0].n) === 4, String(rows[0].n));

  // ---- two people --------------------------------------------------------
  // The separation that matters: her meals are not his, but the dish she
  // defines is immediately available to him.
  step('profiles');
  const partner = await createProfile('Partner');
  check('two profiles now', (await listProfiles()).length === 2);

  const mineBefore = (await mealsOn()).length;
  check('primary has the meal just logged', mineBefore === 1, String(mineBefore));

  await setActiveProfile(partner);
  check('switched', activeProfile() === partner);

  const hers = await mealsOn();
  check('partner starts with an empty day', hers.length === 0, String(hers.length));

  const herFacts = await collectFacts();
  check('and an empty slice', herFacts.mealsToday.length === 0, JSON.stringify(herFacts.mealsToday));
  check('with no meals leaking in', herFacts.todayTotals.energy === 0, String(herFacts.todayTotals.energy));

  // The food library is deliberately NOT separated.
  const herDal = await matchFood('dal tadka');
  check('the food table is shared', !!herDal, herDal?.food.name);
  const herPortion = await resolveFor(herDal!.food.id, 1, 'katori');
  check('including its portions', herPortion.basis === 'anchor', herPortion.basis);

  await saveMeal(await draftFromText('1 katori curd'), { mealType: 'snack' });
  check('partner can log', (await mealsOn()).length === 1);

  // Rows are stamped without any caller having to remember to.
  const stamped = await query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM meals WHERE profile_id = ?',
    [partner],
  );
  check('insert stamped the profile automatically', Number(stamped[0].n) === 1, String(stamped[0].n));

  await setActiveProfile(PRIMARY_PROFILE);
  const back = await mealsOn();
  check("and the partner's meal is not in his day", back.length === 1, String(back.length));

  const totalMeals = await query<{ n: number }>('SELECT COUNT(*) AS n FROM meals WHERE deleted_at IS NULL');
  check('both rows are really there', Number(totalMeals[0].n) === 2, String(totalMeals[0].n));

  // ---- the guard that makes the above hard to break ---------------------
  let profileThrew = false;
  try {
    await scopedDb('nutritionist').query('SELECT * FROM meals WHERE deleted_at IS NULL');
  } catch (e) {
    profileThrew = e instanceof ProfileScopeError;
  }
  check('an unfiltered read of a per-person table throws', profileThrew);

  let sharedOk = true;
  try {
    await scopedDb('nutritionist').query('SELECT id FROM custom_foods LIMIT 1');
  } catch {
    sharedOk = false;
  }
  check('but a shared table reads freely', sharedOk);
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    const text =
      results
        .map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`)
        .join('\n') + `\n\n${results.length - failed.length} passed, ${failed.length} failed`;
    (document.getElementById('out') as HTMLElement).textContent = text;
    (window as unknown as Record<string, unknown>).__done = { failed: failed.length, text };
  })
  .catch((e: Error) => {
    (document.getElementById('out') as HTMLElement).textContent = `THREW: ${e.message}\n${e.stack}`;
    (window as unknown as Record<string, unknown>).__done = {
      failed: 1,
      text: `THREW: ${e.message}\n${e.stack}`,
    };
  });
