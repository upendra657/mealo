/**
 * Portion arithmetic and CSV import, tested without a browser.
 *
 *   npm run test:portions
 *
 * The point of this file is that "1.5 katori" and "1 bowl" are claims about
 * the user's actual food, and a silently wrong multiplier here shows up as a
 * wrong calorie count months later with nothing to trace it back to.
 *
 * It bundles the real modules — not copies of them — so it fails when the
 * shipped code changes. Nothing here touches the database: every function
 * under test is pure, which is the reason the resolver was written that way.
 */

import {
  densityFrom,
  resolvePortion,
  type Anchor,
} from '../src/domain/portions';
import {
  allMeasureIds,
  canonicalMeasure,
  describeMeasure,
  everyMeasureId,
  toMeasure,
} from '../src/domain/measures';
import { normalise, slugFor } from '../src/domain/foods';
import { daysBetween, spanLabel, whenLabel } from '../src/domain/weight';
import {
  deidentify,
  describeRedactions,
  type Identity,
} from '../src/safety/deidentify';
import {
  average,
  byDay as burnByDay,
  ceiling,
  slotsFor,
  streak,
} from '../src/domain/burn';
import {
  banner,
  bandOf,
  focusDay,
  shortfalls,
  situationOf,
  weightTrend,
  type BannerCtx,
} from '../src/domain/banner';
import type { Macros } from '../src/domain/day';
import {
  collapse,
  isAddressable,
  nextCursor,
  resolve,
  since,
  wireKey,
  type WireRow,
} from '../src/domain/sync';
import {
  parseCsv,
  mapHeaders,
  readRows,
  planDishes,
  per100Of,
  weightOf,
} from '../src/domain/import';
import { parseMealText } from '../src/domain/foods';
import { checkRowsFor, checkSheetCsv } from '../src/domain/checksheet';
import { createHash } from 'node:crypto';
import { LATEST_VERSION, MIGRATIONS, type Migration } from '../src/db/migrations';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(actual)}`);
  }
}

function near(name: string, actual: number, expected: number, tol = 0.6) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) {
    passed++;
    console.log(`  ok   ${name} (${actual})`);
  } else {
    failed++;
    console.log(`  FAIL ${name}: expected ~${expected}, got ${actual}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- measures

section('Measure vocabulary');
check('katori canonicalises', canonicalMeasure('Katori'), 'katori');
check('plural alias', canonicalMeasure('katoris'), 'katori');
check('chapati is a roti', canonicalMeasure('chapati'), 'roti');
check('tablespoon abbreviates', canonicalMeasure('Tbsp.'), 'tbsp');
check('pcs is piece', canonicalMeasure('pcs'), 'piece');
check('unknown stays unknown', canonicalMeasure('fistful-ish'), null);
check('katori is volumetric', toMeasure('katori')?.kind, 'volume');
check('slice is countable', toMeasure('slice')?.kind, 'count');
check('grams are absolute', toMeasure('g')?.kind, 'weight');

// ------------------------------------------------------------ one anchor

section('One anchor: dal, 1 katori = 150g');
const dal: Anchor[] = [
  { measure: 'katori', quantity: 1, net_weight_g: 150, is_default: 1 },
];

{
  const r = resolvePortion(1, 'katori', dal);
  check('exact anchor basis', r.basis, 'anchor');
  near('1 katori', r.grams, 150);
  check('reported as measured', r.measured, true);
}
near('1.5 katori scales', resolvePortion(1.5, 'katori', dal).grams, 225);
near('2 katori scales', resolvePortion(2, 'katori', dal).grams, 300);
near('0.5 katori scales', resolvePortion(0.5, 'katori', dal).grams, 75);

{
  // The whole point: a measure never recorded for this dish, derived from the
  // density the katori implies. 150g in 150ml is 1.0 g/ml, so a 350ml bowl.
  //
  // This exact case is the one the real data confirmed: his sheet has dal
  // tadka at 150g per katori AND 350g per bowl, measured independently. The
  // derivation lands on 350 to the gram, which is what fixed `bowl` from the
  // 250ml it was guessed at to the 350ml it actually is.
  const r = resolvePortion(1, 'bowl', dal);
  check('bowl comes from density', r.basis, 'density');
  near('1 bowl of dal', r.grams, 350);
}
near('1 cup of dal (240ml)', resolvePortion(1, 'cup', dal).grams, 240);
near('2 tbsp of dal', resolvePortion(2, 'tbsp', dal).grams, 30);

{
  const r = resolvePortion(200, 'g', dal);
  check('a weight is taken at face value', r.basis, 'weight');
  near('200g', r.grams, 200);
}

{
  // "2 dal" with no measure at all falls to the dish's default portion,
  // not to 100g. This is the bug the old defaultGrams() had.
  const r = resolvePortion(2, null, dal);
  check('no measure uses the default portion', r.basis, 'default');
  near('2 servings of dal', r.grams, 300);
}

// --------------------------------------------------------- count anchors

section('Count anchor: roti, 1 piece = 40g');
const roti: Anchor[] = [
  { measure: 'piece', quantity: 1, net_weight_g: 40, is_default: 1 },
];
near('"2 roti" → 80g not 200g', resolvePortion(2, null, roti).grams, 80);
near('3 pieces', resolvePortion(3, 'piece', roti).grams, 120);
{
  const r = resolvePortion(1, 'slice', roti);
  check('another count measure borrows it', r.basis, 'sibling');
  near('1 slice of roti', r.grams, 40);
}
{
  // A count measure says nothing about volume, so a bowl of roti must NOT
  // claim to be derived from the piece weight.
  const r = resolvePortion(1, 'bowl', roti);
  check('volume cannot come from a count', r.basis, 'household');
  check('and it says so', r.measured, false);
}

// ------------------------------------------------------- density carries

section('Density: oil, 1 tbsp = 14g (not water)');
const oil: Anchor[] = [{ measure: 'tbsp', quantity: 1, net_weight_g: 14 }];
{
  const d = densityFrom(oil);
  near('density is 0.93 g/ml', d ? d.density : 0, 0.933, 0.01);
}
near('1 cup of oil is not 240g', resolvePortion(1, 'cup', oil).grams, 224, 1);
near('100ml of oil', resolvePortion(100, 'ml', oil).grams, 93.3, 1);
near('1 katori of oil', resolvePortion(1, 'katori', oil).grams, 140, 1);

section('Density prefers the larger vessel');
const mixed: Anchor[] = [
  { measure: 'tsp', quantity: 1, net_weight_g: 6 },
  { measure: 'bowl', quantity: 1, net_weight_g: 315 },
];
{
  const d = densityFrom(mixed);
  near('takes the bowl (0.9), not the tsp (1.2)', d ? d.density : 0, 0.9, 0.01);
}

section('Density prefers the default when one is marked');
const flagged: Anchor[] = [
  { measure: 'bowl', quantity: 1, net_weight_g: 225 },
  { measure: 'katori', quantity: 1, net_weight_g: 165, is_default: 1 },
];
{
  const d = densityFrom(flagged);
  near('uses the katori', d ? d.density : 0, 1.1, 0.01);
}

