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
import { importPersonalFoods, saveDishFromPortion } from '../../src/domain/import';
import {
  customFoodIdBySlug,
  initFoodLibrary,
  matchFood,
  searchFoods,
  slugFor,
} from '../../src/domain/foods';
import { draftFromText, saveMeal, mealsOn, itemsFor } from '../../src/domain/meals';
import { portionsFor, resolveFor } from '../../src/domain/portions';
import { collectFacts, renderSlice } from '../../src/domain/state';
import { loadTargets, saveTargets, standing } from '../../src/domain/targets';
import {
  burnOn,
  dayStartOf,
  daysBetween,
  lastBefore,
  goalBurn,
  recordBurn,
  setBurnTotal,
  setGoalBurn,
} from '../../src/domain/burn';
import { readDay, contributors } from '../../src/domain/day';
import { guessSlot, normaliseSlot, SLOTS } from '../../src/domain/slots';
import { recentItems } from '../../src/domain/recents';
import { apply, collect } from '../../src/domain/librarysync';
import {
  createHousehold,
  joinHousehold,
  leaveHousehold,
  loadHousehold,
  open as openSealed,
  seal,
} from '../../src/lib/household';
import {
  addMedication,
  addMedicine,
  draftFromLibrary,
  draftFromMedicine,
  editMedicine,
  extendSickness,
  hideFromLibrary,
  ingredientsOf,
  listEpisodes,
  markDose,
  medicineDetail,
  readMedsDay,
  recoverSickness,
  runningEpisode,
  searchLibrary,
  sicknessRecord,
  startSickness,
  unaskedLongTerm,
  type MedForm,
} from '../../src/domain/medications';
import { addDays, medDay } from '../../src/domain/doses';
import { applyMeds, collectMeds } from '../../src/domain/medsync';
import { upgradeFromPrevious } from './upgrade';

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

/* Real rows from the user's own sheet, header and all. Using his numbers
   rather than invented ones means this test fails if the app ever stops
   reproducing figures he has independently measured. */
const SHEET = [
  'Meal/Ingredient,Quantity (Numeric eg: 1.0),Measure (String),Net weight (g/ml),Calories (Kcal),Protein (g),Fats (g),Carbs (g),Fiber (g)',
  'Dal Tadka,1,Katori,150,128,6.1,4.1,16.6,2.9',
  'Dal Tadka,1,Bowl,350,298,14.2,9.6,38.8,6.8',
  'Roti,1,Piece,35,85,3,0.4,17.3,2.7',
  'Set Curd,1,Cup,245,152,8.1,7.8,12.3,0',
].join('\n');

