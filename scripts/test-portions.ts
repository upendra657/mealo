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
import { canonicalMeasure, toMeasure } from '../src/domain/measures';
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

// ------------------------------------------------------------------ done

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// --------------------------------------------------- text parsing