// -------------------------------------------------------- multi-quantity

section('Anchors recorded at a quantity other than 1');
const idli: Anchor[] = [{ measure: 'piece', quantity: 4, net_weight_g: 180 }];
near('4 pieces = 180g → 1 piece', resolvePortion(1, 'piece', idli).grams, 45);
near('→ 6 pieces', resolvePortion(6, 'piece', idli).grams, 270);

// ------------------------------------------------------------- no anchor

section('A dish with nothing recorded');
{
  const r = resolvePortion(1, 'katori', []);
  check('falls back to a household size', r.basis, 'household');
  check('flagged as not measured', r.measured, false);
  near('generic katori', r.grams, 150);
}
{
  const r = resolvePortion(2, null, []);
  check('nothing at all to go on', r.basis, 'unknown');
  check('not measured', r.measured, false);
  near('assumes 100g each', r.grams, 200);
}
{
  const r = resolvePortion(null, null, []);
  near('null quantity means one', r.grams, 100);
  check('quantity normalised', r.quantity, 1);
}
near('zero quantity means one', resolvePortion(0, 'katori', dal).grams, 150);

// ------------------------------------------------------------------ CSV

section('CSV reading');
check('quoted comma survives', parseCsv('a,"b,c",d')[0], ['a', 'b,c', 'd']);
check('doubled quote', parseCsv('"say ""hi""",2')[0], ['say "hi"', '2']);
check('CRLF rows', parseCsv('a,b\r\nc,d').length, 2);
check('blank lines dropped', parseCsv('a,b\n\n\nc,d').length, 2);

{
  const { columns } = mapHeaders([
    'Meal/Ingredient',
    'Quantity (Numeric eg: 1.0)',
    'Measure (String)',
    'Net weight (g)',
    'Calories (Kcal)',
    'Protein (g)',
    'Fats (g)',
    'Carbs (g)',
    'Fiber (g)',
  ]);
  check('his exact headers map', columns, {
    name: 0,
    quantity: 1,
    measure: 2,
    netWeightG: 3,
    energy: 4,
    protein: 5,
    fat: 6,
    carbs: 7,
    fibre: 8,
  });
}

section('CSV normalisation to per-100g');
{
  const csv = [
    'Meal/Ingredient,Quantity,Measure,Net weight (g),Calories (Kcal),Protein (g),Fats (g),Carbs (g),Fiber (g)',
    'Dal tadka,1,katori,150,176,8.4,6.2,21.5,5.1',
    'Dal tadka,1,bowl,250,293,14,10.3,35.8,8.5',
    '"Poha, dry",1,cup,120,168,3.1,0.7,36.4,1.4',
    'Roti,2,piece,80,208,6.2,0.8,41.2,6.4',
  ].join('\n');

  const { rows, issues } = readRows(csv);
  check('four rows read', rows.length, 4);
  check('no issues', issues.length, 0);
  check('name with a comma is intact', rows[2].name, 'Poha, dry');

  const { dishes } = planDishes(rows);
  check('three dishes', dishes.length, 3);

  const dalPlan = dishes.find((d) => d.name.startsWith('Dal'));
  check('dal has two anchors', dalPlan?.portions.length, 2);
  check('dal has no complaints', dalPlan?.warnings.length, 0);
  near('dal per-100g energy', dalPlan?.per100.energy_kcal ?? 0, 117, 1);
  near('dal per-100g protein', dalPlan?.per100.protein_g ?? 0, 5.6, 0.2);

  // The round trip that matters: sheet → per-100g → back to a katori.
  const anchors: Anchor[] = (dalPlan?.portions ?? []).map((p) => ({
    measure: p.measure,
    quantity: p.quantity,
    net_weight_g: p.netWeightG,
  }));
  const katori = resolvePortion(1, 'katori', anchors);
  near('1 katori back to 150g', katori.grams, 150);
  near(
    '…and back to 176 kcal',
    ((dalPlan?.per100.energy_kcal ?? 0) * katori.grams) / 100,
    176,
    1.5,
  );
  const oneAndHalf = resolvePortion(1.5, 'katori', anchors);
  near('1.5 katori → 225g', oneAndHalf.grams, 225);
  near(
    '…→ 264 kcal, which was never in the sheet',
    ((dalPlan?.per100.energy_kcal ?? 0) * oneAndHalf.grams) / 100,
    264,
    2,
  );

  const rotiPlan = dishes.find((d) => d.name === 'Roti');
  near('roti per-100g from a 2-piece row', rotiPlan?.per100.energy_kcal ?? 0, 260, 1);
  check('roti anchor keeps quantity 2', rotiPlan?.portions[0].quantity, 2);
  near(
    'so one roti is 40g',
    resolvePortion(1, 'piece', [
      {
        measure: 'piece',
        quantity: rotiPlan?.portions[0].quantity ?? 1,
        net_weight_g: rotiPlan?.portions[0].netWeightG ?? 0,
      },
    ]).grams,
    40,
  );
}

section('CSV problems are reported, not swallowed');
{
  const csv = [
    'Meal/Ingredient,Quantity,Measure,Net weight (g),Calories (Kcal),Protein (g),Fats (g),Carbs (g),Fiber (g)',
    'Dal,1,katori,150,176,8.4,6.2,21.5,5.1',
    'Dal,1,bowl,250,420,14,10.3,35.8,8.5',
    ',1,katori,150,100,1,1,1,1',
    'Mystery,1,dollop,,90,1,1,1,1',
  ].join('\n');
  const { rows, issues } = readRows(csv);
  check('nameless row rejected', issues.some((i) => i.text.includes('No dish name')), true);
  check('unknown measure flagged', issues.some((i) => i.text.includes('dollop')), true);
  const { dishes, issues: planIssues } = planDishes(rows);
  const dal = dishes.find((d) => d.name === 'Dal');
  check('inconsistent macros warned', (dal?.warnings.length ?? 0) > 0, true);
  check(
    'weightless dish rejected rather than guessed',
    planIssues.some((i) => i.text.includes('no net weight')),
    true,
  );
}

section('Weight inference');
check('explicit net weight wins', weightOf({
  line: 2, name: 'x', quantity: 1, measure: 'katori',
  netWeightG: 150, energy: 1, protein: null, fat: null, carbs: null, fibre: null,
}), 150);
check('grams row carries its own weight', weightOf({
  line: 2, name: 'x', quantity: 30, measure: 'g',
  netWeightG: null, energy: 1, protein: null, fat: null, carbs: null, fibre: null,
}), 30);
check('no weight, no guess', weightOf({
  line: 2, name: 'x', quantity: 1, measure: 'katori',
  netWeightG: null, energy: 1, protein: null, fat: null, carbs: null, fibre: null,
}), null);

