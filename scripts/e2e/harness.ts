/**
 * The storage-layer test body. See harness.html for why this exists.
 *
 * Everything here goes through the same modules the app uses — scoped db
 * handles, migrations, the OPFS worker — so a failure means the app is broken,
 * not the test.
 */

import { initDb, query, run as sql, describeDatabase, inspectBackup, keepWeeklyCopy, makeBackup, restoreBackup, run } from '../../src/db/client';
import { listCopies, snapshotFile } from '../../src/db/snapshots';
import { lastBackupAt, noteBackup } from '../../src/domain/upkeep';
import { sameRows } from '../../src/db/backup';
import { LATEST_VERSION } from '../../src/db/migrations';
import { ProfileScopeError, ScopeError, scopedDb } from '../../src/db/scope';
import {
  createProfile,
  initProfiles,
  listProfiles,
  nightTomorrow,
  setActiveProfile,
  setNightTomorrow,
  PRIMARY_PROFILE,
} from '../../src/profiles/store';
import { activeProfile } from '../../src/lib/active-profile';
import { importPersonalFoods, saveDishFromPortion } from '../../src/domain/import';
import {
  customFoodIdBySlug,
  deleteCustomFood,
  dishNamed,
  initFoodLibrary,
  matchFood,
  searchFoods,
  slugFor,
} from '../../src/domain/foods';
import { cyclePlan, deleteMeal, draftFromText, saveMeal, mealsOn, itemsFor, mealTime, setMealTime } from '../../src/domain/meals';
import { buildPlan, dayAhead, savePlan } from '../../src/domain/mealplanner';
import { DEFAULT_REMINDERS } from '../../src/domain/reminders';
import { buildRings, refreshReminders } from '../../src/domain/remindersync';
import { onChange } from '../../src/lib/changes';
import { portionsFor, resolveFor, upsertPortion } from '../../src/domain/portions';
import { seedFoods, startFoods, type BundledFood } from '../../src/domain/seed';
import { collectFacts, refreshCurrentState, renderSlice } from '../../src/domain/state';
import { appendMessage, buildContext, clearThread, loadThread } from '../../src/llm/conversation';
import { logSymptom, openSymptoms, recentSymptoms, removeSymptom } from '../../src/domain/symptoms';
import { buildExport, collectExport } from '../../src/domain/export';
import { keepWeek, keptWeek, latestWeek, markWeekShown, readWeek, weekShown } from '../../src/domain/week';
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
import { readDay, contributors, dayAt, localDayKey, loggedDays } from '../../src/domain/day';
import { guessSlot, normaliseSlot, SLOTS } from '../../src/domain/slots';
import { recentItems } from '../../src/domain/recents';
import { apply, collect } from '../../src/domain/librarysync';
import { fingerprint } from '../../src/domain/sync';
import { readFastLine } from '../../src/domain/fasting';
import { daysNeeded, patternFor } from '../../src/domain/patterns';
import {
  customFood,
  deleteDish,
  entriesUsing,
  previewEntries,
  saveDishEdit,
  type DishEdit,
} from '../../src/domain/dishedit';
import {
  createHousehold,
  joinHousehold,
  leaveHousehold,
  loadHousehold,
  open as openSealed,
  seal,
} from '../../src/lib/household';
import {
  listActive,
  addMedication,
  addMedicine,
  cycleDose,
  listStopped,
  readLog,
  resumeMedication,
  stopMedication,
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
import { addDays, dateOf, EVERY_DAY, medDay, scheduleOf } from '../../src/domain/doses';
import { applyMeds, collectMeds } from '../../src/domain/medsync';
import { upgradeFromPrevious } from './upgrade';
import { clearStaleImports, importList, listSets, retireBundled, searchReference } from '../../src/domain/refdata';
import { presetFor } from '../../src/lib/tabular';
import { bulkInsert } from '../../src/db/client';
import { strToU8, zipSync } from 'fflate';

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

  // "with" names a second thing eaten. It used to stay inside the first
  // item, which then matched the nearest dish and dropped the rest unseen.
  const joined = await draftFromText('2 roti with 1 katori dal tadka');
  check('"with" gives two items', joined.length === 2, JSON.stringify(joined.map((d) => d.label)));
  check('each matched to its own dish',
    joined[0]?.food?.name === 'Roti' && joined[1]?.food?.name === 'Dal Tadka', JSON.stringify(joined.map((d) => d.food?.name)));
  check('each with the amount typed for it',
    joined[0]?.quantity === 2 && joined[1]?.quantity === 1 && joined[1]?.unit === 'katori', JSON.stringify(joined.map((d) => [d.quantity, d.unit])));
  const cheesy = await draftFromText("2 roti with d'lecta cheddar cheese");
  check('something not in the food table is shown as its own unmatched item',
    cheesy.length === 2 && cheesy[0].food?.name === 'Roti' && cheesy[1].food === null && cheesy[1].label === "d'lecta cheddar cheese",
    JSON.stringify(cheesy.map((d) => [d.label, d.food?.name ?? null])));

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

  // ---- what Ask Mealo sees ---------------------------------------------
  step('slice');
  const slice = renderSlice(await collectFacts());
  check('slice names the dish', slice.toLowerCase().includes('dal tadka'), slice);
  check('slice carries the weight', /\(\d+g\)/.test(slice), slice);
  // The week's line used to stop at calories, protein and fibre, so the
  // model could not say anything about a week's fat or carbs.
  check('the week in the slice has all five figures',
    /in the last week: about \d+ kcal\/day, protein \d+g, fat \d+g, carbs \d+g, fibre \d+g\./.test(slice), slice);
  check('and says a day may be only partly logged', slice.includes('A day may be only partly logged'), slice);

  // Two refreshes at once, before any row exists: what the dev server does
  // the first time the chat opens. The second used to fail on the primary key.
  const both = await Promise.allSettled([refreshCurrentState(), refreshCurrentState()]);
  check('two refreshes at once both succeed', both.every((r) => r.status === 'fulfilled'),
    both.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join(' | '));
  const stateRows = await query<{ id: string; summary: string }>('SELECT id, summary FROM current_state');
  check('and leave one row, for this profile', stateRows.length === 1 && stateRows[0].id === PRIMARY_PROFILE,
    JSON.stringify(stateRows.map((r) => r.id)));
  check('holding the slice', stateRows[0]?.summary === renderSlice(await collectFacts()));
  await refreshCurrentState();
  const stateAfter = await query<{ n: number }>('SELECT COUNT(*) AS n FROM current_state');
  check('a later refresh updates that row rather than adding one', Number(stateAfter[0].n) === 1, String(stateAfter[0].n));

  // The request a model is sent ends with the new question, once. The chat
  // stores the question first, and the builder then read it back from the
  // thread and added it again.
  {
    const ask = (text: string) => buildContext({ agent: 'doctor', systemPrompt: 'P', stateSlice: null, userMessage: text });
    const users = (ms: { role: string; content: string }[], text: string) => ms.filter((m) => m.role === 'user' && m.content === text).length;
    const fresh = await ask('how was my week?');
    check('a question not yet stored is in the request once', users(fresh, 'how was my week?') === 1, JSON.stringify(fresh));
    await appendMessage('doctor', 'user', 'how was my week?');
    const stored = await ask('how was my week?');
    check('stored first, as the chat does, it is still there once', users(stored, 'how was my week?') === 1, JSON.stringify(stored));
    check('and it is the last thing in the request', stored[stored.length - 1]?.content === 'how was my week?' && stored[stored.length - 1]?.role === 'user');
    await appendMessage('doctor', 'assistant', 'Two days logged.');
    await appendMessage('doctor', 'user', 'how was my week?');
    const again = await ask('how was my week?');
    check('asked a second time after an answer, both askings are kept', users(again, 'how was my week?') === 2, JSON.stringify(again));
    check('in order: question, answer, question',
      again.slice(-3).map((m) => m.role).join(',') === 'user,assistant,user', again.map((m) => m.role).join(','));
    await clearThread('doctor');
    check('the test leaves no messages behind', (await loadThread('doctor')).length === 0);
  }

  // A symptom logged from the chat, and its Undo. Undo is not "resolved":
  // the row must leave the open list and the slice, and stay in the table.
  const symId = await logSymptom('Headache since morning, behind the eyes');
  check('a logged symptom is open', (await openSymptoms()).some((x) => x.id === symId));
  check('and reaches the slice in the person\'s words', renderSlice(await collectFacts()).includes('Headache since morning'));
  await removeSymptom(symId);
  check('undone, it is no longer open', !(await openSymptoms()).some((x) => x.id === symId));
  check('nor in the slice', !renderSlice(await collectFacts()).includes('Headache since morning'));
  const symRow = await query<{ deleted_at: number | null; resolved_at: number | null }>(
    'SELECT deleted_at, resolved_at FROM symptoms WHERE id = ?', [symId]);
  check('the row is kept, marked deleted and not resolved',
    symRow.length === 1 && symRow[0].deleted_at !== null && symRow[0].resolved_at === null, JSON.stringify(symRow));

  // A label beside the words. The slice sends both, and the words leave
  // without the phone number or the address that were typed into them.
  const labelled = await logSymptom('Headache again. Dr Rao said call 98201 55512 or rao@clinic.in if it lasts.', { label: 'Headache' });
  const plain = await logSymptom('left eyelid keeps twitching since morning');
  const symStored = await query<{ id: string; label: string | null; raw_text: string }>(
    'SELECT id, label, raw_text FROM symptoms WHERE id IN (?, ?)', [labelled, plain]);
  const stored = (id: string) => symStored.find((r) => r.id === id);
  check('the label is saved with the symptom', stored(labelled)?.label === 'Headache', JSON.stringify(symStored));
  check('a symptom may be saved with none', stored(plain)?.label === null, JSON.stringify(symStored));
  check('the record keeps the words exactly as typed', stored(labelled)?.raw_text.includes('98201 55512') === true, stored(labelled)?.raw_text);
  const symSlice = renderSlice(await collectFacts());
  check('the slice gives the label, then the words',
    symSlice.includes('  - Headache: "Headache again. Dr Rao said call [phone] or [email] if it lasts." (noted today)'), symSlice);
  check('the number and the address do not leave', !symSlice.includes('98201') && !symSlice.includes('rao@clinic.in'), symSlice);
  check('with no label, the words alone', symSlice.includes('  - "left eyelid keeps twitching since morning" (noted today)'), symSlice);
  await removeSymptom(labelled);
  await removeSymptom(plain);

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

    // The whole point, end to end: the same dish entered two ways is one
    // dish. This is the live path the "add a new dish" screen uses, and since
    // 8 Oct 2026 it says so rather than quietly saving over it — the potato
    // below is why.
    const a = await saveDishFromPortion({
      name: 'Palak Paneer', quantity: 1, measure: 'katori', netWeightG: 150,
      energy: 180, protein: 9, fat: 12, carbs: 8, fibre: 3,
    });
    const b = await saveDishFromPortion({
      name: 'palak  paneer!', quantity: 1, measure: 'bowl', netWeightG: 350,
      energy: 420, protein: 21, fat: 28, carbs: 19, fibre: 7,
    });
    check('a second spelling is the same dish', b.existing?.id === a.foodId, `${a.foodId} vs ${b.existing?.id}`);

    // "with" inside a dish's own name is not a join. Only the food table can
    // tell, so the whole phrase is tried as a dish first.
    const withName = await saveDishFromPortion({
      name: 'Curd with rice', quantity: 1, measure: 'bowl', netWeightG: 300,
      energy: 330, protein: 9, fat: 8, carbs: 54, fibre: 1,
    });
    const wholeDish = await draftFromText('1 bowl curd with rice');
    check('a dish named "X with Y" stays one item',
      wholeDish.length === 1 && wholeDish[0].food?.id === withName.foodId, JSON.stringify(wholeDish.map((d) => [d.label, d.food?.name ?? null])));
    await deleteCustomFood(withName.foodId);
    const rows = await nut.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM custom_foods WHERE slug = ? AND deleted_at IS NULL",
      [slugFor('Palak Paneer')],
    );
    check('one row, not two', Number(rows[0]?.n) === 1, String(rows[0]?.n));

    // The case that was hit, 8 Oct 2026. "Boiled potato (small)" was typed
    // on the add screen to replace an inaccurate "Boiled potato - small".
    // Both slug to "boiled potato small", so the save rewrote the old dish's
    // numbers, kept its name and its default portion, and the log screen
    // opened it under the old name with the new numbers.
    const first = await saveDishFromPortion({
      name: 'Boiled potato - small', quantity: 1, measure: 'piece', netWeightG: 100,
      energy: 150, protein: 1, fat: 0, carbs: 35, fibre: 1,
    });
    const potatoId = first.foodId as string;
    // Search normalised the needle but not the name, so the one dish the save
    // would land on was the one search could not show.
    const found = await searchFoods('boiled potato (small)');
    check('search finds a dish whatever its punctuation',
      found.some((f) => f.id === potatoId), found.map((f) => f.name).join(','));

    const retyped = await saveDishFromPortion({
      name: 'Boiled potato (small)', quantity: 1, measure: 'katori', netWeightG: 75,
      energy: 65, protein: 1.5, fat: 0.1, carbs: 15, fibre: 1.3,
    });
    check('adding a dish that exists saves nothing', retyped.foodId === null, String(retyped.foodId));
    check('and names the dish it already is', retyped.existing?.name === 'Boiled potato - small',
      String(retyped.existing?.name));
    const kept = await nut.query<{ energy_kcal: number }>(
      'SELECT energy_kcal FROM custom_foods WHERE id = ?', [potatoId],
    );
    check('its numbers are untouched', Number(kept[0]?.energy_kcal) === 150, String(kept[0]?.energy_kcal));
    check('and it gained no portion', (await portionsFor(potatoId)).length === 1,
      String((await portionsFor(potatoId)).length));

    // Deleted, then added again. A second row under the same slug is a
    // duplicate waiting for the next sync (see the pair in librarysync), so
    // the old row comes back — as the dish just typed, not the one deleted.
    await deleteCustomFood(potatoId);
    check('a deleted dish does not block its name', (await dishNamed('Boiled potato (small)')) === null);
    const again = await saveDishFromPortion({
      name: 'Boiled potato (small)', quantity: 1, measure: 'katori', netWeightG: 75,
      energy: 65, protein: 1.5, fat: 0.1, carbs: 15, fibre: 1.3,
    });
    check('re-adding brings the same row back', again.foodId === potatoId, `${again.foodId} vs ${potatoId}`);
    const twins = await nut.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM custom_foods WHERE slug = ?', [slugFor('Boiled potato (small)')],
    );
    check('one row under that slug, deleted or not', Number(twins[0]?.n) === 1, String(twins[0]?.n));
    const revived = await nut.query<{ name: string; energy_kcal: number; deleted_at: number | null }>(
      'SELECT name, energy_kcal, deleted_at FROM custom_foods WHERE id = ?', [potatoId],
    );
    check('live again', revived[0]?.deleted_at === null, String(revived[0]?.deleted_at));
    check('under the name just typed', revived[0]?.name === 'Boiled potato (small)', String(revived[0]?.name));
    near('with the new numbers', Number(revived[0]?.energy_kcal), 86.67, 0.01);
    const ports = await portionsFor(potatoId);
    check('the deleted dish\'s portion stays deleted',
      ports.length === 1 && ports[0].measure === 'katori', JSON.stringify(ports.map((x) => x.measure)));
    check('and the new portion is the default', ports[0]?.is_default === 1, String(ports[0]?.is_default));
    const opened = await matchFood('Boiled potato (small)');
    check('logging it finds it under its new name', opened?.food.name === 'Boiled potato (small)',
      String(opened?.food.name));
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

    // Both phones changed Rajma in the same millisecond, differently. Each
    // phone holds its own and receives the other's; both must end on the same
    // version: the one whose wire content sorts lower. Played out here as this
    // phone in both seats in turn.
    const tieAt = far + 1;
    const mineR = { t: 'custom_foods' as const, k: 'rajma masala', at: tieAt, del: null,
      f: { slug: 'rajma masala', name: 'Rajma Masala', per_unit: '100g', energy_kcal: 127, protein_g: 6.2,
        fat_g: 3.1, carbs_g: 18.4, fibre_g: 5.2, notes: null, share: 0 } };
    const theirsR = { ...mineR, f: { ...mineR.f, energy_kcal: 141 } };
    const settle = async (here: typeof mineR, arriving: typeof mineR) => {
      await nut.run("UPDATE custom_foods SET energy_kcal = ?, updated_at = ? WHERE slug = 'rajma masala'", [here.f.energy_kcal, tieAt]);
      await apply([arriving]);
      return (await nut.query<{ e: number }>("SELECT energy_kcal AS e FROM custom_foods WHERE slug = 'rajma masala'"))[0].e;
    };
    const onA = await settle(mineR, theirsR);
    const onB = await settle(theirsR, mineR);
    check('two edits in the same millisecond: both phones keep the same one', onA === onB, `${onA} vs ${onB}`);
    const lower = fingerprint(mineR) < fingerprint(theirsR) ? 127 : 141;
    check('the one whose content sorts lower', onA === lower, `${onA}, expected ${lower}`);
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

    // A phone where a dish was deleted and re-added before 8 Oct 2026 holds
    // two rows under one slug, the deleted one older. An unordered LIMIT 1
    // found the deleted one, and an incoming edit, newer than its tombstone,
    // woke it up beside the live copy: two identical dishes.
    await sql(
      `INSERT INTO custom_foods (id, name, slug, per_unit, energy_kcal, updated_at, deleted_at)
       VALUES ('pair-old', 'Poha', 'poha', '100g', 999, 100, 200)`,
    );
    await sql(
      `INSERT INTO custom_foods (id, name, slug, per_unit, energy_kcal, updated_at, deleted_at)
       VALUES ('pair-new', 'Poha', 'poha', '100g', 130, 300, NULL)`,
    );
    await apply([
      { t: 'custom_foods', k: 'poha', at: 400, del: null,
        f: { slug: 'poha', name: 'Poha', per_unit: '100g', energy_kcal: 131, protein_g: 2.5,
             fat_g: 3, carbs_g: 23, fibre_g: 1.2, notes: null, share: 0 } },
      { t: 'food_portions', k: 'poha|katori', at: 400, del: null,
        f: { food_slug: 'poha', measure: 'katori', quantity: 1, net_weight_g: 120,
             is_default: 1, source: 'user' } },
    ]);
    const pair = await nut.query<{ id: string; energy_kcal: number; deleted_at: number | null }>(
      "SELECT id, energy_kcal, deleted_at FROM custom_foods WHERE slug = 'poha'",
    );
    const old = pair.find((x) => x.id === 'pair-old');
    const live = pair.find((x) => x.id === 'pair-new');
    check('a deleted twin stays deleted', old?.deleted_at != null, JSON.stringify(old));
    check('the edit lands on the live one', Number(live?.energy_kcal) === 131, JSON.stringify(live));
    const onLive = await portionsFor('pair-new');
    check('and so does its portion', onLive.length === 1 && Number(onLive[0].net_weight_g) === 120,
      JSON.stringify(onLive));
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

  // ---- the bundled list stays out of search ------------------------------
  // Upendra searched "Almond" on 11 Oct 2026 and got his one dish followed by
  // "Flour, almond", "Nuts, almonds, whole, raw" and four more he had never
  // added. A fresh test database has no bundled rows, which is why nothing
  // here had ever seen it: the rows are put in by hand, as his phone has them.
  {
    const usda = (id: string, name: string, kcal: number) =>
      sql(
        `INSERT INTO foods (id, name, source_db, per_unit, energy_kcal, protein_g, fat_g, carbs_g, fibre_g)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, name, 'USDA', '100g', kcal, 21, 50, 21, 12],
      );
    await usda('usda-almond-raw', 'Nuts, almonds, whole, raw', 584);
    await usda('usda-almond-butter', 'Almond butter, creamy', 603);
    const own = await saveDishFromPortion({
      name: 'Soaked Almonds (Naked)', quantity: 1, measure: 'piece', netWeightG: 1.6,
      energy: 7, protein: 0.3, fat: 0.6, carbs: 0.3, fibre: 0.2,
    });

    const almond = await searchFoods('Almond', 25);
    check('search lists only your own dishes',
      almond.length === 1 && almond[0].id === own.foodId, almond.map((f) => f.name).join(' | '));
    // Search only, his decision: typed words with no dish of his behind them
    // may still fall back to a reference food, and his own dish still wins
    // when both could answer.
    const typed = await matchFood('almond butter');
    check('a typed meal can still fall back to a bundled food',
      typed?.food.id === 'usda-almond-butter', JSON.stringify(typed));
    const mine = await matchFood('soaked almonds');
    check('but your own dish wins when it matches', mine?.food.id === own.foodId, JSON.stringify(mine));

    // Out again, so nothing below this block meets rows no test database has.
    await sql("DELETE FROM foods WHERE id IN ('usda-almond-raw', 'usda-almond-butter')");
    await deleteCustomFood(own.foodId as string);
  }

  // ---- the reference table follows the bundled file ----------------------
  // Nothing had loaded it since 24 Sep 2026, and the loader that existed
  // compared counts only, so a corrected calorie figure could not reach a
  // phone. A small list stands in for the file here; the file itself is
  // loaded once at the end.
  {
    const food = (id: string, name: string, kcal: number, fibre: number | null): BundledFood => ({
      id, name, source_db: 'USDA', per_unit: '100g',
      energy_kcal: kcal, protein_g: 14.3, fat_g: 67.1, carbs_g: 11.7, fibre_g: fibre,
    });
    const before = [
      food('usda-t-brazil', 'Nuts, brazilnuts, raw', 663.6, 7.5),
      food('usda-t-beans', 'Beans, black, canned', 118.4, null),
      food('usda-t-gone', 'Withdrawn food', 100, null),
    ];
    const first = await seedFoods(before);
    const has = async () => query<{ id: string; energy_kcal: number; fibre_g: number | null }>(
      "SELECT id, energy_kcal, fibre_g FROM foods WHERE id LIKE 'usda-t-%' ORDER BY id",
    );
    check('an empty reference table is filled', first.seeded && (await has()).length === 3, JSON.stringify(first));

    // A weighed portion on a reference food is a person's scale reading, and
    // it hangs on the food's id. A rewrite must leave it where it was.
    await upsertPortion({
      foodId: 'usda-t-brazil', measure: 'piece', quantity: 1, netWeightG: 5, source: 'user',
    });

    const again = await seedFoods(before);
    check('the same list writes nothing', again.seeded === false && again.inDb === 3, JSON.stringify(again));

    // The count is the same and two figures differ: what the old loader,
    // which compared counts, could not see.
    const corrected = [
      food('usda-t-brazil', 'Nuts, brazilnuts, raw', 621, 7.5),
      food('usda-t-beans', 'Beans, black, canned', 118.4, 6.69),
      food('usda-t-new', 'Newly listed food', 50, 1),
    ];
    const third = await seedFoods(corrected);
    const rows = await has();
    check('a corrected figure reaches the table',
      third.seeded && rows.find((r) => r.id === 'usda-t-brazil')?.energy_kcal === 621, JSON.stringify(rows));
    check('so does a fibre figure that was blank',
      rows.find((r) => r.id === 'usda-t-beans')?.fibre_g === 6.69, JSON.stringify(rows));
    check('a food the file dropped is gone, a new one is in',
      !rows.some((r) => r.id === 'usda-t-gone') && rows.some((r) => r.id === 'usda-t-new'), JSON.stringify(rows));
    const kept = await portionsFor('usda-t-brazil');
    check('a weighed portion on a reference food survives the rewrite',
      kept.some((p) => p.measure === 'piece' && p.net_weight_g === 5), JSON.stringify(kept));

    const empty = await seedFoods([]);
    check('an empty file wipes nothing', empty.seeded === false && (await has()).length === 3, JSON.stringify(empty));

    // The real file, through the start-up call, twice at once as StrictMode
    // does it: one rewrite, not two colliding on the primary key.
    const [a, b] = await Promise.all([startFoods(), startFoods()]);
    const count = await query<{ n: number }>('SELECT COUNT(*) AS n FROM foods');
    check('the bundled file loads whole, once',
      a === b && a.seeded && a.bundled > 300 && Number(count[0].n) === a.bundled, `${JSON.stringify(a)} rows=${count[0].n}`);
    const quiet = await searchFoods('almond', 25);
    check('and still does not show in search', quiet.every((f) => f.is_custom === 1), quiet.map((f) => f.name).join(' | '));

    // Out again. Every check below was written against a database with no
    // reference foods, and typed-meal matching reads this table. The portion
    // goes outright rather than through `deletePortion`: a tombstone would
    // sit in the library for the sync checks further down to pick up.
    await sql("DELETE FROM food_portions WHERE food_id = 'usda-t-brazil'");
    await sql('DELETE FROM foods');
  }

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

  // What "tomorrow" means after midnight is one person's habit, not the
  // phone's: her answer must not become his.
  check('nobody has been asked what tomorrow means at night', (await nightTomorrow()) === null);
  await setNightTomorrow('begun');
  check('her answer is kept', (await nightTomorrow()) === 'begun');

  await setActiveProfile(PRIMARY_PROFILE);
  check('and is not his', (await nightTomorrow()) === null);
  await setNightTomorrow('after');
  check('his is his own', (await nightTomorrow()) === 'after');
  await setActiveProfile(partner);
  check('and hers did not move', (await nightTomorrow()) === 'begun');
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

    // Thali may read it when asked about a day, and may not write.
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

  // ---- correcting a dish, and what was logged with it --------------------
  //
  // 8 Oct 2026. Before Edit dish, the only fix for a wrong dish was adding it
  // again, which saved over the old one under the old name.
  step('dish edit');
  {
    const made = await saveDishFromPortion({
      name: 'Aloo jeera', quantity: 1, measure: 'katori', netWeightG: 150,
      energy: 200, protein: 3, fat: 8, carbs: 30, fibre: 3,
    });
    const id = made.foodId as string;
    await saveMeal(await draftFromText('1 katori aloo jeera'), { mealType: 'lunch' });
    await saveMeal(await draftFromText('120 g aloo jeera'), { mealType: 'dinner' });
    await setActiveProfile(partner);
    await saveMeal(await draftFromText('1 katori aloo jeera'), { mealType: 'lunch' });
    await setActiveProfile(PRIMARY_PROFILE);

    const mine = await entriesUsing(id);
    check('his two entries are found, not hers', mine.length === 2, String(mine.length));
    // A portion the edit leaves alone, which must still follow the rename.
    const bowlId = (await upsertPortion({ foodId: id, measure: 'bowl', netWeightG: 300 })) as string;

    const cursor = Date.now();
    await new Promise((r) => setTimeout(r, 5));

    // A new name with a new slug, new numbers, and the katori reweighed.
    const edit: DishEdit = {
      name: 'Jeera aloo',
      per100: { energy_kcal: 120, protein_g: 2, fat_g: 5, carbs_g: 18, fibre_g: 2 },
      portion: { measure: 'katori', quantity: 1, netWeightG: 120 },
      others: [{ id: bowlId, measure: 'bowl', quantity: 1, netWeightG: 300 }],
    };
    const preview = previewEntries(mine, edit);
    check('the sheet counts both', preview.count === 2, String(preview.count));
    check('and adds up what they are now: 200 + 160', preview.kcalNow === 360, String(preview.kcalNow));
    check('and what they would be: 144 + 144', preview.kcalNew === 288, String(preview.kcalNew));

    const res = await saveDishEdit(id, edit, true);
    check('the edit saves under the new name', res.food?.name === 'Jeera aloo', String(res.food?.name));
    check('and rewrote both entries', res.updated === 2, String(res.updated));
    const after = await entriesUsing(id);
    const katori = after.find((e) => e.unit === 'katori');
    const grams = after.find((e) => e.unit === 'g');
    near('a katori entry takes the corrected katori', Number(katori?.net_weight_g), 120, 0.01);
    near('and the new calories', Number(katori?.energy_kcal), 144, 0.01);
    near('a weighed entry keeps its grams', Number(grams?.net_weight_g), 120, 0.01);
    near('and only its calories change', Number(grams?.energy_kcal), 144, 0.01);
    const written = after.reduce((a, e) => a + (e.energy_kcal ?? 0), 0);
    check('what the sheet promised is what was written', Math.round(written) === preview.kcalNew,
      `${written} vs ${preview.kcalNew}`);
    const labels = await query<{ label: string }>(
      'SELECT label FROM meal_items WHERE profile_id = ? AND food_id = ? AND deleted_at IS NULL',
      [PRIMARY_PROFILE, id],
    );
    check('the entries carry the new name', labels.every((l) => l.label === 'Jeera aloo'),
      labels.map((l) => l.label).join(','));

    // Hers is a record of her body. A dish edit on his phone does not reach it.
    await setActiveProfile(partner);
    const hersAfter = await entriesUsing(id);
    check('her entry is untouched',
      hersAfter.length === 1 && Number(hersAfter[0].energy_kcal) === 200 && Number(hersAfter[0].net_weight_g) === 150,
      JSON.stringify(hersAfter));
    await setActiveProfile(PRIMARY_PROFILE);

    // A new slug is a new identity to sync. The old one is left as a
    // tombstone the other phone applies to its copy; the row keeps its id.
    const rows = await query<{ id: string; slug: string; deleted_at: number | null }>(
      "SELECT id, slug, deleted_at FROM custom_foods WHERE slug IN ('aloo jeera', 'jeera aloo')",
    );
    const live = rows.find((r) => r.slug === 'jeera aloo' && r.deleted_at === null);
    const tomb = rows.find((r) => r.slug === 'aloo jeera');
    check('the dish keeps its row', live?.id === id, JSON.stringify(rows));
    check('the old slug is left as a tombstone', !!tomb && tomb.id !== id && tomb.deleted_at !== null,
      JSON.stringify(tomb));
    const wire = await collect(cursor);
    check('the other phone is told to drop the old name',
      wire.some((r) => r.t === 'custom_foods' && r.k === 'aloo jeera' && r.del !== null));
    check('and to take the new one',
      wire.some((r) => r.t === 'custom_foods' && r.k === 'jeera aloo' && r.del === null));
    check('an untouched portion travels again, under the new name',
      wire.some((r) => r.t === 'food_portions' && r.k === 'jeera aloo|bowl'),
      wire.filter((r) => r.t === 'food_portions').map((r) => r.k).join(','));
    check('and none under the old one',
      !wire.some((r) => r.t === 'food_portions' && r.f.food_slug === 'aloo jeera'));
    // Without this, the other phone's "aloo jeera" would still point at the
    // copy the tombstone just deleted, and the old name would find nothing
    // there. Portions would follow anyway — saving the default re-stamps all
    // of a dish's portions — but aliases have no such ride.
    check('the old name travels again, now pointing at the new one',
      wire.some((r) => r.t === 'food_aliases' && r.k === 'aloo jeera' && r.f.food_slug === 'jeera aloo'),
      wire.filter((r) => r.t === 'food_aliases').map((r) => `${r.k}->${r.f.food_slug}`).join(','));
    check('typing the old name still finds it', (await matchFood('aloo jeera'))?.food.id === id);

    // Punctuation only: same slug, so no second tombstone. And "keep" keeps.
    const keep = await saveDishEdit(id, { ...edit, name: 'Jeera Aloo!' }, false);
    check('a cosmetic rename saves', keep.food?.name === 'Jeera Aloo!', String(keep.food?.name));
    const under = await query<{ n: number }>("SELECT COUNT(*) AS n FROM custom_foods WHERE slug = 'jeera aloo'");
    check('without leaving a tombstone of itself', Number(under[0].n) === 1, String(under[0].n));
    check('and "keep" leaves past entries alone', keep.updated === 0, String(keep.updated));

    // Onto another dish's name: refused, nothing written.
    const onto = await saveDishEdit(id, { ...edit, name: 'dal tadka' }, true);
    check('renaming onto another dish is refused', onto.food === null && onto.clash?.name === 'Dal Tadka',
      String(onto.clash?.name));
    check('and writes nothing', (await customFood(id))?.name === 'Jeera Aloo!');

    // The form switched from katori to piece: the katori is kept beside it,
    // no longer the default, until it is removed.
    const katoriId = (await portionsFor(id)).find((p) => p.measure === 'katori')?.id as string;
    await saveDishEdit(id, {
      ...edit, name: 'Jeera Aloo!',
      portion: { measure: 'piece', quantity: 1, netWeightG: 60 },
      others: [{ id: katoriId, measure: 'katori', quantity: 1, netWeightG: 130 }],
    }, false);
    const ps = await portionsFor(id);
    check('the new measure is the default', ps.find((p) => p.measure === 'piece')?.is_default === 1,
      JSON.stringify(ps.map((p) => [p.measure, p.is_default])));
    const kept = ps.find((p) => p.measure === 'katori');
    check('the old one is kept beside it, reweighed', kept?.is_default === 0 && Number(kept?.net_weight_g) === 130,
      JSON.stringify(kept));
    await saveDishEdit(id, {
      ...edit, name: 'Jeera Aloo!',
      portion: { measure: 'piece', quantity: 1, netWeightG: 60 },
      others: [{ id: katoriId, measure: 'katori', quantity: 1, netWeightG: null }],
    }, false);
    check('and goes when removed', !(await portionsFor(id)).some((p) => p.measure === 'katori'));

    await deleteDish(id);
    check('a deleted dish leaves the table', (await customFood(id)) === null);
    const remains = await entriesUsing(id);
    check('its entries keep their numbers', remains.length === 2 && remains.every((e) => Number(e.energy_kcal) === 144),
      JSON.stringify(remains.map((e) => e.energy_kcal)));
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
      schedule: EVERY_DAY,
      long_term: false,
      private: false,
    };

    await setActiveProfile(PRIMARY_PROFILE);
    const his = await addMedicine(calcium);
    check('adding a medicine puts it in the library', (await products()) === startCount + 1);

    await setActiveProfile(partner);
    const found = await searchLibrary('calcium');
    // (name, passed, detail): a string in the middle slot is always truthy, so
    // this once passed whatever the search returned.
    check('the other person finds it there', found.map((p) => p.name).join() === 'Calcium + D3',
      JSON.stringify(found.map((p) => p.name)));
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
      ingredients: [], long_term: true, private: false, schedule: EVERY_DAY,
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
  // ---- saves as one unit (15 Oct 2026) ------------------------------------
  // Each unit is made to fail on a late write; nothing from it may be left.
  step('the overnight line');
  {
    // From the record: eaten meals count, a plan does not until ticked.
    const dayMs = 86_400_000;
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    const day = d0.getTime() - 10 * dayMs; // a quiet past day, clear of the other fixtures
    const [dish] = await draftFromText('1 katori fixture fast dal');
    const dinner = await saveMeal([dish], { mealType: 'dinner', eatenAt: day - 3 * 3_600_000 });
    const plan = await saveMeal([dish], { mealType: 'breakfast', eatenAt: day + 8 * 3_600_000, planned: true });
    const breakfast = await saveMeal([dish], { mealType: 'breakfast', eatenAt: day + 9 * 3_600_000 });
    const line = await readFastLine(day);
    check('the gap is from last night\'s dinner to the first meal eaten', line?.kind === 'overnight' && line.ms === 12 * 3_600_000,
      JSON.stringify(line));
    // "Eaten at": breakfast said to be at 7:30, not 9:00, moves the line.
    await setMealTime(breakfast, day + 7.5 * 3_600_000);
    check('a meal put at the time it was eaten', (await mealTime(breakfast)) === day + 7.5 * 3_600_000);
    check('and the overnight line follows it', (await readFastLine(day))?.kind === 'overnight' &&
      (await readFastLine(day) as { ms: number }).ms === 10.5 * 3_600_000);
    for (const id of [dinner, plan, breakfast]) await deleteMeal(id);
  }

  step('what came before a symptom');
  {
    // Five bouts of bloating, each begun at 4 pm and logged later, each after
    // a paneer lunch: from the real tables, through the collected record.
    const dayMs = 86_400_000;
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    const [paneer] = await draftFromText('1 katori fixture pattern paneer');
    const meals: string[] = [];
    const symptoms: string[] = [];
    for (let k = 1; k <= 5; k++) {
      const day = d0.getTime() - k * dayMs;
      meals.push(await saveMeal([paneer], { mealType: 'lunch', eatenAt: day + 13.5 * 3_600_000 }));
      symptoms.push(await logSymptom('bloated after lunch', { label: 'Bloating', startedAt: day + 16 * 3_600_000 }));
    }
    const stored = await query<{ started_at: number }>('SELECT started_at FROM symptoms WHERE id = ?', [symptoms[0]]);
    check('a symptom keeps when it began', Number(stored[0].started_at) === d0.getTime() - dayMs + 16 * 3_600_000, String(stored[0].started_at));
    const later = await logSymptom('bloated', { label: 'Bloating', startedAt: Date.now() + 3_600_000 });
    check('a start in the future is no start', (await query<{ s: number | null }>('SELECT started_at AS s FROM symptoms WHERE id = ?', [later]))[0].s === null);
    await removeSymptom(later);

    const x = await collectExport('full', daysNeeded('24h'));
    check('the record carries the label and the start', x.symptoms.some((s) => s.label === 'Bloating' && s.startedAt === d0.getTime() - dayMs + 16 * 3_600_000));
    const p = patternFor(x, 'Bloating', '24h', Date.now());
    const item = p.items.find((i) => i.name.toLowerCase().includes('fixture pattern paneer'));
    check('five bouts found, the paneer before every one', [p.bouts.length >= 5, item?.before, item?.of], [true, p.bouts.length, p.bouts.length], JSON.stringify(item));
    // History is newest first by when each began: the bout begun yesterday
    // afternoon sorts above the one begun two days ago, however they were logged.
    const hist = (await recentSymptoms(10)).filter((r) => symptoms.includes(r.id));
    check('history is in order of when each began', hist.map((r) => r.id).join() === [...symptoms].join(), hist.map((r) => r.started_at).join());
    for (const id of symptoms) await removeSymptom(id);
    for (const id of meals) await deleteMeal(id);
  }

  step('atomic saves');
  {
    const nut = scopedDb('nutritionist');
    const mealsWith = async (raw: string) =>
      Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM meals WHERE raw_text = ?', [raw]))[0].n);

    let threw = false;
    try {
      await nut.atomically(async (tx) => {
        const m = await tx.insert('meals', { eaten_at: Date.now(), raw_text: 'fixture atomic raw', meal_type: 'lunch', deleted_at: null });
        await tx.insert('meal_items', { meal_id: m, label: 'fine', source: 'direct', plan_state: null, deleted_at: null });
        await tx.insert('meal_items', { meal_id: m, label: 'broken', source: 'direct', plan_state: 'nonsense', deleted_at: null });
      });
    } catch {
      threw = true;
    }
    check('a unit with a bad last write fails', threw);
    check('and leaves neither the meal nor its first item', (await mealsWith('fixture atomic raw')) === 0 &&
      Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM meal_items WHERE label = 'fine'"))[0].n) === 0);

    // Through saveMeal, the way the screen saves: an item with no name is
    // refused by the table, after the meal row has been written.
    const [good] = await draftFromText('1 katori fixture atomic dal');
    threw = false;
    try {
      await saveMeal([good, { ...good, label: null as unknown as string, food: null }], { rawText: 'fixture atomic meal', mealType: 'dinner' });
    } catch {
      threw = true;
    }
    check('a meal whose second item is refused is not saved at all', threw && (await mealsWith('fixture atomic meal')) === 0);
    const ok = await saveMeal([good], { rawText: 'fixture atomic meal ok', mealType: 'dinner' });
    check('and a sound one still saves, item and all', (await mealsWith('fixture atomic meal ok')) === 1 && (await itemsFor([ok])).length === 1);
    await deleteMeal(ok);

    // A medicine: the dose rows are its last writes. A unit the table cannot
    // take there leaves no medicine and no new library entry behind.
    const medsNamed = async (name: string) =>
      Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM medications WHERE name = ? AND deleted_at IS NULL', [name]))[0].n);
    const productsNamed = async (name: string) =>
      Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM med_products WHERE name = ?', [name]))[0].n);
    threw = false;
    try {
      await addMedicine({
        name: 'Fixture atomic tablet', form: 'tablet', strength: '5 mg', ingredients: [{ name: 'Atomium', strength_text: '5 mg' }],
        // An object where a word goes: the database cannot take it.
        doses: [{ amount: 1, unit: {} as unknown as 'tablet', time_of_day: 'morning', meal: 'after' }],
        schedule: EVERY_DAY, long_term: true, private: false,
      });
    } catch {
      threw = true;
    }
    check('a medicine whose dose cannot be written is not saved at all', threw && (await medsNamed('Fixture atomic tablet')) === 0);
    check('nor is its library entry', (await productsNamed('Fixture atomic tablet')) === 0);
  }

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

  // ---- v10: how often, the tap, and the log --------------------------------
  step('schedules');
  {
    await setActiveProfile(PRIMARY_PROFILE);
    const day = medDay();
    const weekday = dateOf(day).getDay();
    const dueIds = (plan: Awaited<ReturnType<typeof readMedsDay>>) =>
      plan.groups.flatMap((g) => g.doses.map((p) => p.med.id));
    const base: MedForm = {
      name: 'Vitamin D3', form: 'tablet', strength: '60000 IU', ingredients: [],
      doses: [{ amount: 1, unit: 'tablet', time_of_day: 'morning', meal: 'after' }],
      schedule: scheduleOf('weekdays', String(weekday), null), long_term: true, private: false,
    };

    const vit = await addMedicine(base);
    check('a weekly medicine is there on its day', dueIds(await readMedsDay(day)).includes(vit));
    const vitDetail = (await medicineDetail(vit))!;
    await editMedicine(vit, { ...draftFromMedicine(vitDetail),
      schedule: scheduleOf('weekdays', String((weekday + 1) % 7), null) });
    let plan = await readMedsDay(day);
    check('and not there on a day it is not', !dueIds(plan).includes(vit));
    check('while still counted as being taken', plan.notToday.some((n) => n.med.id === vit));
    check('rather than as "times not set"', !plan.unscheduled.some((m) => m.id === vit));
    const slice = renderSlice(await collectFacts());
    check('the Doctor hears it is weekly', /Vitamin D3 60000 IU \(every \w+day;/.test(slice), slice);

    const wire = (await collectMeds(0)).find((r) => r.k === 'vitamin d3 60000 iu|1');
    check('the library sends its frequency', wire?.f.freq === 'weekdays', JSON.stringify(wire?.f));
    await setActiveProfile(partner);
    const vEntry = (await searchLibrary('vitamin d3'))[0];
    const vDraft = vEntry ? await draftFromLibrary(vEntry.id) : null;
    check('and hands it to the next person', vDraft?.schedule.freq === 'weekdays',
      JSON.stringify(vDraft?.schedule));
    await setActiveProfile(PRIMARY_PROFILE);

    // The tap: empty, taken, skipped, empty.
    const daily = await addMedicine({ ...base, name: 'Daily tablet', strength: null, schedule: EVERY_DAY });
    const find = async () =>
      (await readMedsDay(day)).groups.flatMap((g) => g.doses).find((p) => p.med.id === daily)!;
    await cycleDose(await find(), day);
    check('one tap is taken', (await find()).state === 'taken');
    await cycleDose(await find(), day);
    check('a second is skipped', (await find()).state === 'skipped');
    await cycleDose(await find(), day);
    const cleared = await find();
    check('a third clears it', cleared.state === 'due' || cleared.state === 'later', cleared.state);
    const answers = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM intake_events
        WHERE profile_id = ? AND medication_id = ? AND for_day = ? AND deleted_at IS NULL`,
      [PRIMARY_PROFILE, daily, day]);
    check('leaving no live answer behind', Number(answers[0].n) === 0, String(answers[0].n));

    // The log, judged by the schedule each day had. Backdated by hand: five
    // days of a daily schedule nobody ticked, one of them fixed from the log.
    const back = addDays(day, -5);
    const hist = await addMedicine({ ...base, name: 'Backdated', strength: null, schedule: EVERY_DAY });
    await sql('UPDATE medications SET started_on = ? WHERE id = ?', [back, hist]);
    await sql('UPDATE med_doses SET from_day = ? WHERE medication_id = ?', [back, hist]);
    const twoAgo = addDays(day, -2);
    const thatDay = (await readLog(twoAgo, twoAgo)).plans[0].groups.flatMap((g) => g.doses)
      .find((p) => p.med.id === hist)!;
    check('a past day\'s dose reads as missed', thatDay?.state === 'missed', thatDay?.state);
    await cycleDose(thatDay, twoAgo);

    const log = await readLog(back, addDays(day, -1));
    const mine = log.meds.find((m) => m.med.id === hist)!;
    check('five past days were due', mine.tally.taken + mine.tally.skipped + mine.tally.missed === 5,
      JSON.stringify(mine.tally));
    check('one fixed from the log, four missed', mine.tally.taken === 1 && mine.tally.missed === 4,
      JSON.stringify(mine.tally));
    const fixed = log.plans.find((p) => p.day === twoAgo)!.groups.flatMap((g) => g.doses)
      .find((p) => p.med.id === hist)!;
    check('and the fixed one is marked as entered later', fixed.late);

    const histDetail = (await medicineDetail(hist))!;
    await editMedicine(hist, { ...draftFromMedicine(histDetail),
      schedule: { freq: 'alternate', days: [], from: null } });
    const after = (await readLog(back, addDays(day, -1))).meds.find((m) => m.med.id === hist)!;
    check('changing the schedule does not rewrite the past',
      JSON.stringify(after.tally) === JSON.stringify(mine.tally), JSON.stringify(after.tally));
    const altRows = await query<{ freq_from: string }>(
      'SELECT freq_from FROM med_doses WHERE medication_id = ? AND deleted_at IS NULL', [hist]);
    check('an alternate rhythm starts the day it was set', altRows[0]?.freq_from === day,
      JSON.stringify(altRows));
    const reTick = (await readMedsDay(day)).groups.flatMap((g) => g.doses).find((p) => p.med.id === hist);
    check('and is due on that first day', reTick !== undefined);

    // ---- stopping a medicine stops every entry of it --------------------
    const twice = { ...base, name: 'Entered twice', strength: null, schedule: EVERY_DAY };
    const first = await addMedicine(twice);
    const second = await addMedicine(twice);
    const bystander = await addMedicine({ ...twice, name: 'Someone else' });
    check('one tap of Stop stops both entries', (await stopMedication(first)) === 2);
    const still = dueIds(await readMedsDay(day));
    check('and neither is left on the schedule', !still.includes(first) && !still.includes(second));
    check('a different medicine is untouched', still.includes(bystander));
    check('both are in Stopped', (await listStopped()).filter((m) => m.name === 'Entered twice').length === 2);
    check('Resume brings back the two stopped together', (await resumeMedication(second)) === 2);
    check('and they are due again', dueIds(await readMedsDay(day)).filter((id) => id === first || id === second).length === 2);
    const legacyA = await addMedication({ name: 'Old Style', dose_text: null, schedule: 'daily', notes: null });
    const legacyB = await addMedication({ name: 'old style', dose_text: null, schedule: 'daily', notes: null });
    check('entries from before the library are matched by name', (await stopMedication(legacyA)) === 2);
    check('whatever the case', (await listStopped()).some((m) => m.id === legacyB));

    const weekSlice = renderSlice(await collectFacts());
    check('the Doctor hears what was missed', /Last 7 days: \d+ doses taken, \d+ skipped, [1-9]\d* missed\./
      .test(weekSlice), weekSlice);
  }

  // ---- medicine reference lists: importing, and leaving everything else be --
  step('reference lists');
  {
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const t of ['meals', 'meal_items', 'custom_foods', 'food_portions', 'food_aliases', 'medications', 'med_products']) {
        out[t] = Number((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
      }
      return out;
    };
    const before = await counts();

    // The bulk path is for the reference table and nothing else.
    let refusedHere = false;
    try {
      await scopedDb('nutritionist').bulkInsert('meals', ['id'], [['x']]);
    } catch {
      refusedHere = true;
    }
    check('a bulk write into meals is refused by the scoped handle', refusedHere);
    let refusedInWorker = '';
    try {
      await bulkInsert('custom_foods', ['id', 'name', 'updated_at'], [['x', 'x', 1]]);
    } catch (e) {
      refusedInWorker = (e as Error).message;
    }
    check('and by the worker itself, below every other layer', refusedInWorker.includes('not allowed'), refusedInWorker);

    const header = ['name', 'Is_discontinued', 'manufacturer_name', 'type', 'pack_size_label', 'short_composition1', 'short_composition2'];
    const rows: string[][] = [];
    for (let i = 0; i < 5200; i++) {
      rows.push([`Fixturol ${i} Tablet`, i % 50 === 0 ? 'TRUE' : 'FALSE', 'Maker', 'allopathy', 'strip of 10 tablets',
        `Paracetamol (${500 + (i % 3) * 50}mg)`, i % 2 ? 'Caffeine (30mg)' : '']);
    }
    rows.push(['Dolo 650 Tablet', 'FALSE', 'Micro Labs', 'allopathy', 'strip of 15 tablets', 'Paracetamol (650mg)', '']);
    const preset = presetFor(header)!;
    const csv = [header, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
    let last = 0;
    const res = await importList({ kind: 'file', file: new File([csv], 'india.csv') },
      { name: 'Fixture India', tag: 'India' }, preset.mapping, (p) => { last = p.fraction; });
    check('a CSV list imports every medicine it can read', res.imported === 5201 - 104, String(res.imported));
    check('and counts the discontinued it left out', res.skips.discontinued === 104, JSON.stringify(res.skips));
    check('progress reaches the end', last === 1, String(last));
    check('the list is ready', res.set.status === 'ready' && res.set.row_count === res.imported);

    const hits = await searchReference('dolo 6');
    check('search finds by the start of the name', hits.length === 1 && hits[0].name === 'Dolo 650 Tablet',
      JSON.stringify(hits));
    check('with its ingredients and source tag',
      hits[0]?.ingredients[0]?.name === 'Paracetamol' && hits[0]?.ingredients[0]?.strength === '650mg' && hits[0]?.tag === 'India');
    check('a discontinued medicine is not offered', (await searchReference('fixturol 0 tablet')).length === 0);

    const after = await counts();
    check('no meal, dish, portion, alias or medicine row changed', JSON.stringify(after) === JSON.stringify(before),
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // A failed import leaves nothing; a failed replace leaves the old list.
    const sets = async () => Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM med_ref_sets'))[0].n);
    const setsBefore = await sets();
    let failed = '';
    try {
      await importList({ kind: 'rows', header: ['name', 'other'], rows: [['A', 'b']] },
        { name: 'Broken', tag: 'X' }, preset.mapping, undefined, res.set.id);
    } catch (e) {
      failed = (e as Error).message;
    }
    check('a list missing a mapped column is refused in words', failed.includes('no column'), failed);
    check('and leaves no list behind', (await sets()) === setsBefore);
    check('while the list it would have replaced is untouched', (await searchReference('dolo 6')).length === 1);

    const again = await importList({ kind: 'rows', header, rows: rows.slice(-1) },
      { name: 'Fixture India', tag: 'India' }, preset.mapping, undefined, res.set.id);
    check('a replace swaps the old list for the new', again.imported === 1 && (await searchReference('fixturol')).length === 0);

    // An .xlsx goes the same way.
    const enc = (t: string) => strToU8(t);
    const xlsx = zipSync({
      'xl/workbook.xml': enc('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': enc('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': enc('<worksheet><sheetData>'
        + '<row><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Contains</t></is></c></row>'
        + '<row><c r="A2" t="inlineStr"><is><t>Thai Cold Syrup</t></is></c><c r="B2" t="inlineStr"><is><t>Guaifenesin (100mg/5ml) + Dextromethorphan (10mg/5ml)</t></is></c></row>'
        + '</sheetData></worksheet>'),
    });
    const fromXlsx = await importList({ kind: 'file', file: new File([xlsx], 'thai.xlsx') },
      { name: 'Fixture Thai', tag: 'Thailand' }, { name: 'Product', ingredients: ['Contains'] });
    const thai = await searchReference('thai cold');
    check('an .xlsx list imports too', fromXlsx.imported === 1 && thai[0]?.ingredients.length === 2 && thai[0]?.tag === 'Thailand',
      JSON.stringify(thai));

    // An import the app was closed during is cleared on the next start.
    await sql("INSERT INTO med_ref_sets (id, name, tag, builtin, status, row_count, skipped, updated_at) VALUES ('stale', 'Half', 'X', 0, 'importing', 0, 0, 1)");
    await sql("INSERT INTO med_ref_items (id, set_id, name, name_norm, ingredients, discontinued, updated_at) VALUES ('stale.1', 'stale', 'Halfway Tablet', 'halfway tablet', '[]', 0, 1)");
    check('a half-finished list is never searched', (await searchReference('halfway')).length === 0);
    // A live import elsewhere — another tab, or React running an effect twice
    // — is not stale: its set row was touched a moment ago.
    await sql("INSERT INTO med_ref_sets (id, name, tag, builtin, status, row_count, skipped, updated_at) VALUES ('live', 'Live', 'X', 0, 'importing', 0, 0, ?)", [Date.now()]);
    check('an import still writing is left alone', (await clearStaleImports()) === 1 &&
      Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM med_ref_sets WHERE id = 'live'"))[0].n) === 1);
    await sql("DELETE FROM med_ref_sets WHERE id = 'live'");
    check('and the abandoned one is cleared on the next start',
      Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM med_ref_items WHERE set_id = 'stale'"))[0].n) === 0);

    // The HSA register, bundled until 15 Oct 2026, leaves a phone that has
    // it: written here as the old loader wrote it (builtin = 1). The
    // imported fixture lists, and every medicine, stay.
    await sql("INSERT INTO med_ref_sets (id, name, tag, builtin, status, row_count, skipped, version, updated_at) VALUES ('hsa-old', 'Singapore HSA register', 'HSA', 1, 'ready', 1, 0, '2026-09-01', 1)");
    await sql(`INSERT INTO med_ref_items (id, set_id, name, name_norm, ingredients, discontinued, updated_at) VALUES ('hsa-old.1', 'hsa-old', 'NORPHEN TABLET', 'norphen tablet', '[{"name":"Orphenadrine","strength":"35 mg"}]', 0, 1)`);
    check('the bundled register is searched while it is there', (await searchReference('norphen'))[0]?.tag === 'HSA');
    const listsBefore = (await listSets()).filter((x) => x.builtin === 0).map((x) => x.id).sort().join();
    const medsBefore = JSON.stringify(await query('SELECT id, name FROM med_products ORDER BY id'));
    check('a start removes it', (await retireBundled()) === 1 && (await listSets()).every((x) => x.builtin === 0));
    check('with its rows', Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM med_ref_items WHERE set_id = 'hsa-old'"))[0].n) === 0 &&
      (await searchReference('norphen')).length === 0);
    check('and leaves every imported list', (await listSets()).filter((x) => x.builtin === 0).map((x) => x.id).sort().join() === listsBefore);
    check('and every saved medicine', JSON.stringify(await query('SELECT id, name FROM med_products ORDER BY id')) === medsBefore);
    check('a second start finds nothing to do', (await retireBundled()) === 0);
    // A Singapore list someone imported themselves is theirs, and stays.
    await sql("INSERT INTO med_ref_sets (id, name, tag, builtin, status, row_count, skipped, updated_at) VALUES ('hsa-mine', 'My HSA import', 'HSA', 0, 'ready', 1, 0, 1)");
    await sql(`INSERT INTO med_ref_items (id, set_id, name, name_norm, ingredients, discontinued, updated_at) VALUES ('hsa-mine.1', 'hsa-mine', 'NORPHEN TABLET', 'norphen tablet', '[]', 0, 1)`);
    check('an imported Singapore list is never retired', (await retireBundled()) === 0 && (await searchReference('norphen'))[0]?.setId === 'hsa-mine');
    await sql("DELETE FROM med_ref_items WHERE set_id = 'hsa-mine'");
    await sql("DELETE FROM med_ref_sets WHERE id = 'hsa-mine'");
    check('and still no meal row changed', JSON.stringify(await counts()) === JSON.stringify(before));
  }

  // ---- v13: meals planned ahead ---------------------------------------------
  step('planned meals');
  {
    await setActiveProfile(PRIMARY_PROFILE);
    const today = dayAt(0);
    const tomorrow = dayAt(1);
    // A label nothing else in this run logs, so recents and the slice can be
    // asked about it by name. 300 Cal, typed straight off a label.
    const [raw] = await draftFromText('1 piece fixture thali');
    const thali = { ...raw, energy_kcal: 300, protein_g: 12, fat_g: 10, carbs_g: 40, fibre_g: 5 };
    const listedRows = async (day: number) =>
      (await readDay(day)).listed.flatMap((g) => g.items).filter((i) => i.label === thali.label);

    // Tomorrow's lunch, planned.
    await saveMeal([thali], { mealType: 'lunch', eatenAt: tomorrow + 12 * 3_600_000, planned: true });
    let ahead = await readDay(tomorrow);
    check('a meal planned for tomorrow is listed', (await listedRows(tomorrow)).length === 1);
    check('as planned', (await listedRows(tomorrow))[0]?.plan_state === 'planned');
    check('and counts toward nothing', ahead.totals[0] === 0 && ahead.items.length === 0 && ahead.groups.length === 0,
      JSON.stringify(ahead.totals));
    check('its calories are the grey part of the bar', ahead.planned[0] === 300 && ahead.planned[1] === 12,
      JSON.stringify(ahead.planned));
    check('and of its slot', ahead.listed.find((g) => g.slot === 'lunch')?.planned[0] === 300);
    const marks = await loggedDays(tomorrow, dayAt(2));
    check('the calendar marks tomorrow as planned, not eaten',
      marks.planned.has(localDayKey(tomorrow)) && !marks.eaten.has(localDayKey(tomorrow)));
    let refused = false;
    try {
      await cyclePlan((await listedRows(tomorrow))[0], tomorrow);
    } catch {
      refused = true;
    }
    check('it cannot be ticked before its day', refused);
    check('and is still planned after the attempt', (await listedRows(tomorrow))[0]?.plan_state === 'planned');

    // Today: dinner added at lunchtime.
    const before = await readDay(today);
    const factsBefore = await collectFacts();
    await saveMeal([thali], { mealType: 'dinner', eatenAt: Date.now(), planned: true });
    let now = await readDay(today);
    check("tonight's planned dinner leaves today's totals alone",
      JSON.stringify(now.totals) === JSON.stringify(before.totals), `${now.totals} vs ${before.totals}`);
    check('and the count Home reads', now.items.length === before.items.length);
    check('and Insights\' top contributors',
      !contributors(now, 0).some((c) => c.label === thali.label));
    check('but is on the day screen with its circle', (await listedRows(today))[0]?.plan_state === 'planned');
    let facts = await collectFacts();
    check('the Doctor is not told about a plan',
      JSON.stringify(facts.todayTotals) === JSON.stringify(factsBefore.todayTotals) &&
        !facts.mealsToday.some((m) => m.items.some((i) => i.includes(thali.label))),
      JSON.stringify(facts.todayTotals));
    check('recents do not offer a plan', !(await recentItems()).some((r) => r.label === thali.label));

    // The circle: planned → eaten → skipped → planned.
    const row = async () => (await listedRows(today))[0];
    await cyclePlan(await row(), today);
    now = await readDay(today);
    check('ticked, it is eaten', (await row()).plan_state === 'eaten');
    // Ticked on its own day, it was eaten about now, not when it was planned.
    const stamped = await query<{ eaten_at: number }>('SELECT eaten_at FROM meals WHERE id = ?', [(await row()).meal_id]);
    check('and takes the time of the tick', Math.abs(Number(stamped[0].eaten_at) - Date.now()) < 60_000,
      String(stamped[0].eaten_at));
    near('and counts: +300 Cal today', now.totals[0] - before.totals[0], 300, 0.01);
    check('no longer grey', now.planned[0] === 0);
    facts = await collectFacts();
    near('the Doctor now counts it', facts.todayTotals.energy - factsBefore.todayTotals.energy, 300, 0.01);
    check('recents offer it once eaten', (await recentItems()).some((r) => r.label === thali.label));
    await cyclePlan(await row(), today);
    now = await readDay(today);
    check('a second tap skips it', (await row()).plan_state === 'skipped');
    check('skipped counts toward nothing', JSON.stringify(now.totals) === JSON.stringify(before.totals));
    check('and is not planned either', now.planned[0] === 0);
    check('but stays on the list', (await listedRows(today)).length === 1);
    await cyclePlan(await row(), today);
    check('a third makes it planned again', (await row()).plan_state === 'planned');

    // Ticked a day late, it takes its slot's usual hour on its own day.
    const yesterday = today - 86_400_000;
    const lateId = await saveMeal([{ ...thali, label: 'fixture late tick' }],
      { mealType: 'lunch', eatenAt: yesterday + 12 * 3_600_000, planned: true });
    const lateRow = (await itemsFor([lateId]))[0];
    await cyclePlan(lateRow, yesterday);
    const lateAt = await query<{ eaten_at: number }>('SELECT eaten_at FROM meals WHERE id = ?', [lateId]);
    check('ticked the next day, lunch is put at 13:00 on its day',
      Number(lateAt[0].eaten_at) === yesterday + 13 * 3_600_000, new Date(Number(lateAt[0].eaten_at)).toString());
    await deleteMeal(lateId);

    // A meal logged as eaten has no circle; a tap on it changes nothing.
    const [plain] = await draftFromText('1 piece fixture plain');
    await saveMeal([{ ...plain, energy_kcal: 50 }], { mealType: 'lunch' });
    const plainRow = (await readDay(today)).listed.flatMap((g) => g.items)
      .find((i) => i.label === plain.label)!;
    check('a meal logged as eaten is stored with no plan', plainRow.plan_state === null);
    check('and a tap leaves it so', (await cyclePlan(plainRow, today)) === null &&
      (await readDay(today)).listed.flatMap((g) => g.items).find((i) => i.label === plain.label)?.plan_state === null);

    // Before planning existed, "meals today" had no upper bound. A meal
    // stamped tomorrow — however it got there — is not today's.
    const factsMid = await collectFacts();
    await saveMeal([{ ...thali, label: 'fixture tomorrow eaten' }],
      { mealType: 'lunch', eatenAt: tomorrow + 12 * 3_600_000 });
    facts = await collectFacts();
    check("tomorrow's rows stay out of the Doctor's today",
      JSON.stringify(facts.todayTotals) === JSON.stringify(factsMid.todayTotals) &&
        facts.mealsToday.length === factsMid.mealsToday.length,
      JSON.stringify([facts.todayTotals, factsMid.todayTotals]));

    // The 7-day average counts local days. Half past midnight here is the
    // previous day in UTC whenever the offset is ahead of UTC, as at +05:30.
    await saveMeal([{ ...thali, label: 'fixture early chai', energy_kcal: 40 }],
      { mealType: 'breakfast', eatenAt: today + 30 * 60_000 });
    const eatenTimes = await query<{ eaten_at: number }>(
      `SELECT m.eaten_at FROM meals m JOIN meal_items i ON i.meal_id = m.id
        WHERE m.profile_id = ? AND m.deleted_at IS NULL AND i.deleted_at IS NULL
          AND (i.plan_state IS NULL OR i.plan_state = 'eaten')
          AND m.eaten_at >= ? AND m.eaten_at < ?`,
      [PRIMARY_PROFILE, dayAt(-6), dayAt(1)]);
    const localDays = new Set(eatenTimes.map((r) => localDayKey(r.eaten_at))).size;
    facts = await collectFacts();
    check(`the week counts local days (${localDays}, offset ${-new Date().getTimezoneOffset()} min)`,
      facts.nutrition7d.daysLogged === localDays, String(facts.nutrition7d.daysLogged));

    // One person's plan is not the other's.
    await setActiveProfile(partner);
    check("the partner's tomorrow is empty", (await readDay(tomorrow)).listed.length === 0);
    await setActiveProfile(PRIMARY_PROFILE);

    // The column itself refuses anything but the three states.
    let bad = false;
    try {
      await sql("UPDATE meal_items SET plan_state = 'maybe' WHERE profile_id = ?", [PRIMARY_PROFILE]);
    } catch {
      bad = true;
    }
    check('the database refuses a fourth state', bad);
  }

  // ---- the "For AI" file, read from the real record ----------------------
  //
  // The wording is tested without a database; this is the reading. The check
  // that matters most is the last one: a report is the one place a whole
  // period of someone's record leaves the app in a single file, and it must
  // be one person's.
  step('export');
  {
    await setActiveProfile(PRIMARY_PROFILE);
    const stamp = `marker${Date.now()}`;
    const mine = await logSymptom(`${stamp} his headache`);
    await saveMeal(await draftFromText('1 katori dal tadka'), { mealType: 'lunch' });
    await setActiveProfile(partner);
    const hers = await logSymptom(`${stamp} her headache`);
    await setActiveProfile(PRIMARY_PROFILE);

    const input = await collectExport('full', 7);
    const text = buildExport(input);
    const today = localDayKey(Date.now());
    check('seven days, ending today', input.days.length === 7 && input.days[6] === today, input.days.join(','));
    check('his meal is in it, by its dish', /dal tadka/i.test(text));
    const eaten = input.meals.filter((m) => m.day === today).flatMap((m) => m.items)
      .filter((i) => i.plan_state === null || i.plan_state === 'eaten');
    const fileKcal = eaten.reduce((sum, i) => sum + (i.energy_kcal ?? 0), 0);
    const screenKcal = (await readDay()).totals[0];
    near('today in the file adds up to what the day screen shows', fileKcal, screenKcal, 0.5);
    check('a dose row for each day of the period', input.doseDays.length === 7, String(input.doseDays.length));
    const taking = (await listActive()).map((m) => m.name);
    check('every medicine he takes is listed', taking.every((n) => text.includes(n)), taking.join(','));
    check('his symptom is quoted', text.includes(`${stamp} his headache`));
    check('hers is not in his file', !text.includes(`${stamp} her headache`));
    const names = (await listProfiles()).map((p) => p.name).filter((n) => n.length > 3);
    check('no profile name is in the file', names.every((n) => !text.includes(n)), names.join(','));
    check('nor an id of any row', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text));

    await setActiveProfile(partner);
    const herText = buildExport(await collectExport('full', 7));
    check('her file has her symptom and not his',
      herText.includes(`${stamp} her headache`) && !herText.includes(`${stamp} his headache`));
    await removeSymptom(hers);
    await setActiveProfile(PRIMARY_PROFILE);
    await removeSymptom(mine);
    check('an undone symptom leaves the next file', !buildExport(await collectExport('full', 7)).includes(stamp));
  }

  // ---- a day planned in Ask Mealo -----------------------------------------
  // "Plan tomorrow so I hit 90 g protein, using things I usually eat." Its
  // own person, so that the four weeks it reads hold only these meals.
  {
    const was = activeProfile();
    const planner = await createProfile('Planner');
    await setActiveProfile(planner);
    const dishIds: Record<string, string> = {};
    for (const [name, grams, energy, protein] of [
      ['Plan poha', 150, 270, 6], ['Plan paneer bhurji', 150, 300, 20], ['Plan dal', 150, 180, 9],
      ['Plan rice', 150, 200, 4], ['Plan chicken curry', 200, 320, 30],
    ] as const) {
      dishIds[name] = (await saveDishFromPortion({ name, quantity: 1, measure: 'katori', netWeightG: grams, energy, protein, fat: 5, carbs: 30, fibre: 2 })).foodId as string;
    }
    const ate = async (daysAgo: number, slot: 'breakfast' | 'lunch' | 'dinner', text: string, planned = false) =>
      saveMeal(await draftFromText(text), { mealType: slot, eatenAt: dayAhead(-daysAgo) + (slot === 'breakfast' ? 8 : slot === 'lunch' ? 13 : 20) * 3_600_000, planned });

    const nothing = await buildPlan({ ahead: 1, protein: null, kcal: null });
    check('with nothing logged there is no plan, and the card says why', nothing.choices.length === 0 && /Not enough to plan from yet/.test(nothing.empty ?? ''), JSON.stringify(nothing.empty));

    for (const d of [1, 2, 3]) await ate(d, 'breakfast', '1 katori plan poha');
    for (const d of [4, 5]) await ate(d, 'breakfast', '1 katori plan paneer bhurji');
    for (const d of [1, 2, 3, 4]) await ate(d, 'lunch', '1 katori plan dal, 1 katori plan rice');
    for (const d of [1, 2, 3]) await ate(d, 'dinner', '1 katori plan chicken curry, 1 katori plan rice');
    for (const d of [4, 5, 6]) await ate(d, 'dinner', '2 katori plan dal');
    // Neither of these is something this person usually eats: a plan that
    // was never ticked, and a meal with a line the food table has no dish for.
    for (const d of [1, 2, 3, 4, 5]) await ate(d, 'breakfast', '3 katori plan chicken curry', true);
    for (const d of [1, 2, 3]) await ate(d, 'lunch', '1 katori plan dal, 1 zzqx unheard-of thing');
    await saveTargets({ energy_kcal: 1500, protein_g: 60 });

    const tomorrow = dayAhead(1);
    const plain = await buildPlan({ ahead: 1, protein: null, kcal: null });
    const first = plain.choices[0];
    check('a day is built for each usual meal time', first.meals.map((m) => m.slot).join(','), 'breakfast,lunch,dinner');
    const allItems = plain.choices.flatMap((c) => c.meals.flatMap((m) => m.items));
    check('only from the person\'s own dishes', allItems.every((i) => i.food !== null && Object.values(dishIds).includes(i.food.id)), allItems.map((i) => i.label).join('|'));
    check('a plan never ticked is not a usual meal', !plain.choices.some((c) => c.meals.some((m) => m.slot === 'breakfast' && m.items.some((i) => i.label === 'Plan chicken curry'))));
    check('nor is a meal with a line that matched no dish', !plain.choices.some((c) => c.meals.some((m) => m.slot === 'lunch' && m.items.length === 1)));
    check('the amounts are the ones logged', first.meals.find((m) => m.slot === 'lunch')!.items.map((i) => `${i.quantity} ${i.unit} ${i.label}`).join(', '), '1 katori Plan dal, 1 katori Plan rice');
    check('the totals are the rows added up',
      Math.round(first.totals.energy_kcal) === Math.round(first.meals.reduce((n, m) => n + m.items.reduce((k, i) => k + (i.energy_kcal ?? 0), 0), 0)), JSON.stringify(first.totals));
    check('the saved targets are the aim when none is typed', plain.aim.protein === 60 && plain.aim.kcal === 1500 && plain.aim.proteinAsked === false, JSON.stringify(plain.aim));
    check('and the plan stays under the calorie target when it can', first.dayTotals.energy_kcal <= 1500, String(first.dayTotals.energy_kcal));

    const asked = await buildPlan({ ahead: 1, protein: 80, kcal: null });
    const best = asked.choices[0];
    check('a protein figure brings in the meals that carry it',
      best.meals.find((m) => m.slot === 'breakfast')!.items[0].label === 'Plan paneer bhurji' && best.meals.find((m) => m.slot === 'dinner')!.items[0].label === 'Plan chicken curry',
      best.meals.map((m) => m.items.map((i) => i.label).join('+')).join(' / '));
    // 20 + (9 + 4) + (30 + 4): the most these meals hold. Short of 80, and it says so.
    check('it says how far short it is, and does not stretch a portion', Math.round(best.dayTotals.protein_g) === 67 && best.line!.startsWith('67 g protein, 13 g under the 80 g you asked for'), best.line ?? '');

    const todayBefore = (await mealsOn(dayAhead(0))).length;
    const ids = await savePlan(tomorrow, best, 'plan tomorrow so I hit 80 g protein');
    const stored = await itemsFor(ids);
    const onDay = await mealsOn(tomorrow);
    check('confirmed, it is three planned meals on that day', onDay.length === 3 && stored.length === 5 && stored.every((i) => i.plan_state === 'planned'), JSON.stringify(stored.map((i) => i.plan_state)));
    check('stamped at noon, as a meal planned in Track meals is', onDay.every((m) => m.eaten_at === tomorrow + 12 * 3_600_000));
    check('in the slots the card showed', onDay.map((m) => m.meal_type).sort().join(','), 'breakfast,dinner,lunch');
    check('today is untouched', (await mealsOn(dayAhead(0))).length === todayBefore);
    const planned = await readDay(tomorrow);
    check('and Track meals counts it as planned, not eaten', Math.round(planned.planned[0]) === Math.round(best.totals.energy_kcal) && planned.totals[0] === 0,
      `${planned.planned[0]} planned, ${planned.totals[0]} eaten`);

    const full = await buildPlan({ ahead: 1, protein: null, kcal: null });
    check('a day already planned has nothing left to plan', full.choices.length === 0 && /Nothing left to plan/.test(full.empty ?? '') && full.kept.length === 3, JSON.stringify(full.kept));

    for (const id of ids) await deleteMeal(id);
    check('undo takes the whole plan back', (await mealsOn(tomorrow)).length === 0);

    // Lunch decided already: the plan is the rest of the day, with lunch counted.
    const lunchId = await saveMeal(await draftFromText('2 katori plan dal'), { mealType: 'lunch', eatenAt: tomorrow + 12 * 3_600_000, planned: true });
    const around = await buildPlan({ ahead: 1, protein: null, kcal: null });
    check('a meal time that already has something is left alone',
      around.kept.join(',') === 'lunch' && around.choices.every((c) => c.meals.every((m) => m.slot !== 'lunch')), JSON.stringify(around.kept));
    check('and counted in the day', Math.round(around.choices[0].dayTotals.energy_kcal) === Math.round(around.choices[0].totals.energy_kcal + 360), JSON.stringify(around.choices[0].dayTotals));
    await deleteMeal(lunchId);

    // A dish corrected since it was eaten is planned at the corrected figure.
    await sql('UPDATE custom_foods SET energy_kcal = energy_kcal * 2 WHERE id = ?', [dishIds['Plan poha']]);
    const repriced = await buildPlan({ ahead: 1, protein: null, kcal: null });
    const poha = repriced.choices.flatMap((c) => c.meals.flatMap((m) => m.items)).find((i) => i.label === 'Plan poha');
    check('today\'s numbers, not the ones an old entry stored', Math.round(poha?.energy_kcal ?? 0) === 540, String(poha?.energy_kcal));

    await deleteCustomFood(dishIds['Plan chicken curry']);
    const without = await buildPlan({ ahead: 1, protein: null, kcal: null });
    check('a deleted dish is never planned', without.choices.length > 0 && !without.choices.some((c) => c.meals.some((m) => m.items.some((i) => i.label === 'Plan chicken curry'))),
      without.choices[0]?.meals.map((m) => m.items.map((i) => i.label).join('+')).join(' / '));

    await setActiveProfile(PRIMARY_PROFILE);
    const other = await buildPlan({ ahead: 1, protein: null, kcal: null });
    check('one person\'s meals never plan another\'s day', !other.choices.some((c) => c.meals.some((m) => m.items.some((i) => i.label.startsWith('Plan ')))));
    await setActiveProfile(was);
  }

  // ---- the weekly summary, read from the real record ---------------------
  // Its own person, so the weeks hold only these meals. What is tested here
  // is the reading: the week's days and the week before split at Sunday in
  // local time, from one read of the record, and one person's only.
  step('the week');
  {
    const was = activeProfile();
    const weekly = await createProfile('Weekly');
    await setActiveProfile(weekly);
    await saveDishFromPortion({ name: 'Week khichdi', quantity: 1, measure: 'katori', netWeightG: 150, energy: 200, protein: 10, fat: 5, carbs: 30, fibre: 2 });
    const at = (iso: string, h: number) => {
      const d = dateOf(iso);
      d.setHours(h, 0, 0, 0);
      return d.getTime();
    };
    const latest = latestWeek(localDayKey(Date.now()));
    const khichdi = await draftFromText('1 katori week khichdi');
    const ate = (iso: string, h: number) => saveMeal(khichdi, { mealType: h < 11 ? 'breakfast' : h < 17 ? 'lunch' : 'dinner', eatenAt: at(iso, h) });
    await ate(latest, 13);
    await ate(addDays(latest, 3), 13);
    await ate(addDays(latest, 6), 23);
    // Saturday night before it: the week before, not this one.
    await ate(addDays(latest, -1), 22);
    // The week still running is in neither, when it has begun.
    if (at(addDays(latest, 7), 0) + 3_600_000 < Date.now()) await ate(addDays(latest, 7), 1);

    const { cur, prev } = await readWeek(latest);
    check('the week holds its own three days and nothing either side', cur.daysLogged === 3 && prev.daysLogged === 1, `${cur.daysLogged} / ${prev.daysLogged}`);
    near('its calories are the meals added up, over logged days', cur.macros.energy_kcal.avg ?? -1, 200, 0.5);
    check('its dishes are this person\'s', cur.topDishes.calories.join() === 'Week khichdi', cur.topDishes.calories.join());

    await markWeekShown(latest);
    check('the week is marked shown for this person', (await weekShown()) === latest);
    await keepWeek(latest, { lead: 'A week.', better: [], workOn: [], removed: 0 }, 'basis');
    check('and its lines are kept for this person', (await keptWeek(latest))?.lead === 'A week.');

    await setActiveProfile(was);
    const other = await readWeek(latest);
    check('another person\'s week has none of these meals', !other.cur.topDishes.calories.includes('Week khichdi') && !other.prev.topDishes.calories.includes('Week khichdi'));
    check('nor these lines, nor this mark', (await keptWeek(latest)) === null && (await weekShown()) !== latest);
  }

  // ---- Show working: off unless chosen, and "exact" means after R5 --------
  step('show working');
  {
    const { showsWorking, setShowsWorking } = await import('../../src/domain/working');
    const { asSent, clearIdentityCache } = await import('../../src/llm/adapter');
    check('Show working is off on a phone where nobody turned it on', (await showsWorking()) === false);
    await setShowsWorking(true);
    check('on once switched on', (await showsWorking()) === true);
    await setShowsWorking(false);
    check('and off again', (await showsWorking()) === false);
    clearIdentityCache();
    const name = (await listProfiles()).map((p) => p.name).find((n) => n.length > 3) ?? '';
    const sent = await asSent(`DATA\n{"note":"${name} had dal"}`);
    check('"exactly what was sent" is the scrubbed text, without a profile name', !!name && !sent.includes(name) && sent.includes('had dal'), sent);
  }

  // ---- reminders: the rings follow the record -----------------------------
  // What rings is worked out from the record each time it changes. A ticked
  // dose, a stopped medicine and a logged meal each have to take their ring
  // away, and nothing else may.
  {
    const was = activeProfile();
    const ringer = await createProfile('Rings');
    await setActiveProfile(ringer);
    // Ten this morning: the morning reminder (08:00) has passed, tonight's has not.
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const s = { ...DEFAULT_REMINDERS, on: true, profileId: ringer, names: true };
    const of = async (kind: 'doses' | 'meals') => (await buildRings(s, now)).filter((r) => r.kind === kind);

    check('with no medicines, only the evening nudge rings, once a day for a fortnight', (await of('doses')).length === 0 && (await of('meals')).length === 14,
      `${(await of('doses')).length} dose, ${(await of('meals')).length} meal`);

    let announced = 0;
    const stop = onChange(() => announced++);
    const pill = await addMedicine({
      name: 'Ring pill', form: 'tablet', strength: '5 mg', ingredients: [],
      doses: [{ amount: 1, unit: 'tablet', time_of_day: 'morning', meal: 'after' }, { amount: 1, unit: 'tablet', time_of_day: 'night', meal: 'after' }],
      schedule: scheduleOf('daily', null, null), long_term: true, private: true,
    });
    check('saving a medicine is announced, so the rings are rebuilt', announced > 0, String(announced));
    let doses = await of('doses');
    // Tonight, then morning and night on each of the thirteen days after.
    check('a medicine rings at each of its times, from the next one on', doses.length === 27 && doses[0].title === 'Night medicines', `${doses.length}, first ${doses[0]?.title}`);
    check('named, because names were asked for', doses[0].body === 'Ring pill', doses[0].body);
    check('and never with its strength or its amount', !doses.some((r) => /5 mg|tablet/.test(r.body)));
    check('with names off the lock screen says only that something is due',
      (await buildRings({ ...s, names: false }, now)).filter((r) => r.kind === 'doses')[0].body === 'One to take. Open Mealo to tick it.');

    const before = announced;
    const today = await readMedsDay(medDay(now), now);
    const tonight = today.groups.find((g) => g.time === 'night')!.doses[0];
    await markDose(tonight, medDay(now), 'taken');
    check('ticking a dose is announced', announced > before, `${before} -> ${announced}`);
    doses = await of('doses');
    check('a dose ticked ahead of its time does not ring', doses.length === 26 && doses[0].title === 'Morning medicines', `${doses.length}, first ${doses[0]?.title}`);

    await stopMedication(pill);
    check('a stopped medicine does not ring at all', (await of('doses')).length === 0, String((await of('doses')).length));

    const planned = await saveMeal(await draftFromText('1 katori plan dal'), { mealType: 'dinner', planned: true });
    check('a meal only planned for today leaves the nudge in place', (await of('meals')).length === 14);
    const mealsAnnounced = announced;
    await saveMeal(await draftFromText('1 katori plan dal'), { mealType: 'breakfast' });
    check('logging a meal is announced', announced > mealsAnnounced);
    const meals = await of('meals');
    check('and takes today\'s nudge away, leaving the days ahead', meals.length === 13 && meals[0].at > dayAhead(1), String(meals.length));
    await deleteMeal(planned);

    const quiet = announced;
    await saveDishFromPortion({ name: 'Ring test dish', quantity: 1, measure: 'katori', netWeightG: 100, energy: 100, protein: 1, fat: 1, carbs: 1, fibre: 1 });
    check('a change to the food table is not announced: no ring depends on it', announced === quiet, `${quiet} -> ${announced}`);
    stop();

    // No service worker and no permission in this browser: nothing is sent
    // and nothing is written, and it says so by returning null.
    check('with reminders off, a rebuild does nothing', (await refreshReminders()) === null);
    await setActiveProfile(was);
  }

  // ---- the demo's made-up person never lands on a real record -------------
  // The demo is a separate build, but a demo build opened on a developer's
  // own address finds that developer's database. By now this one holds a
  // great deal; the seeder must add nothing to it, this time or the next.
  {
    const { seedDemo } = await import('../../src/demo/seed');
    const tally = async () => JSON.stringify(await Promise.all(
      ['custom_foods', 'meals', 'meal_items', 'medications', 'intake_events', 'symptoms', 'weights', 'burns', 'profiles'].map(async (t) => [t, (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0].n]),
    ));
    const before = await tally();
    const names = JSON.stringify(await query('SELECT name FROM profiles ORDER BY id'));
    check('the demo seeder writes nothing into a database that has data', (await seedDemo()) === false && (await tally()) === before, before);
    check('and renames nobody', JSON.stringify(await query('SELECT name FROM profiles ORDER BY id')) === names, names);
  }

  // ---- the HSA register leaves a full phone, and nothing else moves ------
  // His instruction, 15 Oct 2026: nothing may happen to the data on the
  // phones. By here the database holds two profiles, meals, portions,
  // medicines, doses, weights, symptoms and chat; every row of every table
  // a person logged into, and every imported list, must be the same after
  // the start-up clean-up as before it, value for value.
  step('retiring the bundled register');
  {
    const KEPT = ['profiles', 'meals', 'meal_items', 'custom_foods', 'food_portions', 'food_aliases', 'medications', 'med_doses', 'med_products',
      'intake_events', 'sick_episodes', 'weights', 'burns', 'symptoms', 'targets', 'messages', 'conversation_summaries', 'current_state', 'foods'];
    const snapshot = async () => JSON.stringify(await Promise.all([
      ...KEPT.map(async (t) => [t, await query(`SELECT * FROM ${t} ORDER BY rowid`)]),
      ['imported lists', await query("SELECT * FROM med_ref_sets WHERE NOT (builtin = 1 AND tag = 'HSA') ORDER BY rowid")],
      ['imported rows', await query("SELECT i.* FROM med_ref_items i JOIN med_ref_sets s ON s.id = i.set_id WHERE NOT (s.builtin = 1 AND s.tag = 'HSA') ORDER BY i.rowid")],
    ]));
    await sql("INSERT INTO med_ref_sets (id, name, tag, builtin, status, row_count, skipped, version, updated_at) VALUES ('hsa-full', 'Singapore HSA register', 'HSA', 1, 'ready', 2, 0, '2026-09-01', 1)");
    await sql("INSERT INTO med_ref_items (id, set_id, name, name_norm, ingredients, discontinued, updated_at) VALUES ('hsa-full.1', 'hsa-full', 'A TABLET', 'a tablet', '[]', 0, 1), ('hsa-full.2', 'hsa-full', 'B TABLET', 'b tablet', '[]', 0, 1)");
    const held = await snapshot();
    check('there is a full record to protect', JSON.parse(held).filter((t: [string, unknown[]]) => t[1].length > 0).length >= 12, held.slice(0, 200));
    check('the start-up clean-up removes the register', (await retireBundled()) === 1);
    check('and every other row on the phone is exactly as it was', (await snapshot()) === held);
  }

  // ---- backup and restore ------------------------------------------------
  // Last, because it replaces the whole database, and because by now the
  // database holds everything the tests above put in it: two profiles,
  // meals, portions, medicines, doses, weights, symptoms, chat.
  step('backup and restore');
  {
    const TABLES = ['profiles', 'meals', 'meal_items', 'custom_foods', 'food_portions', 'food_aliases', 'medications', 'med_doses', 'med_products',
      'intake_events', 'sick_episodes', 'weights', 'burns', 'symptoms', 'targets', 'messages', 'conversation_summaries', 'current_state'];
    /** Every row of every table that holds what a person logged, value for value. */
    const everything = async () =>
      JSON.stringify(await Promise.all(TABLES.map(async (t) => [t, await query(`SELECT * FROM ${t} ORDER BY rowid`)])));

    const held = await describeDatabase();
    const fp0 = await everything();
    check('there is real data to back up', held.counts.meals > 0 && held.counts.meal_items > 0 && held.counts.custom_foods > 0 && held.counts.profiles >= 2,
      JSON.stringify(held.counts));

    // The weekly copy inside the phone (15 Oct 2026): taken when there is
    // none, not again within the week, then into the other slot, then over
    // the older of the two. `now` stands in for days passing; the files'
    // own times say how old the copies are.
    const t0 = Date.now();
    const w1 = await keepWeeklyCopy(t0);
    check('the first weekly copy is taken', w1.taken === true);
    check('not again the next day', (await keepWeeklyCopy(t0 + 86_400_000)).taken === false);
    check('a week on, a second, in the other slot', (await keepWeeklyCopy(t0 + 8 * 86_400_000)).taken === true &&
      (await listCopies()).filter((c) => c.kind === 'weekly').length === 2);
    check('and after that, two are kept, never three', (await keepWeeklyCopy(t0 + 16 * 86_400_000)).taken === true &&
      (await listCopies()).filter((c) => c.kind === 'weekly').length === 2);
    const weeklyCopy = (await listCopies()).find((c) => c.kind === 'weekly')!;
    const copyInfo = await inspectBackup(await snapshotFile(weeklyCopy));
    check('a weekly copy opens as a whole, sound database', copyInfo.integrity === 'ok' && sameRows(held, copyInfo) === null,
      String(sameRows(held, copyInfo)));

    // When the last backup was: none, then the moment one was handed over.
    check('no backup noted yet', (await lastBackupAt()) === null);
    await noteBackup(t0);
    check('a backup is noted', (await lastBackupAt()) === t0);

    const { file, info } = await makeBackup();
    check('the backup was opened and passed its check', info.integrity === 'ok' && info.version === LATEST_VERSION, JSON.stringify([info.integrity, info.version]));
    check('it holds exactly what the phone holds', sameRows(held, info) === null && sameRows(info, held) === null, String(sameRows(held, info)));
    check('the file is the size it says, and named for the day', file.size === info.bytes && file.size > 8192 && /^mealo-backup-\d{4}-\d{2}-\d{2}\.sqlite3$/.test(file.name),
      `${file.name} ${file.size}`);
    check('making a backup changes nothing', (await everything()) === fp0);

    const seen = await inspectBackup(file);
    check('looking inside a backup reads the same counts', sameRows(info, seen) === null);
    check('and changes nothing on the phone', (await everything()) === fp0);

    // What the day after a reinstall looks like, and worse: rows gone, rows
    // changed, a row that was never in the backup.
    await run('DELETE FROM meal_items');
    await run('DELETE FROM weights');
    await run("UPDATE custom_foods SET name = 'WRECKED'");
    await run('DELETE FROM intake_events');
    await run('DELETE FROM symptoms');
    const wrecked = await describeDatabase();
    check('the phone no longer holds its data', wrecked.counts.meal_items === 0 && wrecked.counts.weights === 0 && (await everything()) !== fp0);

    const done = await restoreBackup();
    check('the restore reports the file\'s rows in place', sameRows(info, done.restored) === null, String(sameRows(info, done.restored)));
    check('every row is back, value for value', (await everything()) === fp0);
    check('it reports what it replaced', done.before.counts.meal_items === 0 && done.before.counts.weights === 0, JSON.stringify(done.before.counts));
    check('the database is sound and at this version', (await describeDatabase()).integrity === 'ok' && (await describeDatabase()).version === LATEST_VERSION);
    const fk = await query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    check('foreign keys are still enforced', Number(fk[0]?.foreign_keys) === 1, JSON.stringify(fk));

    // The app must go on working on the restored database, through the
    // same scoped handles as before.
    const after = await logSymptom('restored and still writing');
    check('a write after the restore lands', (await openSymptoms()).some((x) => x.id === after));
    await run('DELETE FROM symptoms WHERE id = ?', [after]);
    check('and leaves the data as restored once undone', (await everything()) === fp0);

    // The copy kept before the restore is a real database holding what was replaced.
    const root = await navigator.storage.getDirectory();
    const kept = await (await root.getFileHandle('mealo.before-restore.sqlite3')).getFile();
    const keptInfo = await inspectBackup(kept);
    check('a copy of what was replaced is kept, and opens', keptInfo.integrity === 'ok' && keptInfo.counts.meal_items === 0 && keptInfo.counts.meals === held.counts.meals,
      JSON.stringify(keptInfo.counts));

    // ---- files that must be turned away, each leaving the phone untouched
    const refused = async (what: string, blob: Blob, expect: RegExp) => {
      let said = '';
      try {
        await inspectBackup(blob);
        await restoreBackup();
      } catch (e) {
        said = e instanceof Error ? e.message : String(e);
      }
      check(`${what} is refused`, expect.test(said), said || 'it was restored');
      check(`${what} leaves the phone untouched`, (await everything()) === fp0);
    };
    const bytes = new Uint8Array(await file.arrayBuffer());

    await refused('a file that is not a database', new Blob([new Uint8Array(20_000).fill(7)]), /not a database at all/);
    await refused('a text file', new Blob(['Meal,Calories\nDal,128\n'.repeat(400)]), /not a database at all/);
    await refused('an empty file', new Blob([]), /not a database|could not be opened/);

    // A backup from a Mealo newer than this one: the version in the file's
    // header (bytes 60 to 63) says so.
    const newer = bytes.slice();
    new DataView(newer.buffer).setUint32(60, LATEST_VERSION + 1);
    await refused('a backup from a newer Mealo', new Blob([newer]), /newer version of Mealo/);

    // Cut short in transit, or by a full disk.
    await refused('a backup cut off half way', new Blob([bytes.slice(0, Math.floor(bytes.length / 2))]), /damaged|could not be opened|not a database|did not pass/);

    // The right size and the right header, with a stretch of its pages blanked.
    const holed = bytes.slice();
    holed.fill(0, 4096, Math.min(holed.length, 4096 * 6));
    await refused('a backup with pages blanked', new Blob([holed]), /damaged|could not be opened|did not pass|not one made by Mealo|empty database/);

    // And after all that, the good file still restores.
    await inspectBackup(file);
    await restoreBackup();
    check('the good backup still restores after every refusal', (await everything()) === fp0);
    let again = '';
    try {
      await restoreBackup();
    } catch (e) {
      again = e instanceof Error ? e.message : String(e);
    }
    check('with no file chosen there is nothing to restore', again === 'Choose a backup file first.', again);
    check('and the phone is as it was', (await everything()) === fp0);
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