async function main() {
  // First, because it decides what file the worker opens. See upgrade.ts.
  step('upgrade');
  await upgradeFromPrevious(check);

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
  near('dal stored per-100g', dal?.food.energy_kcal ?? 0, 85.1, 0.5);

  const anchors = dal ? await portionsFor(dal.food.id) : [];
  check('dal has both anchors', anchors.length === 2, String(anchors.length));
  check('katori is the default', anchors.find((a) => a.is_default)?.measure === 'katori');

  // ---- elastic resolution through the database -------------------------
  const id = dal!.food.id;
  near('1 katori', (await resolveFor(id, 1, 'katori')).grams, 150);
  near('1.5 katori', (await resolveFor(id, 1.5, 'katori')).grams, 225);
  near('1 bowl — his own measured row', (await resolveFor(id, 1, 'bowl')).grams, 350);
  const cup = await resolveFor(id, 1, 'cup');
  near('1 cup, never in the sheet', cup.grams, 240);
  check('cup came from density', cup.basis === 'density', cup.basis);

  // ---- drafting from text ----------------------------------------------
  step('draft');
  const draft = await draftFromText('1.5 katori dal tadka, 2 roti, 1 cup set curd');
  check('three items parsed', draft.length === 3, String(draft.length));
  check('all matched locally', draft.every((d) => d.food !== null));

  const d0 = draft[0];
  near('dal portion', d0.grams, 225);
  near('dal kcal scales with it', d0.energy_kcal ?? 0, 191.5, 2);
  check('and says where it came from', d0.portionMeasured && d0.basis === 'anchor', d0.basis);

  const d1 = draft[1];
  near('"2 roti" is 70g, not 200g', d1.grams, 70);
  near('roti kcal', d1.energy_kcal ?? 0, 170, 2);
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
  check('slice names the dish', slice.toLowerCase().includes('dal tadka'), slice);
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

  // ---- v6: the library merge key ----------------------------------------
  //
  // This is what makes two phones share one library rather than two. Every
  // check here is the failure a sync would otherwise produce.
  step('slugs');
  {
    const nut = scopedDb('nutritionist');

    const imported = await nut.query<{ id: string; slug: string | null; share: number }>(
      `SELECT id, slug, share FROM custom_foods
        WHERE LOWER(name) = 'dal tadka' AND deleted_at IS NULL LIMIT 1`,
    );
    check('an imported dish gets a slug', imported[0]?.slug === 'dal tadka', String(imported[0]?.slug));
    check('and is not shared by default', Number(imported[0]?.share) === 0, String(imported[0]?.share));

    // A row as it would look coming from a pre-v6 database: no slug at all.
    await sql(
      `INSERT INTO custom_foods (id, name, per_unit, energy_kcal, updated_at, deleted_at)
       VALUES ('legacy-1', 'Aloo Gobi', '100g', 120, 111, NULL)`,
    );
    const back = await initFoodLibrary();
    check('backfill filled the old row', back.filled >= 1, String(back.filled));

    const legacy = await nut.query<{ slug: string; updated_at: number }>(
      "SELECT slug, updated_at FROM custom_foods WHERE id = 'legacy-1'",
    );
    check('with the right slug', legacy[0]?.slug === 'aloo gobi', String(legacy[0]?.slug));
    // The slug is the app catching up with itself, not an edit to the dish.
    // Bumping updated_at here would tell the first sync that every dish
    // changed at once and let a stale row win.
    check('without touching updated_at', Number(legacy[0]?.updated_at) === 111, String(legacy[0]?.updated_at));

    check('and it is findable by slug', (await customFoodIdBySlug('aloo gobi')) === 'legacy-1');

    // Two names that normalise alike are one dish. The slug did not create
    // that duplicate; it revealed it, and says so rather than silently
    // overwriting one with the other.
    await sql(
      `INSERT INTO custom_foods (id, name, per_unit, energy_kcal, updated_at, deleted_at)
       VALUES ('legacy-2', 'Aloo Gobis', '100g', 120, 222, NULL)`,
    );
    const second = await initFoodLibrary();
    check('a clash is reported', second.clashes.includes('Aloo Gobis'), second.clashes.join(','));
    const dup = await nut.query<{ slug: string }>(
      "SELECT slug FROM custom_foods WHERE id = 'legacy-2'",
    );
    check('and suffixed, not collided', dup[0]?.slug === 'aloo gobi ~2', String(dup[0]?.slug));

    // The whole point, end to end: the same dish entered two ways lands on
    // one row. This is the live path the "add a new dish" screen uses.
    const a = await saveDishFromPortion({
      name: 'Palak Paneer', quantity: 1, measure: 'katori', netWeightG: 150,
      energy: 180, protein: 9, fat: 12, carbs: 8, fibre: 3,
    });
    const b = await saveDishFromPortion({
      name: 'palak  paneer!', quantity: 1, measure: 'bowl', netWeightG: 350,
      energy: 420, protein: 21, fat: 28, carbs: 19, fibre: 7,
    });
    check('a second spelling is the same dish', a.foodId === b.foodId, `${a.foodId} vs ${b.foodId}`);
    const rows = await nut.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM custom_foods WHERE slug = ? AND deleted_at IS NULL",
      [slugFor('Palak Paneer')],
    );
    check('one row, not two', Number(rows[0]?.n) === 1, String(rows[0]?.n));
  }


  // ---- the sync envelope -------------------------------------------------
  //
  // Here rather than in the node suite because this is the browser's own
  // WebCrypto and the browser's own IndexedDB — the two things the envelope
  // actually runs on. A stub would test the stub.
  step('household');
  {
    const { household, code } = await createHousehold();
    check('a pairing code is produced', /^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/.test(code), code);

    const stored = await loadHousehold();
    check('and the household persists', stored?.id === household.id, String(stored?.id));

    const msg = JSON.stringify({ v: 1, rows: [{ t: 'custom_foods', k: 'dal tadka' }] });
    const sealed = await seal(household.key, msg);
    check('the dish name is not on the wire',
      !new TextDecoder().decode(sealed).includes('dal tadka'));

    // The other phone, holding only the code.
    const joined = await joinHousehold(code);
    check('the code alone opens the batch', (await openSealed(joined.key, sealed)) === msg);
    check('and lands on the same inbox', joined.id === household.id);

    // A relay holding the ciphertext and a different key learns nothing.
    const stranger = await createHousehold();
    let refused = false;
    try {
      await openSealed(stranger.household.key, sealed);
    } catch {
      refused = true;
    }
    check('a stranger key cannot open it', refused);

    // Nonce reuse is the one fatal mistake with AES-GCM.
    const a = await seal(household.key, 'same');
    const b = await seal(household.key, 'same');
    check('identical batches differ on the wire', a.join() !== b.join());

    await leaveHousehold();
    check('leaving forgets the key', (await loadHousehold()) === null);
  }

  // ---- sync: collecting and applying ------------------------------------
  step('librarysync');
  {
    const nut = scopedDb('nutritionist');
    const rows = await collect(0);
    check('the library collects as wire rows', rows.length > 0, String(rows.length));
    check('dishes are in there', rows.some((r) => r.t === 'custom_foods'));
    check('and so are their portions', rows.some((r) => r.t === 'food_portions'));

    // Nothing on the wire may carry a local id — hers means nothing here.
    const leaks = rows.filter((r) => 'id' in r.f || 'food_id' in r.f);
    check('no local ids travel', leaks.length === 0, JSON.stringify(leaks[0] ?? {}));
    // A portion names its dish by slug, not by row.
    const p = rows.find((r) => r.t === 'food_portions');
    check('a portion names its dish by slug', typeof p?.f.food_slug === 'string' && !!p.f.food_slug);

    // THE ping-pong guard. Applying rows this device already has must change
    // nothing at all — above all it must not restamp updated_at, or the rows
    // look locally modified, get pushed back, and the two phones trade the
    // same dish forever without ever converging.
    const before = await nut.query<{ n: number; hi: number; lo: number }>(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS hi, MIN(updated_at) AS lo
         FROM custom_foods WHERE deleted_at IS NULL`,
    );
    await apply(rows);
    const after = await nut.query<{ n: number; hi: number; lo: number }>(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS hi, MIN(updated_at) AS lo
         FROM custom_foods WHERE deleted_at IS NULL`,
    );
    check('applying our own rows adds nothing', after[0].n === before[0].n,
      `${before[0].n} -> ${after[0].n}`);
    check('and does not restamp updated_at',
      after[0].hi === before[0].hi && after[0].lo === before[0].lo,
      `${before[0].hi}/${before[0].lo} -> ${after[0].hi}/${after[0].lo}`);

    // A dish only the other phone has arrives whole, with its timestamp.
    const far = Date.now() - 5_000;
    const got = await apply([
      { t: 'custom_foods', k: 'rajma masala', at: far, del: null,
        f: { slug: 'rajma masala', name: 'Rajma Masala', per_unit: '100g',
             energy_kcal: 127, protein_g: 6.2, fat_g: 3.1, carbs_g: 18.4, fibre_g: 5.2,
             notes: null, share: 0 } },
      { t: 'food_portions', k: 'rajma masala|katori', at: far, del: null,
        f: { food_slug: 'rajma masala', measure: 'katori', quantity: 1,
             net_weight_g: 150, is_default: 1, source: 'user' } },
    ]);
    check('a new dish is created', got.dishes === 1, String(got.dishes));
    check('along with its portion', got.portions === 1, String(got.portions));
    const rajma = await nut.query<{ id: string; updated_at: number }>(
      "SELECT id, updated_at FROM custom_foods WHERE slug = 'rajma masala'",
    );
    check('carrying the sender timestamp, not ours', rajma[0]?.updated_at === far, `${rajma[0]?.updated_at} vs ${far}`);
    check('and it got a local id of its own', (rajma[0]?.id ?? '').length > 0);

    // The portion resolved the slug to this device's row.
    const anchor = await nut.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM food_portions WHERE food_id = ? AND measure = ?',
      [rajma[0].id, 'katori'],
    );
    check('the anchor points at our copy of the dish', Number(anchor[0].n) === 1, String(anchor[0].n));

    // An older edit must not win.
    await apply([{ t: 'custom_foods', k: 'rajma masala', at: far - 10_000, del: null,
      f: { slug: 'rajma masala', name: 'WRONG', per_unit: '100g', energy_kcal: 1,
           protein_g: 0, fat_g: 0, carbs_g: 0, fibre_g: 0, notes: null, share: 0 } }]);
    const still = await nut.query<{ name: string }>(
      "SELECT name FROM custom_foods WHERE slug = 'rajma masala'",
    );
    check('an older row does not overwrite a newer one', still[0]?.name === 'Rajma Masala', String(still[0]?.name));

    // A portion whose dish has not arrived is skipped, not guessed at and not
    // fatal — it applies on the next sync once the dish shows up.
    const orphan = await apply([
      { t: 'food_portions', k: 'not here yet|bowl', at: Date.now(), del: null,
        f: { food_slug: 'not here yet', measure: 'bowl', quantity: 1,
             net_weight_g: 350, is_default: 0, source: 'user' } },
    ]);
    check('an orphan portion is skipped', orphan.skipped === 1, String(orphan.skipped));
    check('and nothing was written for it', orphan.portions === 0, String(orphan.portions));

    // The app's arithmetic never buries a number somebody weighed.
    await apply([{ t: 'food_portions', k: 'rajma masala|katori', at: Date.now() + 60_000, del: null,
      f: { food_slug: 'rajma masala', measure: 'katori', quantity: 1,
           net_weight_g: 999, is_default: 0, source: 'derived' } }]);
    const kept = await nut.query<{ net_weight_g: number; source: string }>(
      'SELECT net_weight_g, source FROM food_portions WHERE food_id = ? AND measure = ?',
      [rajma[0].id, 'katori'],
    );
    check('a derived portion cannot overwrite a measured one',
      Number(kept[0].net_weight_g) === 150, JSON.stringify(kept[0]));
  }

  // ---- targets, and what an unset one means -----------------------------
  const blank = await loadTargets();
  check('targets start unset, not zero', blank.energy_kcal === null, JSON.stringify(blank));
  check('an unset target has no percentage', standing(1200, null, true).pct === null);
  check('and is reported as unset', standing(1200, null, true).standing === 'unset');

  await saveTargets({ energy_kcal: 1700, protein_g: 85, fat_g: 57, carbs_g: 213, fibre_g: 30 });
  const t2 = await loadTargets();
  check('targets round-trip', t2.energy_kcal === 1700 && t2.fibre_g === 30, JSON.stringify(t2));
  check('under 75% reads low', standing(1100, 1700, true).standing === 'low');
  check('76-100% reads good', standing(1500, 1700, true).standing === 'good');
  check('over is bad for calories', standing(1900, 1700, true).standing === 'over');
  check('but not for fibre', standing(61, 30, false).standing === 'good');

  // ---- six slots ---------------------------------------------------------
  check('six slots', SLOTS.length === 6, String(SLOTS.length));
  check('old "snack" rows still read', normaliseSlot('snack') === 'esnack');
  check('unknown slots fall to other', normaliseSlot('brunch') === 'other');
  check('the clock suggests one', SLOTS.some((s) => s.id === guessSlot()));

  const dayNow = await readDay();
  check('the day groups by slot', dayNow.groups.length > 0, String(dayNow.groups.length));
  check(
    'and only slots with food in them',
    dayNow.groups.every((g) => g.items.length > 0),
  );
  const top = contributors(dayNow, 0);
  check('contributors are ranked', top.length > 0 && top[0].value >= (top[1]?.value ?? 0));
  check('and their shares sum to about 100', Math.abs(top.reduce((a, r) => a + r.share, 0) - 100) <= 2,
    String(top.reduce((a, r) => a + r.share, 0)));

  const rec = await recentItems('lunch', 5);
  check('recents come back', rec.length > 0, String(rec.length));
  check('with the amount you used', rec.every((r) => r.quantity > 0));

  // ---- search actually runs ---------------------------------------------
  // SQLite refuses an expression in the ORDER BY of a compound SELECT, and it
  // refuses it at query time. Search was throwing and nothing caught it.
  const found = await searchFoods('dal', 10);
  check('search returns matches', found.length > 0, String(found.length));
  check('and prefers your own dishes', found[0].is_custom === 1, JSON.stringify(found[0]));

  // ---- a restaurant portion stays put -----------------------------------
  const rotiFood = await matchFood('roti');
  const asServe = await resolveFor(rotiFood!.food.id, 1, 'serve');
  check('an unrecorded serve is not derived', asServe.basis === 'restaurant', asServe.basis);
  check('and is flagged as unmeasured', !asServe.measured);

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

  await saveMeal(await draftFromText('1 cup set curd'), { mealType: 'snack' });
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

  // ---- burn: the second entry of the day adds ---------------------------
  // The whole reason burn does not simply reuse the weight code, and it can
  // only be proved against a real database: two sessions have to land in one
  // row, summed, without the second replacing the first.
  {
    const morning = new Date(2026, 8, 24, 7, 30).getTime();
    const evening = new Date(2026, 8, 24, 20, 15).getTime();

    const first = await recordBurn(320, morning);
    check('first entry is the day total', first.total === 320, String(first.total));

    const second = await recordBurn(430, evening);
    check('the second adds rather than replacing', second.total === 750, String(second.total));
    check('and it is the same row', second.id === first.id);

    const rows = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM burns WHERE deleted_at IS NULL',
    );
    check('one row for the day, not two', Number(rows[0].n) === 1, String(rows[0].n));

    const onDay = await burnOn(dayStartOf(morning));
    check('read back as 750', Number(onDay?.kcal) === 750, String(onDay?.kcal));

    // The way back from a mistyped number.
    await setBurnTotal(500, evening);
    const fixed = await burnOn(dayStartOf(morning));
    check('correcting overwrites the total', Number(fixed?.kcal) === 500, String(fixed?.kcal));
    const stillOne = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM burns WHERE deleted_at IS NULL',
    );
    check('and still one row', Number(stillOne[0].n) === 1, String(stillOne[0].n));

    // A different day is a different row, bucketed on local midnight.
    await recordBurn(600, new Date(2026, 8, 25, 8, 0).getTime());
    const two = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM burns WHERE deleted_at IS NULL',
    );
    check('the next day opens its own row', Number(two[0].n) === 2, String(two[0].n));

    // The target lives on targets beside weight_kg, and nothing nets it
    // against the energy goal.
    await setGoalBurn(500);
    check('the daily target round-trips', (await goalBurn()) === 500, String(await goalBurn()));

    // burns is per-person, so the same guard has to hold for it.
    let burnThrew = false;
    try {
      await scopedDb('doctor').query('SELECT kcal FROM burns WHERE deleted_at IS NULL');
    } catch (e) {
      burnThrew = e instanceof ProfileScopeError;
    }
    check('an unfiltered read of burns throws too', burnThrew);

    // The Nutritionist may read it when asked about a day, and may not write.
    let nutWrote = false;
    try {
      await scopedDb('nutritionist').insert('burns', { kcal: 1, measured_at: morning });
      nutWrote = true;
    } catch {
      nutWrote = false;
    }
    check('the Nutritionist cannot write burns', !nutWrote);

    // ---- the Previous card's query ------------------------------------
    // The bug it replaces: the screen asked for the row at `today - 1 day`.
    // Nothing here was logged yesterday — the two rows are 24 and 25 Sept —
    // so the old question returns nothing while two perfectly good totals sit
    // further back. This asks for the latest ones instead, at any distance.
    const t0 = dayStartOf(Date.now());
    const yday = await burnOn(t0 - 86_400_000);
    check('nothing was logged yesterday', yday === null, String(yday?.kcal));

    const back = await lastBefore(t0);
    check('but the previous days are still found', back.length === 2, String(back.length));
    check('newest first', back[0].measured_at > back[1].measured_at);
    check('and it is the 25th, not a blank', Number(back[0].kcal) === 600, String(back[0].kcal));
    check('with the 24th behind it', Number(back[1].kcal) === 500, String(back[1].kcal));

    // Today is excluded, or the card would just repeat the Today card.
    await recordBurn(999, Date.now());
    const afterToday = await lastBefore(t0);
    check("today's own row is not 'previous'",
      Number(afterToday[0].kcal) === 600, String(afterToday[0].kcal));

    // The gap is what the card has to state. These two are a day apart; the
    // newest is however many days back it happens to be.
    check('the gap between them is a day',
      daysBetween(back[1].measured_at, back[0].measured_at), 1);
  }

  // ---- v10: the medicine library is shared, the doses are not ------------
  // The split v10 draws, held by the same guard that keeps meals apart: what a
  // medicine is reads freely, who takes it and how much does not.
  {
    const pharmacist = scopedDb('pharmacist');
    const refused = async (sqlText: string) => {
      try {
        await pharmacist.query(sqlText);
        return false;
      } catch (e) {
        return e instanceof ProfileScopeError;
      }
    };
    check('an unfiltered read of med_doses throws',
      await refused('SELECT * FROM med_doses WHERE deleted_at IS NULL'));
    check('an unfiltered read of sick_episodes throws',
      await refused('SELECT * FROM sick_episodes WHERE deleted_at IS NULL'));

    let libraryReads = true;
    try {
      await pharmacist.query('SELECT id FROM med_products LIMIT 1');
    } catch {
      libraryReads = false;
    }
    check('but the medicine library reads without one', libraryReads);

    // Library rows have no profile_id column at all, so a stamp would fail the
    // insert outright. That it succeeds is the proof nothing stamped it.
    const productId = await pharmacist.insert('med_products', { name: 'Fixture tablet' });
    const doseId = await pharmacist.insert('med_doses', {
      medication_id: 'fx-none', position: 1, amount: 1, unit: 'tablet',
    });
    const stampedDose = await query<{ profile_id: string }>(
      'SELECT profile_id FROM med_doses WHERE id = ?', [doseId]);
    check('a dose is stamped with whoever is logging',
      stampedDose[0]?.profile_id === activeProfile(), String(stampedDose[0]?.profile_id));

    let nutReadLibrary = false;
    try {
      await scopedDb('nutritionist').query('SELECT id FROM med_products LIMIT 1');
      nutReadLibrary = true;
    } catch (e) {
      nutReadLibrary = !(e instanceof ScopeError);
    }
    check('the Nutritionist cannot read the medicine library', !nutReadLibrary);

    // Raw client: scaffolding, not an agent action.
    await sql('DELETE FROM med_products WHERE id = ?', [productId]);
    await sql('DELETE FROM med_doses WHERE id = ?', [doseId]);
  }

  // ---- v10: one medicine, from his phone's library to her day -------------
  // Both people are on this one device, which is exactly the situation sync
  // reproduces across two: the library is shared, the doses are not.
  step('medicines');
  {
    const day = medDay();
    const products = async () =>
      Number((await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM med_products WHERE deleted_at IS NULL'))[0].n);
    const dueIds = (plan: Awaited<ReturnType<typeof readMedsDay>>) =>
      plan.groups.flatMap((g) => g.doses.map((p) => p.med.id));
    const startCount = await products();

    const calcium: MedForm = {
      name: 'Calcium + D3',
      form: 'tablet',
      strength: '1250mg',
      ingredients: [
        { name: 'Calcium carbonate', strength_text: '1250 mg' },
        { name: 'Cholecalciferol', strength_text: '250 IU' },
      ],
      doses: [
        { amount: 1, unit: 'tablet', time_of_day: 'morning', meal: 'after' },
        { amount: 1, unit: 'tablet', time_of_day: 'night', meal: 'after' },
      ],
      long_term: false,
      private: false,
    };

    await setActiveProfile(PRIMARY_PROFILE);
    const his = await addMedicine(calcium);
    check('adding a medicine puts it in the library', (await products()) === startCount + 1);

    await setActiveProfile(partner);
    const found = await searchLibrary('calcium');
    check('the other person finds it there', found.map((p) => p.name).join(), 'Calcium + D3');
    check('"1250 mg" finds what was typed "1250mg"',
      (await searchLibrary('calcium 1250 mg')).length === 1);
    const herDraft = (await draftFromLibrary(found[0].id))!;
    check('the form opens with its ingredients', herDraft.ingredients.length === 2,
      JSON.stringify(herDraft.ingredients));
    check('and his schedule to start from',
      herDraft.doses.map((d) => d.time_of_day).join() === 'morning,night',
      JSON.stringify(herDraft.doses));

    // Her doctor says two, once a day.
    const hers = await addMedicine({ ...herDraft, doses: [{ ...herDraft.doses[0], amount: 2 }] });
    check('adding it again does not copy the entry', (await products()) === startCount + 1);
    const herPlan = await readMedsDay(day);
    const herDoses = herPlan.groups.flatMap((g) => g.doses);
    check('her day has her one dose, at her amount',
      herDoses.length === 1 && herDoses[0].dose.amount === 2,
      JSON.stringify(herDoses.map((p) => p.dose.amount)));

    await setActiveProfile(PRIMARY_PROFILE);
    check('his day still has his two',
      dueIds(await readMedsDay(day)).filter((id) => id === his).length === 2);

    // A different strength is a different medicine, and his is left alone.
    await setActiveProfile(partner);
    await editMedicine(hers, { ...herDraft, strength: '500 mg', doses: herDraft.doses });
    check('changing the strength makes a new entry', (await products()) === startCount + 2);
    await setActiveProfile(PRIMARY_PROFILE);
    const mine = (await medicineDetail(his))!;
    check('and his still points at the 1250', mine.product?.strength_text === '1250mg',
      String(mine.product?.strength_text));

    // A corrected ingredient list is the same strip, so it is the same entry.
    await editMedicine(his, {
      ...draftFromMedicine(mine),
      ingredients: [...mine.ingredients, { name: 'Magnesium', strength_text: '50 mg' }],
    });
    check('a corrected ingredient list reaches the shared entry',
      (await ingredientsOf(mine.product!.id)).length === 3);
    check('without making a new one', (await medicineDetail(his))!.product?.id === mine.product?.id);

    await hideFromLibrary(mine.product!.id);
    check('a hidden medicine leaves the search',
      (await searchLibrary('calcium')).every((p) => p.id !== mine.product!.id));
    check('but anyone taking it keeps it', (await medicineDetail(his))!.med.name === 'Calcium + D3');

    await addMedicine({ ...calcium, name: 'Something private', strength: null, ingredients: [],
      private: true });
    const priv = await query<{ private: number }>(
      "SELECT private FROM med_products WHERE name = 'Something private'");
    check('"Keep private" is recorded on the entry', Number(priv[0]?.private) === 1);

    // ---- sick mode, end to end -------------------------------------------
    const thyroxine = await addMedicine({ ...calcium, name: 'Thyroxine', strength: '50 mcg',
      ingredients: [], long_term: true,
      doses: [{ amount: 1, unit: 'tablet', time_of_day: 'morning', meal: 'before' }] });
    // The way a medicine looked before v10: free text, no slots, never asked.
    const legacy = await addMedication({ name: 'Old vitamin', dose_text: '1000 IU',
      schedule: 'after breakfast', notes: null });
    check('a medicine from before slots counts as never asked',
      (await unaskedLongTerm()).some((m) => m.id === legacy));
    check('and is shown as written', (await readMedsDay(day)).unscheduled.some((m) => m.id === legacy));

    const fever = await startSickness('Viral fever', 7, 'days', day);
    let twice = false;
    try {
      await startSickness('Cold', 3, 'days', day);
    } catch {
      twice = true;
    }
    check('a second sickness cannot start over a running one', twice);

    let plan = await readMedsDay(day);
    check('sick mode is running', plan.episode?.id === fever);
    check('the long-term medicine continues', dueIds(plan).includes(thyroxine));
    check('the regular one pauses',
      plan.paused.some((p) => p.med.id === his) && !dueIds(plan).includes(his));
    check('so does the never-asked one', plan.paused.some((p) => p.med.id === legacy));

    const syrup = await addMedicine({ name: 'Cough syrup', form: 'syrup', strength: null,
      ingredients: [], long_term: true, private: false,
      doses: [{ amount: 10, unit: 'ml', time_of_day: 'morning', meal: 'after' }] }, fever);
    check('a sickness medicine is never long-term, whatever the switch said',
      (await medicineDetail(syrup))!.med.long_term === 0);
    plan = await readMedsDay(day);
    const syrupDose = plan.groups.flatMap((g) => g.doses).find((p) => p.med.id === syrup);
    check('and it is due', syrupDose !== undefined);

    await markDose(syrupDose!, day);
    let tick = (await readMedsDay(day)).groups.flatMap((g) => g.doses)
      .find((p) => p.med.id === syrup);
    check('ticking it marks it taken', tick?.state === 'taken', tick?.state);
    await markDose(tick!, day, 'skipped');
    tick = (await readMedsDay(day)).groups.flatMap((g) => g.doses).find((p) => p.med.id === syrup);
    check('re-ticking replaces the answer', tick?.state === 'skipped', tick?.state);
    const live = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM intake_events
        WHERE profile_id = ? AND dose_id = ? AND for_day = ? AND deleted_at IS NULL`,
      [PRIMARY_PROFILE, tick!.dose.id, day]);
    check('one live answer per dose per day', Number(live[0].n) === 1, String(live[0].n));

    const sickSlice = renderSlice(await collectFacts());
    check('the Doctor sees the sickness', sickSlice.includes('Sick mode: Viral fever, day 1 of 7.'),
      sickSlice);
    check('and what it paused', /Paused while sick:.*Calcium \+ D3/.test(sickSlice), sickSlice);
    check('and the dose slots', sickSlice.includes('morning: 10 ml · after meal'), sickSlice);

    const running = (await runningEpisode(day))!;
    const extended = await extendSickness(running, 3, 'days');
    check('Extend moves the last day on', extended === addDays(running.last_day, 3), extended);

    await recoverSickness((await runningEpisode(day))!, day);
    plan = await readMedsDay(day);
    check('Recovered ends sick mode today', plan.episode === null);
    check('its medicine is no longer due', !dueIds(plan).includes(syrup));
    check('and the regular one is back', dueIds(plan).includes(his));
    // Only "Currently taking" drops it. This morning's skip is still a fact
    // about today, and the "Doses today" line rightly keeps saying so.
    const wellSlice = renderSlice(await collectFacts());
    const takingLine = wellSlice.split('\n').find((l) => l.startsWith('Currently taking')) ?? '';
    check('and the Doctor no longer counts the syrup as being taken',
      !takingLine.includes('Cough syrup'), wellSlice);
    check('while today\'s skip is still reported', /Doses today:.*Cough syrup skipped/.test(wellSlice),
      wellSlice);

    const past = (await listEpisodes()).find((e) => e.id === fever);
    check('the sickness stays in history', past?.recovered_on === day, JSON.stringify(past));
    const record = await sicknessRecord(past!);
    check('with what was taken for it',
      JSON.stringify(record.map((r) => [r.med.name, r.taken, r.skipped])) ===
        JSON.stringify([['Cough syrup', 0, 1]]),
      JSON.stringify(record.map((r) => [r.med.name, r.taken, r.skipped])));

    await setActiveProfile(partner);
    check('his sickness was never hers', (await readMedsDay(day)).episode === null);
    await setActiveProfile(PRIMARY_PROFILE);
  }

  // ---- v10: the medicine library on the wire ------------------------------
  step('medsync');
  {
    const pharm = scopedDb('pharmacist');
    const rows = await collectMeds(0);
    check('the medicine library collects as wire rows', rows.some((r) => r.t === 'med_products'));
    check('a private medicine stays on this phone',
      !rows.some((r) => r.f.name === 'Something private'), JSON.stringify(rows.map((r) => r.k)));
    const leaks = rows.filter((r) => 'id' in r.f || 'product_id' in r.f || 'private' in r.f);
    check('no local ids, and no private flag, travel', leaks.length === 0, JSON.stringify(leaks[0] ?? {}));
    check('who takes it does not travel',
      rows.every((r) => !('profile_id' in r.f) && !('long_term' in r.f) && !('episode_id' in r.f)));

    // Calcium + D3's ingredients were rewritten in the medicines step: two
    // tombstones and three live rows, two of them sharing positions with the
    // tombstones. The wire must carry the three live ones.
    const calc = rows.filter((r) => r.t === 'med_product_ingredients' && r.k.startsWith('calcium d3 1250 mg|'));
    check('a rewritten list travels as its live rows',
      JSON.stringify(calc.map((r) => [r.f.position, r.f.name, r.del]).sort()) ===
        JSON.stringify([[1, 'Calcium carbonate', null], [2, 'Cholecalciferol', null], [3, 'Magnesium', null]]),
      JSON.stringify(calc.map((r) => [r.f.position, r.f.name, r.del])));

    // The ping-pong guard, for medicines.
    const stamp = async () =>
      (await pharm.query<{ n: number; hi: number }>(
        'SELECT COUNT(*) AS n, MAX(updated_at) AS hi FROM med_products WHERE deleted_at IS NULL'))[0];
    const before = await stamp();
    await applyMeds(rows);
    const after = await stamp();
    check('applying our own medicine rows changes nothing',
      after.n === before.n && after.hi === before.hi, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // A medicine only the other phone has.
    const far = Date.now() - 5_000;
    const got = await applyMeds([
      { t: 'med_product_doses', k: 'azithromycin 500 mg|1', at: far, del: null,
        f: { product_slug: 'azithromycin 500 mg', position: 1, amount: 1, unit: 'tablet',
             time_of_day: 'morning', meal: 'before' } },
      { t: 'med_products', k: 'azithromycin 500 mg', at: far, del: null,
        f: { slug: 'azithromycin 500 mg', name: 'Azithromycin', form: 'tablet',
             strength_text: '500 mg', hidden: 0 } },
      { t: 'med_product_ingredients', k: 'azithromycin 500 mg|1', at: far, del: null,
        f: { product_slug: 'azithromycin 500 mg', position: 1, name: 'Azithromycin',
             strength_text: '500 mg' } },
    ]);
    check('a new medicine arrives', got.medicines === 1 && got.skipped === 0, JSON.stringify(got));
    const azi = (await searchLibrary('azithromycin'))[0];
    check('into the library, with the sender\'s timestamp', azi?.updated_at === far,
      `${azi?.updated_at} vs ${far}`);
    const aziDraft = azi ? await draftFromLibrary(azi.id) : null;
    check('with its ingredient and starting dose, even sent ahead of it',
      aziDraft?.ingredients.length === 1 && aziDraft?.doses[0]?.meal === 'before',
      JSON.stringify(aziDraft));

    // The list got shorter on the other phone.
    await applyMeds([{ t: 'med_product_ingredients', k: 'azithromycin 500 mg|1', at: far + 1,
      del: far + 1, f: { product_slug: 'azithromycin 500 mg', position: 1, name: 'Azithromycin',
      strength_text: '500 mg' } }]);
    check('a removed ingredient is removed here', (await ingredientsOf(azi!.id)).length === 0);

    // An older edit does not win.
    await applyMeds([{ t: 'med_products', k: 'azithromycin 500 mg', at: far - 10_000, del: null,
      f: { slug: 'azithromycin 500 mg', name: 'WRONG', form: 'tablet', strength_text: '500 mg', hidden: 0 } }]);
    check('an older medicine row does not overwrite a newer one',
      (await searchLibrary('azithromycin'))[0]?.name === 'Azithromycin');

    // His shared entry meets her private one of the same strip.
    await applyMeds([{ t: 'med_products', k: 'something private', at: Date.now() + 1_000, del: null,
      f: { slug: 'something private', name: 'Something private', form: 'tablet',
           strength_text: null, hidden: 0 } }]);
    const still = await pharm.query<{ private: number; n: number }>(
      "SELECT MAX(private) AS private, COUNT(*) AS n FROM med_products WHERE slug = 'something private'");
    check('the same strip merges into one entry', Number(still[0].n) === 1, String(still[0].n));
    check('and a private one stays private', Number(still[0].private) === 1);
    check('so it still does not travel',
      !(await collectMeds(0)).some((r) => r.f.name === 'Something private'));

    // A child whose medicine has not arrived is skipped, not guessed at.
    const orphan = await applyMeds([{ t: 'med_product_doses', k: 'nothing here|1', at: far, del: null,
      f: { product_slug: 'nothing here', position: 1, amount: 1, unit: 'tablet', time_of_day: 'night', meal: 'after' } }]);
    check('a dose for a medicine not here yet waits', orphan.skipped === 1, JSON.stringify(orphan));
  }
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