check('per100 keeps nulls null', per100Of({
  line: 2, name: 'x', quantity: 1, measure: 'g',
  netWeightG: 50, energy: 100, protein: null, fat: null, carbs: null, fibre: null,
}, 50).protein_g, null);

section('Vessel volumes, as measured rather than assumed');
{
  // Every one of these came out of the real sheet: two independently weighed
  // rows of the same dish pin the ratio between two vessels.
  const wet: Anchor[] = [{ measure: 'katori', quantity: 1, net_weight_g: 150 }];
  near('katori 150ml → bowl 350ml', resolvePortion(1, 'bowl', wet).grams, 350);
  near('katori 150ml → cup 240ml', resolvePortion(1, 'cup', wet).grams, 240);
  near('katori 150ml → teacup 180ml', resolvePortion(1, 'teacup', wet).grams, 180);
  near('a small bowl is a katori', resolvePortion(1, 'smallbowl', wet).grams, 150);
  check('…but stays its own option', canonicalMeasure('small bowl'), 'smallbowl');

  // White rice: cup 206g measured, bowl 289g measured. 206/240 = 0.858 g/ml,
  // so the bowl should come out near 300. It lands 4% high, which is the
  // honest accuracy of packing a grain into a different vessel.
  const rice: Anchor[] = [{ measure: 'cup', quantity: 1, net_weight_g: 206 }];
  near('rice cup → bowl, within 4%', resolvePortion(1, 'bowl', rice).grams, 300, 2);

  // Ghee, teaspoon to tablespoon: the sheet has 3.4g and 10.2g.
  const ghee: Anchor[] = [{ measure: 'tsp', quantity: 1, net_weight_g: 3.4 }];
  near('tsp → tbsp is exactly 3x', resolvePortion(1, 'tbsp', ghee).grams, 10.2, 0.1);
}

section('A restaurant serve is nobody else\'s serve');
{
  const jalfrezi: Anchor[] = [{ measure: 'katori', quantity: 1, net_weight_g: 100 }];
  const r = resolvePortion(1, 'serve', jalfrezi);
  check('a serve is never derived', r.basis, 'restaurant');
  check('and never claims to be measured', r.measured, false);
  check('it says what to do about it', r.note.includes('record what yours weighed'), true);

  // Recorded, it behaves like any other anchor.
  const fries: Anchor[] = [{ measure: 'serve', quantity: 1, net_weight_g: 191 }];
  const s2 = resolvePortion(1, 'serve', fries);
  check('a recorded serve is exact', s2.basis, 'anchor');
  near('1 serve of fries', s2.grams, 191);
  near('2 serves', resolvePortion(2, 'serve', fries).grams, 382);

  // And it lends nothing to anything else.
  const p = resolvePortion(1, 'piece', fries);
  check('a serve never becomes a piece', p.basis, 'household');
  const b = resolvePortion(1, 'bowl', fries);
  check('nor a bowl', b.basis, 'household');
  check('both flagged as guesses', !p.measured && !b.measured, true);
}

// ----------------------------------------------------------- check sheet

section('Check sheet — what the app claims, for correction');
{
  // One anchor only, the realistic starting point: you recorded a katori and
  // nothing else. Everything the sheet offers beyond that is derived, and the
  // sheet has to say which is which.
  const dalFood = {
    id: 'f1',
    name: 'Dal tadka',
    source_db: 'custom',
    per_unit: '100g',
    energy_kcal: 117.3,
    protein_g: 5.6,
    fat_g: 4.1,
    carbs_g: 14.3,
    fibre_g: 3.4,
    is_custom: 1,
  };
  const rows = checkRowsFor(dalFood, dal);

  const own = rows.filter((r) => r.measure === 'katori');
  check('the recorded measure gets every quantity', own.length, 4);
  check('and is marked as yours', own.every((r) => r.confidence === 'yours'), true);
  near('1 katori round-trips', own.find((r) => r.quantity === 1)?.grams ?? 0, 150);
  near(
    'and carries its macros',
    own.find((r) => r.quantity === 1)?.energy ?? 0,
    176,
    1.5,
  );
  near('1.5 katori is offered too', own.find((r) => r.quantity === 1.5)?.energy ?? 0, 264, 2);

  const bowl = rows.find((r) => r.measure === 'bowl' && r.quantity === 1);
  check('an unrecorded bowl is offered', !!bowl, true);
  check('marked derived, not yours', bowl?.confidence, 'derived');
  near('at the density the katori implies', bowl?.grams ?? 0, 350);

  const grams = rows.filter((r) => r.measure === 'g');
  check('a 100g control row exists', grams.length, 1);
  near('and is exact', grams[0].grams, 100);
  near('with the per-100g macros', grams[0].energy ?? 0, 117.3, 0.2);

  check(
    'nothing volumetric is offered for a dish counted in pieces',
    checkRowsFor(dalFood, roti).some((r) => r.measure === 'bowl'),
    false,
  );
  check(
    'but other piece measures are',
    checkRowsFor(dalFood, roti).some((r) => r.measure === 'piece'),
    true,
  );

  // A dish with nothing recorded must not present guesses as facts.
  const bare = checkRowsFor(dalFood, []);
  check(
    'an unmeasured dish is all guesswork',
    bare.filter((r) => r.measure !== 'g').every((r) => r.confidence === 'assumed'),
    true,
  );
}

section('Check sheet round-trips through the importer');
{
  const dalFood = {
    id: 'f1', name: 'Dal tadka', source_db: 'custom', per_unit: '100g',
    energy_kcal: 117.3, protein_g: 5.6, fat_g: 4.1, carbs_g: 14.3, fibre_g: 3.4,
    is_custom: 1,
  };
  const csv = checkSheetCsv(checkRowsFor(dalFood, dal));
  const { rows: back, issues, unmatched } = readRows(csv);
  check('the sheet reads back cleanly', issues.length, 0);
  check('its two extra columns are ignored, not misread', unmatched, ['From', 'How']);
  check('every row survives', back.length > 8, true);

  // Correct one row the way he would in a spreadsheet: the bowl is really 210g.
  const corrected = csv
    .split('\n')
    .map((line) =>
      line.startsWith('Dal tadka,1,bowl,')
        ? 'Dal tadka,1,bowl,210,246,11.8,8.6,30,7.1'
        : line,
    )
    .join('\n');

  const { dishes } = planDishes(readRows(corrected).rows);
  const plan = dishes[0];
  const bowlAnchor = plan.portions.find((p) => p.measure === 'bowl');
  near('the correction becomes an anchor', bowlAnchor?.netWeightG ?? 0, 210);

  const anchors: Anchor[] = plan.portions.map((p) => ({
    measure: p.measure,
    quantity: p.quantity,
    net_weight_g: p.netWeightG,
  }));
  near('1 bowl now', resolvePortion(1, 'bowl', anchors).grams, 210);
  near('2 bowls follow', resolvePortion(2, 'bowl', anchors).grams, 420);
  near('and the katori is untouched', resolvePortion(1, 'katori', anchors).grams, 150);
}

// --------------------------------------------------- text parsing
section('Parsing what you type');
{
  const one = (text: string) => parseMealText(text)[0];

  check('quantity and a bowl', one('1 bowl sambar'), { label: 'sambar', quantity: 1, unit: 'bowl' });
  check('a teacup is a measure, not part of the dish',
    one('1 teacup filter coffee'), { label: 'filter coffee', quantity: 1, unit: 'teacup' });
  check('so is "regular"',
    one('3 regular idli'), { label: 'idli', quantity: 3, unit: 'regular' });
  check('two words beat one',
    one('1 small bowl kali dal'), { label: 'kali dal', quantity: 1, unit: 'smallbowl' });
  check('measures canonicalise on the way in',
    one('2 Katoris rajma'), { label: 'rajma', quantity: 2, unit: 'katori' });
  check('a serve is a measure too',
    one('1 serve penne'), { label: 'penne', quantity: 1, unit: 'serve' });

  // The dish that is its own unit has to keep its name and lose the measure,
  // or "2 roti" logs two pieces of nothing.
  check('"2 roti" keeps the word', one('2 roti'), { label: 'roti', quantity: 2, unit: null });
  check('"3 eggs" likewise', one('3 eggs'), { label: 'eggs', quantity: 3, unit: null });

  check('no number at all', one('dal tadka'), { label: 'dal tadka', quantity: null, unit: null });
  check('grams pass through', one('250g paneer'), { label: 'paneer', quantity: 250, unit: 'g' });

  check('a whole line splits', parseMealText('2 roti, 1 katori dal, 1 cup curd').length, 3);
  check('and on "and"', parseMealText('1 bowl rice and 1 katori dal').length, 2);
}

// --------------------------------------------------- the library merge key

section('Slugs: one dish, two devices');
{
  // Both phones must land on the same string without talking to each other,
  // because that string is the only thing sync has to merge on.
  check('same name, same slug', slugFor('Dal Tadka'), slugFor('dal tadka'));
  check('spacing is not identity', slugFor('  Dal   Tadka '), 'dal tadka');
  check('punctuation is not identity', slugFor('Dal-Tadka!'), 'dal tadka');
  check('accents fold', slugFor('Sautéed Paneer'), slugFor('Sauteed Paneer'));
  check('plurals fold', slugFor('Boiled Eggs'), slugFor('Boiled Egg'));

  // It is the matcher's normaliser and must stay that way. A second, subtly
  // different copy is what broke the unit list once already.
  check('slugFor is normalise', slugFor('Aloo Gobi'), normalise('Aloo Gobi'));

  // The backfill marks a collision by suffixing with '~'. That only works as
  // a signal if a real slug can never contain one.
  for (const n of ['Dal ~ Tadka', 'Rice~', '~~~', 'Egg ~2']) {
    check(`no tilde survives: ${n}`, slugFor(n).includes('~'), false);
  }

  // A name with nothing alphanumeric in it has no identity to derive. The
  // backfill leaves those alone rather than giving them all the same slug.
  check('empty stays empty', slugFor('!!!'), '');
  check('and so does blank', slugFor('   '), '');
}

// ------------------------------------------------------- the home banner

section('Banner: which day it is talking about');
{
  const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m).getTime();
  check('4am is the morning', bandOf(at(4)), 'morning');
  check('3:59am is still last night', bandOf(at(3, 59)), 'small-hours');
  check('11pm is night', bandOf(at(23)), 'night');

  // The handover he asked for: 23:45 and 00:05 say the same thing about the
  // same day, because a day ends when you go to bed.
  check('23:45 means today', focusDay(at(23, 45), 3).lookingBack, false);
  check('00:05 still means yesterday', focusDay(at(0, 5), 0).lookingBack, true);
  check('03:50 still means yesterday', focusDay(at(3, 50), 0).lookingBack, true);
  check('04:10 has moved on', focusDay(at(4, 10), 0).lookingBack, false);
  // Unless you ate. A 1am plate starts a new day whatever the clock says.
  check('but eating starts the new day', focusDay(at(1, 30), 1).lookingBack, false);
  check('and the day it names is the one before', 
    focusDay(at(0, 5), 0).dayStart, new Date(2026, 8, 24).getTime());
}

section('Banner: what it decides to say');
{
  const T = { energy_kcal: 1700, protein_g: 85, fat_g: 57, carbs_g: 213, fibre_g: 30 };
  const at = (h: number) => new Date(2026, 8, 25, h).getTime();
  const ctx = (o: Partial<BannerCtx>): BannerCtx =>
    ({ now: at(16), totals: [0, 0, 0, 0, 0], itemCount: 0, targets: T, lookingBack: false, ...o }) as BannerCtx;

  check('no targets, nothing to measure against',
    situationOf(ctx({ targets: { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null }, itemCount: 3 })),
    'no-targets');
  check('nothing logged', situationOf(ctx({ itemCount: 0 })), 'empty');
  check('short mid-day', situationOf(ctx({ itemCount: 4, totals: [1100, 42, 30, 140, 22] })), 'short');
  check('short once the day is done',
    situationOf(ctx({ now: at(23), itemCount: 4, totals: [1100, 42, 30, 140, 22] })), 'short-past');

  // Hitting protein and fibre while 750 over is not "everything landed".
  check('over does not get congratulated',
    situationOf(ctx({ itemCount: 8, totals: [2450, 95, 90, 280, 33] })), 'high');
  check('everything met', situationOf(ctx({ itemCount: 7, totals: [1650, 92, 50, 200, 33] })), 'all-hit');

  // The biggest relative gap wins, not the biggest absolute one.
  const gaps = shortfalls(ctx({ itemCount: 4, totals: [1200, 68, 40, 150, 22] }));
  check('fibre is further behind than protein', gaps[0].name, 'fibre');
  check('and it reports what is left', gaps[0].left, 8);

  // Additive only: it never asks you to eat less of anything.
  for (const h of [7, 12, 16, 19, 23, 1]) {
    const line = banner(ctx({ now: new Date(2026, 8, 25, h).getTime(), itemCount: 8,
      totals: [2450, 95, 90, 280, 33], lookingBack: h < 4 })).text.toLowerCase();
    const scolds = ['too much', 'cut ', 'stop ', 'should not', 'overate', 'slow down'];
    check(`${h}:00 does not scold`, scolds.some((w) => line.includes(w)), false, line);
  }
}

section('Banner: steady on re-render, awake over time');
{
  const T = { energy_kcal: 1700, protein_g: 85, fat_g: 57, carbs_g: 213, fibre_g: 30 };
  const base = { totals: [1100, 42, 30, 140, 22] as Macros, itemCount: 4, targets: T, lookingBack: false };
  const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m).getTime();

  // Re-rendering a minute later must not reword the sentence.
  check('same minute, same line', banner({ ...base, now: at(16) }).text, banner({ ...base, now: at(16) }).text);
  check('a minute later, same line', banner({ ...base, now: at(16) }).text, banner({ ...base, now: at(16, 1) }).text);
  // But the day moving on changes it.
  check('morning and evening differ', banner({ ...base, now: at(7) }).text !== banner({ ...base, now: at(19) }).text, true);
  // And so does eating something.
  check('logging changes it',
    banner({ ...base, now: at(16) }).text !== banner({ ...base, now: at(16), totals: [1400, 62, 35, 160, 26] }).text, true);

  // Every situation must produce a line for every part of the day.
  const hours = [1, 7, 12, 16, 19, 23];
  const cases: Macros[] = [[0,0,0,0,0], [1100,42,30,140,22], [2450,95,90,280,33], [1650,92,50,200,33], [1400,86,45,180,31]];
  let blank = 0;
  for (const h of hours) for (const totals of cases) {
    const p = banner({ now: at(h), totals, itemCount: totals[0] === 0 ? 0 : 5, targets: T, lookingBack: h < 4 });
    if (!p.text || p.text.includes('undefined') || p.text.includes('NaN')) blank++;
  }
  check('no situation is speechless', blank, 0);
}

section('Banner: weight trend');
{
  const day = 86_400_000; const t0 = new Date(2026, 8, 25).getTime();
  check('one reading is not a trend', weightTrend([{ kg: 71, measured_at: t0 }]), null);
  check('two readings a day apart is not a trend',
    weightTrend([{ kg: 71, measured_at: t0 }, { kg: 71.9, measured_at: t0 - day }]), null);
  check('100g of noise is not a trend',
    weightTrend([{ kg: 71.9, measured_at: t0 }, { kg: 72.0, measured_at: t0 - 14 * day }]), null);
  const down = weightTrend([{ kg: 71.2, measured_at: t0 }, { kg: 72.0, measured_at: t0 - 14 * day }]);
  check('down over a fortnight', down, { delta: -0.8, days: 14 });
  const up = weightTrend([{ kg: 72.6, measured_at: t0 }, { kg: 72.0, measured_at: t0 - 21 * day }]);
  check('and up', up, { delta: 0.6, days: 21 });
}

// ------------------------------------------------------------ sync merge

section('Sync: the merge key is the only identity two devices share');
{
  check('a dish keys on its slug', wireKey('custom_foods', { slug: 'dal tadka' }), 'dal tadka');
  check('a portion keys on dish + measure',
    wireKey('food_portions', { food_slug: 'dal tadka', measure: 'katori' }), 'dal tadka|katori');
  check('an alias keys on the words', wireKey('food_aliases', { alias: 'dal' }), 'dal');

  // Nothing that crosses the wire may carry a local row id: hers means
  // nothing on his device, and a portion pointing at a missing dish fails
  // silently rather than loudly.
  const portion: WireRow = { t: 'food_portions', k: 'dal tadka|katori', at: 5, del: null,
    f: { food_slug: 'dal tadka', measure: 'katori', quantity: 1, net_weight_g: 150, source: 'user' } };
  check('no id on the wire', 'id' in portion.f || 'food_id' in portion.f, false);
  check('addressable', isAddressable(portion), true);
  check('a portion with no dish is not', isAddressable(
    { ...portion, f: { ...portion.f, food_slug: '' }, k: '|katori' }), false);
}

section('Sync: who wins');
{
  const older = { updated_at: 100, deleted_at: null, id: 'a' };
  const newer = { updated_at: 200, deleted_at: null, id: 'b' };
  check('newer wins', resolve('custom_foods', older, newer), 'incoming');
  check('and does not lose going the other way', resolve('custom_foods', newer, older), 'local');

  // A delete is an edit like any other.
  check('a newer delete wins',
    resolve('custom_foods', { updated_at: 100, deleted_at: null },
                            { updated_at: 200, deleted_at: 200 }), 'incoming');
  check('an older delete does not',
    resolve('custom_foods', { updated_at: 300, deleted_at: null },
                            { updated_at: 200, deleted_at: 200 }), 'local');

  // The rule that is not last-write-wins: a number somebody weighed is not
  // overwritten by the app's own arithmetic, however late it arrives.
  const userOld = { updated_at: 100, deleted_at: null, source: 'user', id: 'a' };
  const derivedNew = { updated_at: 900, deleted_at: null, source: 'derived', id: 'b' };
  check('measured beats derived even when older',
    resolve('food_portions', userOld, derivedNew), 'local');
  check('and from the other side too',
    resolve('food_portions', derivedNew, userOld), 'incoming');
  check('two measured rows fall back to newest',
    resolve('food_portions', { ...userOld }, { ...userOld, updated_at: 900, id: 'b' }), 'incoming');

  // Convergence: swapping the sides must not swap the winner.
  let disagreements = 0;
  const cases: [number, string, string][] = [
    [100, 'user', 'a'], [100, 'derived', 'b'], [200, 'user', 'c'], [200, 'derived', 'd'],
  ];
  for (const [aAt, aSrc, aId] of cases) for (const [bAt, bSrc, bId] of cases) {
    if (aId === bId) continue;
    const A = { updated_at: aAt, deleted_at: null, source: aSrc, id: aId };
    const B = { updated_at: bAt, deleted_at: null, source: bSrc, id: bId };
    const fromA = resolve('food_portions', A, B) === 'incoming' ? bId : aId;
    const fromB = resolve('food_portions', B, A) === 'incoming' ? aId : bId;
    if (fromA !== fromB) disagreements++;
  }
  check('both devices always pick the same row', disagreements, 0);
}

section('Sync: batching');
{
  const row = (k: string, at: number): WireRow =>
    ({ t: 'custom_foods', k, at, del: null, f: { slug: k, name: k } });

  const collapsed = collapse([row('dal', 1), row('dal', 9), row('dal', 4), row('roti', 2)]);
  check('one row per key', collapsed.size, 2);
  check('and it is the newest', collapsed.get('custom_foods:dal')!.at, 9);

  check('unaddressable rows are dropped',
    collapse([{ t: 'custom_foods', k: '', at: 1, del: null, f: {} }]).size, 0);

  // The cursor is the highest updated_at actually sent, never the clock: a
  // dish written while the push was in flight must not fall below it.
  check('cursor is the high-water mark', nextCursor([row('a', 5), row('b', 12)], 0), 12);
  check('and never goes backwards', nextCursor([row('a', 5)], 30), 30);

  // Inclusive, because two rows can share a millisecond and > would drop the
  // second one forever.
  check('since is inclusive of the cursor',
    since([{ updated_at: 10 }, { updated_at: 11 }], 10).length, 2);
}

// -------------------------------------------------- the measure vocabulary

section('Measures: what the picker offers');
{
  const ids = allMeasureIds();
  // The bug this replaces: Object.keys() on an array returns its indices, so
  // the picker offered "0","1","2" and choosing one resolved to nothing.
  check('the list is ids, not array indices', ids.includes('katori') && !ids.includes('0'), true,
    ids.slice(0, 4).join(','));
  check('every id resolves to a measure', ids.every((i) => toMeasure(i) !== null), true);
  check('no duplicates', ids.length === new Set(ids).size, true);

  for (const id of ['katori', 'smallbowl', 'piece', 'cup', 'glass', 'g']) {
    check(`${id} is offered`, ids.includes(id), true);
  }

  // A volume says how big it is, because a katori and a small bowl are the
  // same 150 ml and a cup is not.
  check('katori shows its volume', describeMeasure('katori'), 'Katori (150 ml)');
  check('small bowl shows the same 150', describeMeasure('smallbowl'), 'Small bowl (150 ml)');
  check('glass', describeMeasure('glass'), 'Glass (250 ml)');
  // A count has no volume to show.
  check('piece shows none', describeMeasure('piece'), 'Piece');
  check('grams are spelt out in the picker', describeMeasure('g'), 'Grams');
  check('but the label itself stays short', toMeasure('g')?.label, 'g');
  // A restaurant portion has one, and quoting it would be a lie: the size
  // came from one plate, not from a standard.
  check('a serve does not quote a volume', describeMeasure('serve').includes('ml'), false,
    describeMeasure('serve'));
}

section('Measures: the picker is shorter than the vocabulary');
{
  const offered = allMeasureIds();
  const every = everyMeasureId();

  // Nineteen entries under Pieces, most of them a synonym for one of them.
  // These are out of the picker.
  const gone = ['kg', 'l', 'handful', 'serve', 'large', 'regular', 'burger',
                'bar', 'nugget', 'whole'];
  for (const id of gone) {
    check(`${id} is not offered`, offered.includes(id), false);
    // The load-bearing half: still in the vocabulary, so nothing that already
    // refers to it breaks. Hiding is not deleting.
    check(`${id} still resolves`, toMeasure(id)?.id, id);
    check(`${id} is still in the full list`, every.includes(id), true);
  }

  // Aliases go on working, which is what the CSV importer reads.
  check('"kilograms" still parses', toMeasure('kilograms')?.id, 'kg');
  check('"each" still parses', toMeasure('each')?.id, 'whole');
  check('"medium" still parses', toMeasure('medium')?.id, 'regular');
  check('"sandwich" still parses', toMeasure('sandwich')?.id, 'burger');

  // A shape that names a food carries a weight of its own and stays.
  for (const id of ['piece', 'roti', 'slice', 'egg', 'idli', 'dosa', 'paratha',
                    'naan', 'biscuit', 'clove', 'packet', 'bottle']) {
    check(`${id} is still offered`, offered.includes(id), true);
  }
  // As does every bowl and spoon, and the three weights worth logging a plate in.
  for (const id of ['katori', 'smallbowl', 'bowl', 'cup', 'glass', 'plate',
                    'teacup', 'tsp', 'tbsp', 'scoop', 'ladle', 'g', 'ml', 'tingu']) {
    check(`${id} is still offered`, offered.includes(id), true);
  }

  check('the picker lost exactly ten', every.length - offered.length, gone.length);
  check('and every offered id still resolves',
    offered.every((i) => toMeasure(i) !== null), true);
}

section('Burn: one row a day, and the second entry adds');
{
  // The pure half only — recordBurn talks to the database, so what is checked
  // here is the bucketing and the arithmetic the screen depends on.
  const day = (n: number, h = 9) => new Date(2026, 8, n, h, 0, 0).getTime();

  const rows = [
    { measured_at: day(20), kcal: 400 },
    { measured_at: day(21), kcal: 520 },
    { measured_at: day(21, 19), kcal: 750 }, // corrected later the same day
    { measured_at: day(22), kcal: 300 },
  ];
  const pts = burnByDay(rows);
  check('one point per local day', pts.length, 3);
  check('the later reading wins within a day', pts[1].kcal, 750);
  check('and they come out oldest first', pts[0].kcal, 400);

  // A day nobody logged is absent, never zero. Zero would claim you moved
  // nothing; absence says nobody recorded it.
  const gappy = burnByDay([
    { measured_at: day(20), kcal: 600 },
    { measured_at: day(23), kcal: 600 },
  ]);
  check('a gap is a gap, not a zero', gappy.length, 2);

  check('average', average(pts), Math.round((400 + 750 + 300) / 3));
  check('average of nothing is null', average([]), null);

  // Bars are read against zero, so only the ceiling is chosen.
  check('ceiling clears the tallest bar', ceiling(pts, null), 900);
  check('and clears the target when the target is higher', ceiling(pts, 1500), 1700);
  check('never zero-height', ceiling([], null), 100);
}

section('R5: the de-identification boundary');
{
  const DEVICE = '9f8e7d6c-5b4a-4321-9876-0123456789ab';
  const HOUSE = 'JBSWY3DPEHPK3PXP';
  const ID: Identity = {
    secrets: [DEVICE, HOUSE, 'prof-2b7c91de4f0a'],
    names: ['Upendra', 'Priya'],
  };
  const sys = (content: string) => ({ role: 'system', content });
  const usr = (content: string) => ({ role: 'user', content });

  // The acceptance test, stated as the requirement states it: a realistic
  // payload goes out and no name, no device id and no fine-grained history
  // survives the boundary.
  const payload = [
    sys('You are the Doctor. Device 9f8e7d6c-5b4a-4321-9876-0123456789ab.'),
    sys('Known: Upendra logged 3 meals. Row 0123456789abcdef0123456789abcdef at 1790843792011.'),
    { role: 'assistant', content: 'Priya had 2 meals on 2026-10-01T09:14:22Z.' },
    usr('I have a headache'),
  ];
  const { messages, redactions } = deidentify(payload, ID);
  const wire = JSON.stringify(messages);

  check('the device id is gone', wire.includes(DEVICE), false);
  check('both names are gone', /Upendra|Priya/.test(wire), false);
  check('the row id is gone', wire.includes('0123456789abcdef'), false);
  check('the epoch timestamp is gone', wire.includes('1790843792011'), false);
  check('the clock time is gone', wire.includes('09:14:22'), false);
  check('and every one of them was recorded', redactions.length >= 5, true,
    JSON.stringify(redactions));

  // What must survive, or the boundary is a censor rather than a filter.
  check("the user's own question is untouched", wire.includes('I have a headache'), true);
  check('the persona survives', wire.includes('You are the Doctor'), true);
  check('the facts survive', wire.includes('logged 3 meals'), true);

  // Whole days are the unit the state slice is built in; only the clock is
  // the problem, so a bare date has to come through.
  const dated = deidentify([sys('On 2026-09-28 you logged 4 meals.')], ID);
  check('a bare date is left alone', dated.redactions.length, 0,
    JSON.stringify(dated.messages));

  // The user's words are theirs. Scrubbing a date out of the question someone
  // asked would corrupt the question.
  const typed = deidentify([usr('on 2026-10-01T09:00 I felt dizzy')], ID);
  check("a date the user typed is left alone", typed.redactions.length, 0);
  // But a machine identifier never belongs in any message, including theirs.
  const leaked = deidentify([usr(`my id is ${DEVICE}`)], ID);
  check('a device id in a user message is still taken', leaked.redactions.length, 1);

  // The default profile is called "Me". Replacing that substring everywhere
  // turns "some" into "so[name]" and every other word containing it.
  const shortName = deidentify([sys('Some meals were logged.')],
    { secrets: [], names: ['Me'] });
  check('a two-letter name is skipped', shortName.redactions.length, 0,
    shortName.messages[0].content);

  // 'primary' is the fixed id every install shares, so it identifies nobody
  // and must not be treated as a secret.
  const common = deidentify([sys('the primary complaint was a headache')],
    { secrets: ['primary'], names: [] });
  check("'primary' is too short to be taken as a secret",
    common.messages[0].content.includes('primary complaint'), true);

  // A clean payload is the normal state, and the one the tests assert.
  const clean = deidentify(
    [sys('You are the Nutritionist.'), usr('how much protein today')], ID);
  check('ordinary traffic redacts nothing', clean.redactions.length, 0);
  check('and says so', describeRedactions(clean.redactions), '');
  check('a summary reads for a human', describeRedactions(redactions).includes('redaction'), true,
    describeRedactions(redactions));
}

section('Previous: naming the gap it spans');
{
  const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0, 0).getTime();

  check('same day is zero', daysBetween(at(1, 7), at(1, 22)), 0);
  check('one day', daysBetween(at(1), at(2)), 1);
  // Bucketed to midnight before subtracting, so late night to early morning
  // is one day rather than zero.
  check('11pm to 1am is a day', daysBetween(at(1, 23), at(2, 1)), 1);
  check('order does not matter', daysBetween(at(9), at(1)), 8);

  // The wording has to say which card is speaking. From today, one day back
  // is yesterday; from the previous reading, it is the day before that one.
  check('today, one day', spanLabel(1, 'today'), 'on yesterday');
  check('previous, one day', spanLabel(1, 'previous'), 'on the day before');
  check('longer gaps are counted', spanLabel(4, 'today'), 'over 4 days');
  check('and counted the same either way', spanLabel(4, 'previous'), 'over 4 days');
  // The whole reason the span is shown: a bare figure reads as overnight.
  check('never silently implies yesterday', spanLabel(12, 'today').includes('yesterday'), false);

  // Locale-agnostic on purpose: the label uses the device's own date order,
  // so "27 Oct" and "Oct 27" are both correct and the test must not pick one.
  const when = whenLabel(at(27), at(31));
  check('the date line carries a date', /\d/.test(when) && /[A-Za-z]{3}/.test(when), true, when);
  check('and the distance', when.endsWith('· 4 days ago'), true, when);
  check('one day back reads as yesterday',
    whenLabel(at(5), at(6)).endsWith('yesterday'), true, whenLabel(at(5), at(6)));
}

section('Burn: a run is calendar days, not readings');
{
  const day = (n: number) => new Date(2026, 8, n, 9, 0, 0).getTime();
  const at = (n: number, kcal: number) => ({ t: day(n), kcal });

  check('three in a row', streak([at(20, 600), at(21, 600), at(22, 600)], 500), 3);
  check('the latest under target ends it', streak([at(20, 600), at(21, 400)], 500), 0);
  check('a miss part-way stops the count', streak([at(20, 600), at(21, 300), at(22, 600)], 500), 1);

  // The one that matters. Monday and Wednesday both at target with no Tuesday
  // is not "two days running" — that asserts something about a Tuesday there
  // is no reading for.
  check('a missing day breaks the run', streak([at(20, 600), at(22, 600)], 500), 1);
  check('exactly on target counts', streak([at(22, 500)], 500), 1);
  check('no target means no run', streak([at(22, 900)], null), 0);
  check('nothing logged means no run', streak([], 500), 0);

  // Slots span the data, not the range, so a year view with a month of
  // readings does not lay out 365 two-pixel splinters.
  check('slots span the data', slotsFor([at(20, 1), at(22, 1)], day(22)), 7);
  check('and grow once there is more than the floor',
    slotsFor([at(1, 1), at(22, 1)], day(22)), 22);
  check('with nothing logged, the floor', slotsFor([], day(22)), 7);
}

section('Measures: three katoris of sambar');
{
  // The case that started this. Sambar is anchored in bowls; a katori answer
  // comes through density, and three of them is not one and a half bowls.
  const sambar: Anchor[] = [{ measure: 'bowl', quantity: 1, net_weight_g: 350 }];
  const bowl = resolvePortion(1.5, 'bowl', sambar);
  check('1.5 bowl is what the screen showed', bowl.grams, 525);
  const katori = resolvePortion(3, 'katori', sambar);
  check('3 katori is 450g, not 525', katori.grams, 450);
  check('and it says it was derived', katori.basis, 'density');

  // Weighing it is the exact path: no derivation at all.
  const weighed = resolvePortion(450, 'g', sambar);
  check('450 g is 450 g', weighed.grams, 450);
  check('straight off the scale', weighed.basis, 'weight');
  check('and 1 kg is 1000 g', resolvePortion(1, 'kg', sambar).grams, 1000);
}

section('Tingu: the house unit');
{
  // 100 g flat, and weight-kind on purpose: no anchor, no density, so it
  // resolves the same for every dish and nothing is added to any of them.
  check('tingu is offered', allMeasureIds().includes('tingu'), true);
  check('it says what it is', describeMeasure('tingu'), 'Tingu (100 g)');
  check('and it is a weight', toMeasure('tingu')?.kind, 'weight');

  const dal: Anchor[] = [{ measure: 'katori', quantity: 1, net_weight_g: 150 }];
  const none: Anchor[] = [];
  check('1 tingu is 100 g', resolvePortion(1, 'tingu', dal).grams, 100);
  check('2.5 tingu is 250 g', resolvePortion(2.5, 'tingu', dal).grams, 250);
  // The point of weight-kind: a dish with no anchors at all still resolves.
  check('it needs no anchor', resolvePortion(3, 'tingu', none).grams, 300);
  check('and reads as weighed, not derived', resolvePortion(1, 'tingu', dal).basis, 'weight');
  check('plural parses', toMeasure('tingus')?.id, 'tingu');

  // Count measures are untouched: a roti is still a roti.
  const roti: Anchor[] = [{ measure: 'piece', quantity: 1, net_weight_g: 35 }];
  check('a piece is unaffected', resolvePortion(2, 'piece', roti).grams, 70);
  check('and a serve still refuses to derive',
    resolvePortion(1, 'serve', roti).basis, 'restaurant');
}

// ------------------------------------------------------------ migrations

/**
 * A migration runs once, on a phone holding the only copy of someone's
 * history, and its transaction only protects against SQL that errors. SQL that
 * is valid and wrong commits. So the two guards below run before anything
 * ships, and they are deliberately blunt.
 *
 * Comments are stripped before either looks, so correcting the reasoning in a
 * shipped migration is allowed and changing what it does is not. The stripper
 * is naive about `--` inside a string literal; no migration has one, and the
 * day one does this fails loudly rather than quietly.
 */
function sqlOf(m: Migration): string {
  return m.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Pinned when a migration ships. A phone that already ran v3 will never run it
 * again, so editing v3 does not fix anyone's data — it forks the schema into
 * "phones that installed before the edit" and "after", with nothing recording
 * which is which. A new migration needs its pin added here, which is the point:
 * shipping one is a decision, not a side effect of merging.
 */
const SHIPPED: Record<number, string> = {
  1: '6d19aa27eadbbbf4',
  2: 'b97f9671112fc251',
  3: '892ee1ea68b7baf5',
  4: '8d7b7389e9afac9f',
  5: '53116ed260f65f9a',
  6: '46cf98f569649e1a',
  7: '38e1614eef705c52',
  8: 'c77a06d22d3e2df7',
  9: '0d8a642f53260b28',
};

/**
 * Statements that remove or rewrite existing rows. An UPDATE is let through
 * only when it fills a single column where that column is still NULL — the
 * shape of every backfill, and the one shape that cannot overwrite something a
 * person typed. REPLACE is here because it is a DELETE followed by an INSERT,
 * and the delete takes every column the new row does not mention.
 */
function destructive(sql: string): string[] {
  const found: string[] = [];
  for (const raw of sql.split(';')) {
    const s = raw.trim();
    if (!s) continue;
    const fillsNull =
      /^UPDATE\s+\w+\s+SET\s+(\w+)\s*=[^,]*\bWHERE\s+\1\s+IS\s+NULL\s*$/i.test(s);
    if (
      /\bDROP\s+TABLE\b/i.test(s) ||
      /\bALTER\s+TABLE\s+\w+\s+(DROP|RENAME)\b/i.test(s) ||
      /\bDELETE\s+FROM\b/i.test(s) ||
      /\b(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i.test(s) ||
      (/^UPDATE\b/i.test(s) && !fillsNull)
    ) {
      found.push(s);
    }
  }
  return found;
}

/**
 * Rewrites that shipped knowingly. Each is keyed by version and the exact
 * statement, so a second rewrite slipped into the same migration is still
 * caught. Adding to this list should need the same justification these have.
 */
const SANCTIONED: Record<string, string> = {
  "4:UPDATE current_state SET id = 'primary' WHERE id = 'singleton'":
    'the one pre-profile state row becomes the primary profile\'s; content untouched',
  "4:UPDATE conversation_summaries SET id = 'primary:' || id WHERE id IN ('doctor','nutritionist','pharmacist')":
    'summaries re-keyed to <profile>:<agent>; content untouched',
};

section('Migrations: what shipped stays shipped');
{
  const versions = MIGRATIONS.map((m) => m.version);
  check('numbered 1..n with no gaps',
    versions, versions.map((_, i) => i + 1));
  check('LATEST_VERSION is the last one', LATEST_VERSION, versions.at(-1));

  for (const m of MIGRATIONS) {
    const sum = createHash('sha256').update(sqlOf(m)).digest('hex').slice(0, 16);
    if (SHIPPED[m.version] === undefined) {
      check(`v${m.version} is pinned — add ${m.version}: '${sum}' to SHIPPED once it ships`,
        false, true);
    } else {
      check(`v${m.version} unchanged since it shipped`, sum, SHIPPED[m.version]);
    }
  }
}

section('Migrations: nothing deletes or rewrites a row');
{
  for (const m of MIGRATIONS) {
    const unsanctioned = destructive(sqlOf(m)).filter(
      (s) => SANCTIONED[`${m.version}:${s}`] === undefined,
    );
    check(`v${m.version} ${m.name}`, unsanctioned, []);
  }

  // Every sanctioned entry still matches a real statement. An entry that
  // matches nothing is either a typo or a statement that changed, and either
  // way it would be quietly sanctioning nothing while looking like a review.
  const live = new Set(
    MIGRATIONS.flatMap((m) => destructive(sqlOf(m)).map((s) => `${m.version}:${s}`)),
  );
  for (const key of Object.keys(SANCTIONED)) {
    check(`sanctioned rewrite still exists: ${key.slice(0, 50)}…`, live.has(key), true);
  }

  // The lint itself, against the mistakes it exists for. Without these a
  // regex that matched nothing would pass every migration forever.
  const caught = (s: string) => destructive(s).length > 0;
  check('catches DROP TABLE', caught('DROP TABLE meals'), true);
  check('catches DROP TABLE IF EXISTS', caught('drop table if exists meals'), true);
  check('catches a dropped column', caught('ALTER TABLE meals DROP COLUMN raw_text'), true);
  check('catches a dropped column without COLUMN', caught('ALTER TABLE meals DROP raw_text'), true);
  check('catches a renamed column', caught('ALTER TABLE meals RENAME COLUMN raw_text TO text'), true);
  check('catches a renamed table', caught('ALTER TABLE meals RENAME TO meal'), true);
  check('catches DELETE', caught("DELETE FROM meals WHERE deleted_at IS NOT NULL"), true);
  check('catches INSERT OR REPLACE', caught("INSERT OR REPLACE INTO targets (id) VALUES ('x')"), true);
  check('catches REPLACE INTO', caught("REPLACE INTO targets (id) VALUES ('x')"), true);
  check('catches an UPDATE with no WHERE', caught('UPDATE meals SET meal_type = NULL'), true);
  check('catches an UPDATE over live values',
    caught("UPDATE meal_items SET source = 'matched' WHERE source = 'direct'"), true);
  check('catches a backfill that also sets a second column',
    caught("UPDATE meals SET profile_id = 'primary', meal_type = 'lunch' WHERE profile_id IS NULL"), true);
  check('catches a backfill guarded on a different column',
    caught("UPDATE meals SET meal_type = 'lunch' WHERE profile_id IS NULL"), true);
  check('catches a NULL guard with more after it',
    caught("UPDATE meals SET profile_id = 'primary' WHERE profile_id IS NULL OR 1"), true);
  check('finds the bad one among good ones',
    destructive('CREATE TABLE a (id TEXT); DELETE FROM meals; ALTER TABLE a ADD COLUMN b TEXT').length, 1);

  check('lets a NULL backfill through',
    caught("UPDATE meals SET profile_id = 'primary' WHERE profile_id IS NULL"), false);
  check('lets additive DDL through',
    caught('CREATE TABLE IF NOT EXISTS x (id TEXT); ALTER TABLE x ADD COLUMN y REAL; CREATE INDEX i ON x(y)'),
    false);
  check('lets INSERT OR IGNORE through',
    caught("INSERT OR IGNORE INTO profiles (id) VALUES ('primary')"), false);
}

// ------------------------------------------------------------------ done

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// --------------------------------------------------- text parsing
