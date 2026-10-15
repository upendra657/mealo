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
  wheelMeasures,
} from '../src/domain/measures';
import { normalise, slugFor } from '../src/domain/foods';
import { settledValue } from '../src/lib/wheel';
import { CsvReader, emptySkips, formFromText, parseComposition, presetFor, rowsToItems } from '../src/lib/tabular';
import { columnIndex, readXlsx } from '../src/lib/xlsx';
import { strToU8, zipSync } from 'fflate';
import { lookupNames, matchLabels, sentenceNaming, worthKeeping } from '../src/domain/interactions';
import { isNoMatch } from '../src/data/drugs';
import { daysBetween, spanLabel, whenLabel } from '../src/domain/weight';
import {
  deidentify,
  describeRedactions,
  scrubContacts,
  type Identity,
} from '../src/safety/deidentify';
import { answerBlocks, canElaborate, ELABORATE, figuresFor, figuresNote, spansOf } from '../src/domain/chat';
import { humanReport, wantsAiFile } from '../src/domain/report';
import { backupName, COUNTED, describe, refusal, REQUIRED, sameRows, sizeLabel, type BackupInfo } from '../src/db/backup';
import { SYMPTOM_GROUPS, SYMPTOM_LABELS, suggestLabel, wordsForModel, WORDS_FOR_MODEL } from '../src/domain/symptomlabels';
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
  deck,
  medsCard,
  type BannerCtx,
  type MedsGlance,
} from '../src/domain/banner';
import {
  clock, dosesAction, dosesReceipt, entriesFrom, entryTime, mealReceipt, mealSummary, nextMark, PILLS, TRY_ASKING,
} from '../src/domain/chat';
import { triage } from '../src/safety/redflags';
import {
  buildExport, dateLabel, fileName, MAX_DAYS, periodDays, periodLabel, reportRequest, scopeHolds, type ExportInput, type ExportItem,
} from '../src/domain/export';
import type { Macros } from '../src/domain/day';
import {
  addDays,
  amountsSet,
  buildLog,
  daysBetweenInclusive,
  describeSchedule,
  dueOn,
  EVERY_DAY,
  nextDue,
  scheduleColumns,
  scheduleOf,
  daysFrom,
  describeDose,
  durationLabel,
  fmtAmount,
  FORMS,
  isRunning,
  lastDayOf,
  lengths,
  medDay,
  medSlug,
  partOfDay,
  planDay,
  progress,
  resizeDoses,
  tileNote,
  unitFor,
  UNITS_FOR,
  type TimeOfDay,
} from '../src/domain/doses';
import {
  chunkRows,
  CHUNK_BYTES,
  collapse,
  fingerprint,
  isAddressable,
  isMedTable,
  READS,
  WIRE_VERSION,
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
import { parseMealText, withParts } from '../src/domain/foods';
import { checkRowsFor, checkSheetCsv } from '../src/domain/checksheet';
import { anchorsAfter, previewEntries, recalcEntry, type DishEdit } from '../src/domain/dishedit';
import {
  canTick,
  circleOf,
  counts,
  dayLabel,
  daysFromToday,
  lastPlannableDay,
  nextPlanState,
  plansAt,
  tickStamp,
  USUAL_HOUR,
} from '../src/domain/plan';
import { guessSlot } from '../src/domain/slots';
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

  // His omelette, 11 Oct: the cheese after "with" was swallowed by the dish.
  check('a dish that is also a measure, then "with"', one('2 roti with 1 katori dal'), { label: 'roti with 1 katori dal', quantity: 2, unit: null });
  check('a real measure before the dish is untouched', one('2 egg omelette with cheese'), { label: 'omelette with cheese', quantity: 2, unit: 'egg' });
  check('"with" names a second thing', withParts("omelette with d'lecta cheddar cheese"), ['omelette', "d'lecta cheddar cheese"]);
  check('and a third', withParts('poha with peanuts with lemon'), ['poha', 'peanuts', 'lemon']);
  check('"along with" and "w/" too', [withParts('roti along with dal'), withParts('toast w/ butter')], [['roti', 'dal'], ['toast', 'butter']]);
  check('no "with", one part', withParts('dal tadka'), ['dal tadka']);
  check('"with" inside a word is not a join', withParts('withania tea'), ['withania tea']);
  check('nor at the very start or end', [withParts('with cheese'), withParts('omelette with')], [['with cheese'], ['omelette with']]);
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

  check('a medicine keys on its slug, name and strength',
    wireKey('med_products', { slug: 'paracetamol 650 mg' }), 'paracetamol 650 mg');
  check('an ingredient keys on its medicine and position',
    wireKey('med_product_ingredients', { product_slug: 'calcium d3 1250 mg', position: 2 }),
    'calcium d3 1250 mg|2');
  check('a starting dose the same way',
    wireKey('med_product_doses', { product_slug: 'calcium d3 1250 mg', position: 1 }),
    'calcium d3 1250 mg|1');
  const ingr: WireRow = { t: 'med_product_ingredients', k: 'calcium d3 1250 mg|1', at: 5, del: null,
    f: { product_slug: 'calcium d3 1250 mg', position: 1, name: 'Calcium carbonate', strength_text: '1250 mg' } };
  check('an ingredient is addressable', isAddressable(ingr), true);
  check('one with no medicine is not',
    isAddressable({ ...ingr, f: { ...ingr.f, product_slug: '' }, k: '|1' }), false);
  check('nor one with no position',
    isAddressable({ ...ingr, f: { ...ingr.f, position: null }, k: 'calcium d3 1250 mg|' }), false);
  check('medicine tables are told apart from food ones',
    [isMedTable('med_products'), isMedTable('med_product_doses'), isMedTable('custom_foods')],
    [true, true, false]);
  check('batches are version 2 now, and 1 is still read', [WIRE_VERSION, READS.includes(1)], [2, true]);
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
    // Each side as the code now builds it: its content, fingerprinted.
    const A = { updated_at: aAt, deleted_at: null, source: aSrc, fp: fingerprint({ del: null, f: { v: aId } }) };
    const B = { updated_at: bAt, deleted_at: null, source: bSrc, fp: fingerprint({ del: null, f: { v: bId } }) };
    const fromA = resolve('food_portions', A, B) === 'incoming' ? bId : aId;
    const fromB = resolve('food_portions', B, A) === 'incoming' ? aId : bId;
    if (fromA !== fromB) disagreements++;
  }
  check('both devices always pick the same row', disagreements, 0);

  // The bug, as the apply code really called it until 15 Oct 2026: the
  // incoming side had no id, so on a tie it always won, on both phones, and
  // each took the other's version. Now both compare the wire content.
  const dalA = { t: 'custom_foods' as const, k: 'dal', at: 500, del: null, f: { slug: 'dal', name: 'Dal', energy_kcal: 120 } };
  const dalB = { ...dalA, f: { ...dalA.f, energy_kcal: 135 } };
  const side = (w: typeof dalA) => ({ updated_at: w.at, deleted_at: w.del, fp: fingerprint(w) });
  const onA = resolve('custom_foods', side(dalA), side(dalB)) === 'incoming' ? 135 : 120;
  const onB = resolve('custom_foods', side(dalB), side(dalA)) === 'incoming' ? 120 : 135;
  check('two edits in the same millisecond: both phones keep the same one', onA, onB);
  check('the same version arriving again is no change', resolve('custom_foods', side(dalA), side(dalA)), 'local');
  check('a fingerprint does not depend on the order of the fields',
    fingerprint({ del: null, f: { a: 1, b: 'x' } }), fingerprint({ del: null, f: { b: 'x', a: 1 } }));
  check('a delete and a live row in the same millisecond differ', fingerprint({ del: 5, f: { a: 1 } }) === fingerprint({ del: null, f: { a: 1 } }), false);
  check('with this phone\'s version unknown, it keeps what is here', resolve('custom_foods', { updated_at: 500, deleted_at: null }, side(dalB)), 'local');
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
  const gone = ['kg', 'l', 'handful', 'large', 'regular', 'burger',
                'bar', 'nugget', 'whole',
                // 7 Oct 2026: the measures that name a food, where piece is
                // enough, and the three bowls this kitchen never logs in.
                'roti', 'paratha', 'naan', 'idli', 'dosa', 'egg', 'biscuit',
                'clove', 'ladle', 'scoop', 'plate'];
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
  check('"chapati" still parses', toMeasure('chapati')?.id, 'roti');
  check('"3 cloves" still parses', toMeasure('cloves')?.id, 'clove');
  check('"karchi" still parses', toMeasure('karchi')?.id, 'ladle');
  check('"thali" still parses', toMeasure('thali')?.id, 'plate');

  // A meal logged in one before it was hidden weighs what it did: a dish with
  // no roti portion of its own still falls back to the household 40 g.
  check('2 roti still weighs 80 g', resolvePortion(2, 'roti', []).grams, 80);
  check('a ladle still weighs 60 g', resolvePortion(1, 'ladle', []).grams, 60);

  // What stays: the four pieces worth naming, every bowl and spoon this
  // kitchen uses, and the three weights worth logging a plate in.
  // serve back in on 15 Oct 2026, his call.
  const kept = ['piece', 'serve', 'slice', 'packet', 'bottle',
                'katori', 'smallbowl', 'bowl', 'cup', 'glass', 'teacup', 'tsp', 'tbsp',
                'g', 'ml', 'tingu'];
  for (const id of kept) {
    check(`${id} is still offered`, offered.includes(id), true);
  }
  check('and nothing else is', [...offered].sort(), [...kept].sort());

  // "pack" on screen, 'packet' underneath: the stored id did not move.
  check('packet is shown as Pack', describeMeasure('packet'), 'Pack');
  check('"packet" still finds it', toMeasure('packet')?.id, 'packet');
  check('"pack" finds it', toMeasure('pack')?.id, 'packet');
  check('"2 packs" finds it', toMeasure('packs')?.id, 'packet');

  check('the picker lost exactly the hidden ones', every.length - offered.length, gone.length);
  check('and every offered id still resolves',
    offered.every((i) => toMeasure(i) !== null), true);
}

section('Measures: the wheel keeps the unit a meal was logged in');
{
  const offered = allMeasureIds();

  // The bug: "2 roti" logged before roti was hidden, on a Roti dish whose only
  // portion is a piece. The wheel's list had no roti, so it highlighted its
  // first row and read "Piece" over a meal that says roti.
  const old = wheelMeasures(['piece'], 'roti');
  check('the old meal\'s unit is on the wheel', old.includes('roti'), true);
  check('right after the dish\'s own', old.slice(0, 2), ['piece', 'roti']);
  check('once', old.filter((x) => x === 'roti').length, 1);
  check('and the picker follows, whole', old.slice(2), offered.filter((x) => x !== 'piece'));
  check('only that one hidden unit comes back', old.includes('idli'), false);

  // Upendra's own weighed portions stay, hidden or not: a Roti dish with
  // "1 roti = 40 g" saved still offers roti, first, and only once.
  const own = wheelMeasures(['roti'], 'roti');
  check('a saved roti portion leads', own[0], 'roti');
  check('and is not repeated', own.filter((x) => x === 'roti').length, 1);

  // Nothing changes for a unit already on offer, or for no unit at all.
  const plain = ['piece', ...offered.filter((x) => x !== 'piece')];
  check('an offered unit adds nothing', wheelMeasures(['piece'], 'katori'), plain);
  check('nor does no unit', wheelMeasures(['piece'], null), plain);
  check('a dish with no portions gets the picker', wheelMeasures([], null), offered);
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
  10: 'f43590523ac269c1',
  11: '67e1fd8a3fbb5520',
  12: '5d81a83c35f6cae2',
  13: 'ca5525f7a2b617e6',
  14: '705d60a7e713cd93',
  15: '41352f50b2fd5321',
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

// --------------------------------------------------------------- medicines

section('Medicines: how an amount reads');
check('one tablet', fmtAmount(1, 'tablet'), '1 tablet');
check('two tablets', fmtAmount(2, 'tablet'), '2 tablets');
check('half a tablet is not "tablets"', fmtAmount(0.5, 'tablet'), '0.5 tablet');
check('ml never pluralises', fmtAmount(10, 'ml'), '10 ml');
check('grams never pluralise', fmtAmount(5, 'g'), '5 g');
check('scoops do', fmtAmount(2, 'scoop'), '2 scoops');
check('drops do', fmtAmount(2, 'drop'), '2 drops');
check('no amount says so rather than "null"', fmtAmount(null, 'tablet'), 'amount not set');
check('a whole dose line', describeDose({ amount: 1, unit: 'tablet', time_of_day: 'morning', meal: 'after' }),
  '1 tablet · after meal');
check('drops are a form, counted in drops', UNITS_FOR.drops, ['drop']);
check('every form has a unit', FORMS.every((f) => UNITS_FOR[f.id].length > 0), true);

section('Medicines: the library merge key');
check('"650mg" and "650 MG" are the same strip',
  medSlug('Paracetamol', '650mg'), medSlug('paracetamol', '650 MG'));
check('the strength is part of it', medSlug('Thyroxine', '25 mcg') === medSlug('Thyroxine', '50 mcg'), false);
check('no strength still keys on the name', medSlug('Cough syrup', null), 'cough syrup');

section('Medicines: changing "times a day"');
{
  const one = [{ amount: 2, unit: 'tablet' as const, time_of_day: 'morning' as const, meal: 'before' as const }];
  const two = resizeDoses(one, 2, 'tablet');
  check('2 keeps the first row as typed', two[0], one[0]);
  check('and adds night with its unit and meal, but no amount', [two[1].time_of_day,
    two[1].unit, two[1].meal, two[1].amount], ['night', 'tablet', 'before', null]);
  check('a fresh form has no amount either', resizeDoses([], 1, 'tablet')[0].amount, null);
  check('so it cannot be saved yet', amountsSet(resizeDoses([], 1, 'tablet')), false);
  check('until every dose has one', amountsSet(one), true);
  const three = resizeDoses(two, 3, 'tablet');
  check('3 adds the afternoon, in day order', three.map((d) => d.time_of_day),
    ['morning', 'afternoon', 'night']);
  check('4 is the most', resizeDoses(three, 9, 'tablet').length, 4);
  check('down to 1 keeps the first', resizeDoses(three, 1, 'tablet').map((d) => d.time_of_day), ['morning']);
  check('a first row starts in the form\'s unit', resizeDoses([], 1, 'syrup')[0].unit, 'ml');
  check('switching to powder keeps a unit that fits', unitFor('powder', 'g'), 'g');
  check('and replaces one that does not', unitFor('syrup', 'tablet'), 'ml');
}

section('Medicines: the sickness calendar');
check('7 days from Tue 6 Oct ends Mon 12 Oct', lastDayOf('2026-10-06', 7, 'days'), '2026-10-12');
check('1 week is the same 7 days', lastDayOf('2026-10-06', 1, 'weeks'), '2026-10-12');
check('1 day is just today', lastDayOf('2026-10-06', 1, 'days'), '2026-10-06');
check('a calendar month: 6 Oct runs to 5 Nov', lastDayOf('2026-10-06', 1, 'months'), '2026-11-05');
check('from 31 Jan, held at the end of February', lastDayOf('2026-01-31', 1, 'months'), '2026-02-27');
check('a year from a leap day', lastDayOf('2024-02-29', 1, 'years'), '2025-02-27');
check('across a year end', lastDayOf('2026-12-20', 3, 'weeks'), '2027-01-09');
{
  const e = { id: 'e', name: 'Viral fever', started_on: '2026-10-04', last_day: '2026-10-10',
    duration_n: 7, duration_unit: 'days', recovered_on: null };
  check('day 3 of 7 with 5 to go, today counting', progress(e, '2026-10-06'), { day: 3, total: 7, toGo: 5 });
  check('running on its first day', isRunning(e, '2026-10-04'), true);
  check('and its last', isRunning(e, '2026-10-10'), true);
  check('not the day after', isRunning(e, '2026-10-11'), false);
  check('not before it began', isRunning(e, '2026-10-03'), false);
  const rec = { ...e, recovered_on: '2026-10-08' };
  check('recovered ends it that day', isRunning(rec, '2026-10-08'), false);
  check('but not the day before', isRunning(rec, '2026-10-07'), true);
  check('it ran 4 of 7 planned days', lengths(rec), { planned: 7, lasted: 4 });
  check('recovered on day one still lasted a day',
    lengths({ ...e, recovered_on: '2026-10-04' }), { planned: 7, lasted: 1 });
  check('extended to the 13th: planned 7, lasted 10',
    lengths({ ...e, last_day: '2026-10-13' }), { planned: 7, lasted: 10 });
}
check('"1 weeks" reads as "1 week"', durationLabel(1, 'weeks'), '1 week');
check('half past midnight is still last night', medDay(new Date(2026, 9, 7, 0, 30)), '2026-10-06');
check('three o\'clock is the new day', medDay(new Date(2026, 9, 7, 3, 0)), '2026-10-07');
check('two in the afternoon is the afternoon', partOfDay(new Date(2026, 9, 7, 14, 0)), 'afternoon');
{
  // A clock change inside a sickness. Node reads TZ afresh when it changes,
  // so this runs in a zone that has one: US clocks went forward on 8 Mar 2026.
  const was = process.env.TZ;
  process.env.TZ = 'America/New_York';
  check('across a clock change, still 7 calendar days', lastDayOf('2026-03-05', 7, 'days'), '2026-03-11');
  check('and two days are two days', daysFrom('2026-03-07', '2026-03-09'), 2);
  check('and the day after is the 9th', addDays('2026-03-08', 1), '2026-03-09');
  if (was === undefined) delete process.env.TZ;
  else process.env.TZ = was;
}

section('Medicines: what is due on a day');
{
  const day = '2026-10-06';
  const at2pm = new Date(2026, 9, 6, 14, 0);
  const med = (id: string, long_term: number | null, episode_id: string | null = null) =>
    ({ id, name: id, dose_text: null, schedule: null, long_term, episode_id });
  const dose = (id: string, medication_id: string, time_of_day: TimeOfDay) =>
    ({ id, medication_id, position: 1, amount: 1, unit: 'tablet' as const, time_of_day, meal: 'after' as const });
  const meds = [
    med('thyroxine', 1), med('creatine', 0), med('old vitamin', null), med('unasked', null),
    med('syrup', 0, 'fever'), med('antibiotic', 0, 'last-month'),
  ];
  const doses = [
    dose('d-thy', 'thyroxine', 'morning'), dose('d-cre', 'creatine', 'morning'),
    dose('d-una', 'unasked', 'night'), dose('d-syr', 'syrup', 'night'),
    dose('d-ant', 'antibiotic', 'morning'),
  ];
  const fever = { id: 'fever', name: 'Fever', started_on: '2026-10-05', last_day: '2026-10-09',
    duration_n: 5, duration_unit: 'days', recovered_on: null };
  const lastMonth = { ...fever, id: 'last-month', started_on: '2026-09-01', last_day: '2026-09-07' };

  const well = planDay(day, meds, doses, [lastMonth], [], at2pm);
  const wellIds = well.groups.flatMap((g) => g.doses.map((p) => p.med.id));
  check('well: every regular medicine with slots is due', wellIds.sort(),
    ['creatine', 'thyroxine', 'unasked']);
  check('a finished course is not', wellIds.includes('antibiotic'), false);
  check('nor a sickness medicine with no sickness running', wellIds.includes('syrup'), false);
  check('a medicine with no slots is shown as written', well.unscheduled.map((m) => m.id), ['old vitamin']);
  check('morning, two hours ago, is due', well.groups[0].doses[0].state, 'due');
  check('night is later', well.groups.at(-1)!.doses[0].state, 'later');

  const sick = planDay(day, meds, doses, [fever, lastMonth], [], at2pm);
  const sickIds = sick.groups.flatMap((g) => g.doses.map((p) => p.med.id));
  check('sick: the long-term medicine continues', sickIds.includes('thyroxine'), true);
  check('the sickness medicine is due', sickIds.includes('syrup'), true);
  check('the regular one pauses', sick.paused.map((p) => p.med.id).includes('creatine'), true);
  check('so does one nobody was asked about', sick.paused.map((p) => p.med.id).includes('unasked'), true);
  check('and one from before slots', sick.paused.map((p) => p.med.id).includes('old vitamin'), true);
  check('the running sickness is the one reported', sick.episode?.id, 'fever');

  const ticks = [
    { id: 't1', dose_id: 'd-thy', status: 'taken' as const, updated_at: 1 },
    { id: 't2', dose_id: 'd-thy', status: 'skipped' as const, updated_at: 2 },
  ];
  const ticked = planDay(day, meds, doses, [], ticks, at2pm);
  const thy = ticked.groups.flatMap((g) => g.doses).find((p) => p.dose.id === 'd-thy')!;
  check('the newest answer for a dose wins', [thy.state, thy.eventId], ['skipped', 't2']);
  check('a past day\'s unticked doses are missed, not due',
    planDay('2026-10-01', meds, doses, [], [], at2pm).groups.flatMap((g) => g.doses)
      .every((p) => p.state === 'missed'), true);

  // The line under "Track meds" on Home, from the same plan.
  check('the tile counts today\'s doses, none ticked', tileNote(well), '0 of 3 taken');
  const tick = (id: string, dose_id: string, status: 'taken' | 'skipped') => ({ id, dose_id, status, updated_at: 1 });
  check('a taken dose counts', tileNote(planDay(day, meds, doses, [lastMonth], [tick('a', 'd-thy', 'taken')], at2pm)),
    '1 of 3 taken');
  check('a skipped dose is answered but was not taken',
    tileNote(planDay(day, meds, doses, [lastMonth], [tick('a', 'd-thy', 'taken'), tick('b', 'd-cre', 'skipped')], at2pm)),
    '1 of 3 taken');
  check('all of them', tileNote(planDay(day, meds, doses, [lastMonth],
    [tick('a', 'd-thy', 'taken'), tick('b', 'd-cre', 'taken'), tick('c', 'd-una', 'taken')], at2pm)), '3 of 3 taken');
  check('a missed dose still counts as one of the day\'s', tileNote(planDay('2026-10-01', meds, doses, [], [], at2pm)),
    '0 of 3 taken');
  check('no medicines at all', tileNote(planDay(day, [], [], [], [], at2pm)), 'No medicines yet');
  check('medicines, but none with a dose today',
    tileNote(planDay(day, [med('old vitamin', null)], [], [], [], at2pm)), 'Nothing due today');
  check('everything paused by a sickness with no medicine of its own',
    tileNote(planDay(day, [med('creatine', 0)], [dose('d-cre', 'creatine', 'morning')], [fever], [], at2pm)),
    'Nothing due today');
  check('the tile never states an amount or a name', /mg|tablet|thyroxine/i.test(tileNote(well)), false);
}

section('The scroll wheel reports only a real choice');
{
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  check('scrolled from the 6th to the 15th, it reports 15', settledValue(days, 6, 14 * 40, 40, true), 15);
  check('resting where it already was, it reports nothing', settledValue(days, 6, 5 * 40, 40, true), null);
  check('parking itself is never a choice (Sunday = 0 parked at "1st")',
    settledValue(days, 0, 0, 40, false), null);
  check('nor is following a typed value', settledValue(days, 6, 14 * 40, 40, false), null);
  check('but a person scrolling off a value the list lacks is',
    settledValue(['katori', 'bowl'], 'old-unit', 40, 40, true), 'bowl');
  check('a scroll past the end clamps to the last row', settledValue(days, 6, 99 * 40, 40, true), 31);
}

section('Label check: matching by ingredient');
{
  check('a whole word is found', sentenceNaming('Use with warfarin needs care. Other text.', 'warfarin'),
    'Use with warfarin needs care.');
  check('"iron" is not inside "environment"', sentenceNaming('Store in a dry environment.', 'iron'), null);
  check('a hyphenated form still names it', sentenceNaming('Avoid warfarin-like agents.', 'warfarin') !== null, true);
  check('case does not matter', sentenceNaming('CALCIUM CARBONATE binds it.', 'calcium carbonate') !== null, true);
  check('three letters are too few to trust', sentenceNaming('Use with ASA.', 'asa'), null);

  // Synthetic fixture text, not real label wording: only the matching is tested.
  const label = (full: string | undefined, clipped = '') => ({
    productName: 'FIXTURE', genericNames: [], retrievedAt: 1, sourceUrl: 'https://example.invalid',
    sections: clipped ? [{ section: 'drug_interactions' as const, text: clipped }] : [],
    interactionsFull: full,
  });
  const items = [
    { med: { id: 't', name: 'Thyronorm' }, substances: [{ written: 'Thyroxine', us: ['levothyroxine'] }] },
    { med: { id: 'c', name: 'Calcium + D3' }, substances: [
      { written: 'Calcium carbonate', us: ['calcium carbonate'] },
      { written: 'Cholecalciferol', us: ['cholecalciferol'] }] },
    { med: { id: 'd', name: 'Dolo 650' }, substances: [{ written: 'Paracetamol', us: ['acetaminophen'] }] },
    { med: { id: 'k', name: 'Cold tablet' }, substances: [
      { written: 'Paracetamol', us: ['acetaminophen'] }, { written: 'Caffeine', us: ['caffeine'] }] },
  ];
  const labels = new Map([
    ['levothyroxine', label('Fixture sentence one. Fixture naming calcium carbonate here. Again calcium carbonate.')],
    ['acetaminophen', label('Fixture naming acetaminophen itself and caffeine too.')],
  ]);
  const found = matchLabels(items, labels);
  const lab = found.filter((f) => f.kind === 'label');
  check('Thyronorm\'s label names Calcium + D3, found through the US names',
    lab.some((f) => f.kind === 'label' && f.sourceMed === 'Thyronorm' && f.mentions === 'Calcium + D3'
      && f.sourceIngredient === 'levothyroxine' && f.mentionsIngredient === 'calcium carbonate'), true);
  check('one finding however many sentences repeat it',
    lab.filter((f) => f.kind === 'label' && f.mentions === 'Calcium + D3').length, 1);
  check('a label naming its own ingredient is not an interaction with the other paracetamol',
    lab.some((f) => f.kind === 'label' && f.mentionsIngredient === 'acetaminophen'), false);
  check('but another ingredient of that tablet still counts',
    lab.some((f) => f.kind === 'label' && f.sourceMed === 'Dolo 650' && f.mentionsIngredient === 'caffeine'), true);
  const shared = found.filter((f) => f.kind === 'shared');
  check('two medicines with the same ingredient are said to share it',
    shared.map((f) => f.kind === 'shared' && [f.ingredient, f.meds.sort().join(' + '), f.written.join()]),
    [['acetaminophen', 'Cold tablet + Dolo 650', 'Paracetamol']]);

  const far = 'Filler sentence about nothing. '.repeat(80) + 'Fixture naming cholecalciferol late.';
  check('a name past the old 1,800-character cut is still found',
    matchLabels(items, new Map([['levothyroxine', label(far)]])).some((f) =>
      f.kind === 'label' && f.mentionsIngredient === 'cholecalciferol'), true);
  check('a label cached before the full text existed falls back to the clipped one',
    matchLabels(items, new Map([['levothyroxine', label(undefined, 'Fixture naming caffeine.')]])).some((f) =>
      f.kind === 'label' && f.mentions === 'Cold tablet'), true);
  check('an Indian strip\'s I.P. tag is dropped, salt name first',
    lookupNames('Chlorpheniramine Maleate I.P.'), ['Chlorpheniramine Maleate', 'Chlorpheniramine']);
  check('a typo in the salt still leaves the base to try',
    lookupNames('Dextromethorphan Hydobromide I.P.'), ['Dextromethorphan Hydobromide', 'Dextromethorphan']);
  check('B.P., USP and Ph. Eur. go the same way',
    [lookupNames('Ferrous Sulphate B.P.')[0], lookupNames('Guaifenesin USP')[0], lookupNames('Paracetamol Ph. Eur.')[0]],
    ['Ferrous Sulphate', 'Guaifenesin', 'Paracetamol']);
  check('a strength in brackets or after the name is dropped',
    [lookupNames('Ambroxol (30mg/5ml)'), lookupNames('Paracetamol 650 mg')], [['Ambroxol'], ['Paracetamol']]);
  check('a plain name is asked as it is', lookupNames('Guaifenesin'), ['Guaifenesin']);
  check('"IP" inside a word is not a tag', lookupNames('Ciprofloxacin')[0], 'Ciprofloxacin');
  check('nothing left means nothing to ask', lookupNames('(10mg) I.P.'), []);
  check('a found answer is kept', [worthKeeping([{ rxcui: '1', name: 'x' }]), worthKeeping({ productName: 'P' })],
    [true, true]);
  check('"not recognised" is never kept', worthKeeping([]), false);
  check('"no label" is never kept', worthKeeping(null), false);
  check('openFDA\'s 404 is "no match"', isNoMatch(404), true);
  check('a rate limit or an outage is not', [isNoMatch(429), isNoMatch(500), isNoMatch(503)], [false, false, false]);
  check('a medicine RxNorm did not recognise is still matched by how it was written',
    matchLabels([items[0], { med: { id: 'x', name: 'Brand X' }, substances: [{ written: 'Calcium carbonate', us: [] }] }],
      labels).some((f) => f.kind === 'label' && f.mentions === 'Brand X'), true);
}

section('Importing a medicine list: CSV in slices');
{
  const all = (text: string, size: number) => {
    const r = new CsvReader();
    const out: string[][] = [];
    for (let i = 0; i < text.length; i += size) out.push(...r.feed(text.slice(i, i + size)));
    out.push(...r.end());
    return out;
  };
  const q = '"';
  const csv = '﻿name,comp\r\n' +
    `${q}Dolo, 650${q},${q}Paracetamol (650mg)${q}\r\n` +
    `${q}Say ${q}${q}hi${q}${q}${q},x\n` +
    `${q}two\nlines${q},y\r` +
    'last,z';
  const whole = all(csv, csv.length);
  check('one pass reads every row', whole, [['name', 'comp'], ['Dolo, 650', 'Paracetamol (650mg)'],
    ['Say "hi"', 'x'], ['two\nlines', 'y'], ['last', 'z']]);
  for (const size of [1, 2, 3, 7]) {
    check(`and ${size}-character slices read exactly the same`, all(csv, size), whole);
  }
  check('a byte-order mark is not part of the first header', whole[0][0], 'name');
  check('blank lines are not rows', all('a,b\n\n\nc,d\n', 4), [['a', 'b'], ['c', 'd']]);
}

section('Importing a medicine list: compositions');
check('India: one ingredient per cell', parseComposition('Paracetamol (650mg)'),
  [{ name: 'Paracetamol', strength: '650mg' }]);
check('the last bracket is the strength', parseComposition('Progesterone (Natural Micronized) (25mg)'),
  [{ name: 'Progesterone (Natural Micronized)', strength: '25mg' }]);
check('even with no space before it', parseComposition('Thiamine(Vitamin B1) (100mg)'),
  [{ name: 'Thiamine(Vitamin B1)', strength: '100mg' }]);
check('one column with a plus', parseComposition('Amoxycillin (500mg) + Clavulanic Acid (125mg)'),
  [{ name: 'Amoxycillin', strength: '500mg' }, { name: 'Clavulanic Acid', strength: '125mg' }]);
check('HSA: && lists lined up with a strength column',
  parseComposition('ORPHENADRINE CITRATE&&PARACETAMOL', '25 mg&&500 mg'),
  [{ name: 'ORPHENADRINE CITRATE', strength: '25 mg' }, { name: 'PARACETAMOL', strength: '500 mg' }]);
check('a strength column that does not line up is not guessed at',
  parseComposition('A&&B', '5 mg'), [{ name: 'A', strength: null }, { name: 'B', strength: null }]);
check('an empty cell is no ingredients', parseComposition('   '), []);
check('a name with no strength keeps the name', parseComposition('Ambroxol'), [{ name: 'Ambroxol', strength: null }]);
check('pack text to the app\'s forms',
  ['strip of 10 tablets', 'TABLET, FILM COATED', 'bottle of 60 ml Syrup', 'SUSPENSION', 'Eye Drops',
   'packet of 5 gm Gel', 'sachet of 4 gm Powder', 'INJECTION', 'tube of 30 gm Cream', ''].map(formFromText),
  ['tablet', 'tablet', 'syrup', 'syrup', 'drops', 'drops', 'powder', null, null, null]);

section('Importing a medicine list: presets and rows');
{
  const az = ['name', 'Is_discontinued', 'manufacturer_name', 'type', 'pack_size_label', 'short_composition1', 'short_composition2'];
  const hsa = ['LicenceNo', 'Productname', 'Licenseholder', 'Approvaldate', 'Forensicclassification', 'ATCCode',
    'Dosageform', 'RouteofAdministration', 'Manufacturer', 'Countryofmanufacturer', 'Activeingredients', 'Strength'];
  check('the A-Z India file is recognised by its header', presetFor(az)?.id, 'az-india');
  check('so is HSA\'s', presetFor(hsa)?.id, 'hsa-singapore');
  check('a list sharing only a "name" column is not', presetFor(['name', 'price']), null);

  const skips = emptySkips();
  const seen = new Set<string>();
  const rows = [
    ['Dolo 650 Tablet', 'FALSE', 'Micro Labs', 'allopathy', 'strip of 15 tablets', 'Paracetamol (650mg)', ''],
    ['Allegra-M Tablet', 'FALSE', 'Sanofi', 'allopathy', 'strip of 10 tablets', 'Montelukast (10mg) ', ' Fexofenadine (120mg)'],
    ['Gone Tablet', 'TRUE', 'X', 'allopathy', 'strip of 10 tablets', 'Something (1mg)', ''],
    ['', 'FALSE', 'X', 'allopathy', '', 'Paracetamol (500mg)', ''],
    ['No Comp', 'FALSE', 'X', 'allopathy', '', '', ''],
  ];
  const first = rowsToItems(az, rows.slice(0, 3), presetFor(az)!.mapping, skips, seen);
  const second = rowsToItems(az, [rows[0], ...rows.slice(3)], presetFor(az)!.mapping, skips, seen);
  check('a row becomes a medicine with its ingredients and form', first[0],
    { name: 'Dolo 650 Tablet', name_norm: 'dolo 650 tablet', ingredients: [{ name: 'Paracetamol', strength: '650mg' }],
      form: 'tablet', discontinued: false });
  check('two composition columns read left to right', first[1].ingredients.map((i) => i.name), ['Montelukast', 'Fexofenadine']);
  check('every row left out is counted, with why', [first.length + second.length, skips],
    [2, { 'no name': 1, 'no ingredients': 1, discontinued: 1, duplicate: 1 }]);
}

section('Importing a medicine list: Excel');
{
  // A real .xlsx, built in memory: the zip and XML parts Excel writes for a
  // two-row table, with a shared string in two rich-text runs, an inline
  // string, a number, a skipped (empty) cell and an escaped ampersand.
  const enc = (t: string) => strToU8(t);
  const bytes = zipSync({
    'xl/workbook.xml': enc('<workbook><sheets><sheet name="Meds" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': enc('<sst><si><t>name</t></si><si><t>comp</t></si><si><r><t>Cold </t></r><r><t>&amp; Flu</t></r></si></sst>'),
    'xl/worksheets/sheet1.xml': enc('<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>Paracetamol (500mg)</t></is></c><c r="D2"><v>15</v></c></row>'
      + '</sheetData></worksheet>'),
  });
  check('the first sheet reads as rows of text', readXlsx(bytes),
    [['name', 'comp'], ['Cold & Flu', '', 'Paracetamol (500mg)', '15']]);
  check('column letters count past Z', [columnIndex('A1'), columnIndex('Z9'), columnIndex('AA3'), columnIndex('AZ1')], [0, 25, 26, 51]);
  let refused = '';
  try { readXlsx(enc('not a zip at all')); } catch (e) { refused = (e as Error).message; }
  check('an old .xls or anything else is refused in words', refused.includes('.xlsx'), true);
}

section('The banner: one medicines card');
{
  const g = (o: Partial<MedsGlance>): MedsGlance =>
    ({ due: 0, later: 0, done: 0, dueNames: [], sick: null, ...o });
  check('nothing to take, no card', medsCard(g({})), null);
  check('one due, named', medsCard(g({ due: 1, later: 1, dueNames: ['Thyronorm'] }))?.text, 'Thyronorm is due now.');
  check('two due, both named', medsCard(g({ due: 2, dueNames: ['Thyronorm', 'Calcium + D3'] }))?.text,
    '2 doses due now: Thyronorm and Calcium + D3.');
  check('more than two, the rest counted', medsCard(g({ due: 4, dueNames: ['A', 'B', 'C', 'D'] }))?.text,
    '4 doses due now: A, B and 2 more.');
  check('all answered, skipped included', medsCard(g({ done: 3 }))?.text, 'Every dose today is ticked off.');
  check('only later doses left', medsCard(g({ done: 2, later: 1 }))?.text, 'Nothing due right now — one more later today.');
  check('a running sickness comes first', medsCard(g({ due: 1, dueNames: ['Cough syrup'], sick: { name: 'Viral fever', day: 3, of: 7 } }))?.text,
    'Viral fever, day 3 of 7. Cough syrup is due now.');
  const card = medsCard(g({ due: 1, dueNames: ['Thyronorm'] }))!;
  check('it is Dawa speaking, in violet', [card.who, card.hue], ['Dawa', 'violet']);
  check('it never states an amount', [card, medsCard(g({ done: 1 }))!].every((c) => !/\d\s*(mg|mcg|ml|g|tablet)/i.test(c.text)), true);
  const base = { now: new Date(2026, 9, 6, 9).getTime(), totals: [0, 0, 0, 0, 0] as Macros, itemCount: 0,
    targets: { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null } as never, lookingBack: false };
  check('it joins the deck even when the food card is the only one', deck({ ...base, meds: g({ done: 1 }) }).map((c) => c.situation),
    ['no-targets', 'meds']);
  check('and the deck without medicines is as it was', deck(base).map((c) => c.situation), ['no-targets']);

  // The labels people read. A job title over a line a function wrote claims
  // an authority the app does not have; these were renamed in Oct 2026.
  const fed = { ...base, totals: [900, 30, 20, 120, 10] as Macros, itemCount: 3,
    targets: { energy_kcal: 1900, protein_g: 90, fat_g: 60, carbs_g: 230, fibre_g: 30 } as never };
  const labels = [
    ...deck({ ...fed, meds: g({ due: 1, dueNames: ['Thyronorm'] }) }),
    ...deck({ ...fed, totals: [2600, 95, 90, 300, 31] as Macros }),
    ...deck({ ...base, targets: fed.targets }),
    ...deck(base),
  ].map((c) => c.who);
  check('food cards are Thali\'s', labels.includes('Thali'), true);
  check('no card carries a job title', labels.filter((w) => /doctor|nutritionist|pharmacist/i.test(w)), []);
}

section('Medicines: how often');
{
  const sun = scheduleOf('weekdays', '0', null);
  check('weekly on Sunday is due on a Sunday', dueOn(sun, '2026-10-04'), true);
  check('and not on the Monday', dueOn(sun, '2026-10-05'), false);
  check('Sunday is 0, the way Date counts', sun.days, [0]);
  check('it reads as a sentence', describeSchedule(sun), 'Every Sunday');
  check('two days read as a list', describeSchedule(scheduleOf('weekdays', '3,0', null)), 'Sun, Wed');
  const alt = scheduleOf('alternate', null, '2026-10-04');
  check('alternate days are due on the start', dueOn(alt, '2026-10-04'), true);
  check('not the day after', dueOn(alt, '2026-10-05'), false);
  check('and the day after that', dueOn(alt, '2026-10-06'), true);
  check('counted from the start, not shifted by a gap', dueOn(alt, '2026-11-01'), daysFrom('2026-10-04', '2026-11-01') % 2 === 0);
  check('nothing before it began', dueOn(alt, '2026-10-02'), false);
  const m31 = scheduleOf('monthly', '31', null);
  check('monthly on the 31st is due on the 31st', dueOn(m31, '2026-10-31'), true);
  check('and on the 30th of a 30-day month', dueOn(m31, '2026-11-30'), true);
  check('and the 28th of a short February', dueOn(m31, '2026-02-28'), true);
  check('but not the 30th of a 31-day month', dueOn(m31, '2026-10-30'), false);
  check('it reads as a sentence', describeSchedule(scheduleOf('monthly', '15', null)), 'Monthly, on the 15th');
  check('next Sunday from a Tuesday', nextDue(sun, '2026-10-06'), '2026-10-11');
  check('unreadable columns mean every day', scheduleOf('weekdays', 'x', null), EVERY_DAY);
  check('nothing stored means every day', scheduleOf(null, null, null), EVERY_DAY);
  check('round trip through the columns', scheduleColumns(scheduleOf('weekdays', '0,3', null)),
    { freq: 'weekdays', freq_days: '0,3', freq_from: null });
  check('an alternate rhythm keeps its anchor', scheduleColumns(alt).freq_from, '2026-10-04');
}

section('Medicines: the schedule a day had');
{
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
  const noon = (d: number) => new Date(2026, 9, d, 12, 0);
  const med = { id: 'vitd', name: 'Vitamin D3', dose_text: null, schedule: null, long_term: 1,
    episode_id: null, started_on: day(1), ended_on: null };
  // Daily from the 1st; on the 8th it was changed to Sundays only.
  const daily = { id: 'old', medication_id: 'vitd', position: 1, amount: 1, unit: 'tablet' as const,
    time_of_day: 'morning' as const, meal: 'after' as const, freq: 'daily', from_day: day(1),
    deleted_at: noon(8).getTime() };
  const weekly = { ...daily, id: 'new', freq: 'weekdays', freq_days: '0', from_day: day(8),
    deleted_at: null };
  const due = (d: number) => planDay(day(d), [med], [daily, weekly], [], [], noon(20))
    .groups.flatMap((g) => g.doses).map((p) => p.dose.id);
  check('before the change, the daily row', due(7), ['old']);
  check('from the change, the new row, on its day only', [due(8), due(11)], [[], ['new']]);
  check('a Monday under the new schedule has nothing', due(12), []);
  check('nothing before it started', planDay('2026-09-30', [med], [daily], [], [], noon(20)).groups, []);
  check('nothing from the day it stopped',
    planDay(day(9), [{ ...med, ended_on: day(9) }], [daily, weekly], [], [], noon(20)).groups.length, 0);

  // A tick made against the old row the morning it was replaced still counts.
  const tick = { id: 't', dose_id: 'old', status: 'taken' as const, updated_at: 1,
    taken_at: new Date(2026, 9, 11, 8).getTime(), medication_id: 'vitd', time_of_day: 'morning' as const };
  const kept = planDay(day(11), [med], [daily, weekly], [], [tick], noon(11)).groups[0].doses[0];
  check('a tick survives its dose row being replaced the same day', [kept.dose.id, kept.state], ['new', 'taken']);
  check('on time is not late', kept.late, false);
  const lateTick = { ...tick, taken_at: new Date(2026, 9, 13, 9).getTime() };
  check('ticked two days on is marked late',
    planDay(day(11), [med], [daily, weekly], [], [lateTick], noon(20)).groups[0].doses[0].late, true);
  const halfPast = { ...tick, taken_at: new Date(2026, 9, 12, 0, 30).getTime() };
  check('but half past midnight still belongs to the night before',
    planDay(day(11), [med], [daily, weekly], [], [halfPast], noon(20)).groups[0].doses[0].late, false);

  // Two doses of one medicine in one part of the day. Matching every tick by
  // medicine and time gave the second the first's tick: ticking "before
  // breakfast" showed "after breakfast" taken too, and changing the second
  // deleted the first's tick (15 Oct 2026).
  const iron = { ...med, id: 'iron', name: 'Iron' };
  const before = { ...daily, id: 'ib', medication_id: 'iron', position: 1, meal: 'before' as const, deleted_at: null };
  const after = { ...before, id: 'ia', position: 2, meal: 'after' as const };
  const firstOnly = { ...tick, id: 't1', dose_id: 'ib', medication_id: 'iron', meal: 'before' };
  const both = planDay(day(11), [iron], [before, after], [], [firstOnly], noon(11)).groups[0].doses;
  check('ticking one of two morning doses answers that one only',
    both.map((p) => [p.dose.id, p.state, p.eventId]), [['ib', 'taken', 't1'], ['ia', 'due', null]]);
  // Edited the same morning: both old rows replaced by new ones at the same
  // times. Each orphaned tick goes to the new dose with the same meal.
  const oldB = { ...before, id: 'ob', deleted_at: noon(11).getTime() - 3_600_000 };
  const oldA = { ...after, id: 'oa', deleted_at: noon(11).getTime() - 3_600_000 };
  const newB = { ...before, id: 'nb', from_day: day(11) };
  const newA = { ...after, id: 'na', from_day: day(11) };
  const orphan = { ...firstOnly, dose_id: 'ob' };
  const edited = planDay(day(11), [iron], [oldB, oldA, newB, newA], [], [orphan], noon(11)).groups[0].doses;
  check('after a same-day edit, the orphaned tick finds its own dose by meal',
    edited.map((p) => [p.dose.id, p.state]), [['nb', 'taken'], ['na', 'due']]);
  const vague = { ...orphan, meal: null };
  check('an orphan that cannot tell two doses apart answers neither',
    planDay(day(11), [iron], [oldB, oldA, newB, newA], [], [vague], noon(11)).groups[0].doses.map((p) => p.state), ['due', 'due']);

  // The log over the fortnight, from the same planDay.
  const log = buildLog(daysBetweenInclusive(day(1), day(14)), [med], [daily, weekly], [],
    [{ ...tick, for_day: day(11) }, { ...tick, id: 'u', dose_id: 'old', status: 'skipped' as const,
      time_of_day: 'morning' as const, for_day: day(3) }], noon(14));
  check('the log counts what was due: 7 daily, then Sunday the 11th',
    log.total.taken + log.total.skipped + log.total.missed + log.total.pending, 8);
  check('one taken, one skipped, the rest missed',
    [log.total.taken, log.total.skipped, log.total.missed], [1, 1, 6]);
  check('a day nothing was due is blank in the row', log.meds[0].days.find((x) => x.day === day(9))?.state, null);
  check('and the skipped day says so', log.meds[0].days.find((x) => x.day === day(3))?.state, 'skipped');
  check('a day with two doses answered differently is partial',
    buildLog([day(5)], [med], [daily, { ...daily, id: 'n2', time_of_day: 'night' as const }], [],
      [{ ...tick, dose_id: 'old', for_day: day(5) }], noon(14)).meds[0].days[0].state, 'partial');
}

// ------------------------------------------------------------- dish edit

section('Edit dish: what past entries become');
{
  // The potato from 8 Oct, corrected: 1 piece was 100 g at 150 Cal/100g,
  // and is really 75 g at 86.67. Sample numbers, not his.
  const edit: DishEdit = {
    name: 'Boiled potato (small)',
    per100: { energy_kcal: 86.67, protein_g: 2, fat_g: 0.13, carbs_g: 20, fibre_g: 1.73 },
    portion: { measure: 'piece', quantity: 1, netWeightG: 75 },
    others: [
      { id: 'k', measure: 'katori', quantity: 1, netWeightG: 110 },
      { id: 'b', measure: 'bowl', quantity: 1, netWeightG: null },
      // The form's own measure is never an "other"; if one slipped in, the
      // form's weight must still win.
      { id: 'p', measure: 'piece', quantity: 1, netWeightG: 999 },
    ],
  };
  const anchors = anchorsAfter(edit);
  check('the form\'s portion is the default anchor',
    anchors.filter((a) => a.is_default).map((a) => [a.measure, a.net_weight_g]), [['piece', 75]]);
  check('a removed portion is not an anchor', anchors.some((a) => a.measure === 'bowl'), false);
  check('and the form\'s measure appears once', anchors.filter((a) => a.measure === 'piece').length, 1);

  const piece = recalcEntry({ quantity: 1, unit: 'piece' }, edit.per100, anchors);
  near('1 piece logged at the old 100 g becomes 75 g', piece.net_weight_g, 75, 0.01);
  near('and 65 Cal', piece.energy_kcal ?? 0, 65, 0.06);
  const two = recalcEntry({ quantity: 2, unit: 'piece' }, edit.per100, anchors);
  near('the quantity logged is kept: 2 pieces is 150 g', two.net_weight_g, 150, 0.01);
  const weighed = recalcEntry({ quantity: 120, unit: 'g' }, edit.per100, anchors);
  near('a weighed entry keeps its grams', weighed.net_weight_g, 120, 0.01);
  near('and only its calories change', weighed.energy_kcal ?? 0, 104, 0.06);
  const bare = recalcEntry({ quantity: 1, unit: null }, edit.per100, anchors);
  near('an entry with no measure takes the default portion', bare.net_weight_g, 75, 0.01);

  // A weight is not an anchor: "100 g weighs 100 g" says nothing about a katori.
  check('a weight in the form makes no anchor',
    anchorsAfter({ ...edit, portion: { measure: 'g', quantity: 100, netWeightG: 100 }, others: [] }), []);

  const entries = [
    { id: 'a', quantity: 1, unit: 'piece', net_weight_g: 100, energy_kcal: 150, eaten_at: 1 },
    { id: 'b', quantity: 1, unit: 'piece', net_weight_g: 100, energy_kcal: 150, eaten_at: 5 },
  ];
  check('the sheet\'s numbers: count, span, now and after',
    previewEntries(entries, edit), { count: 2, from: 1, to: 5, kcalNow: 300, kcalNew: 130 });
}

section('Meals planned ahead: when a meal is a plan');
{
  // Friday 9 Oct 2026, local time — the clock the rules are judged against.
  const at = (h: number, m = 0) => new Date(2026, 9, 9, h, m);
  const day = (d: number) => new Date(2026, 9, d).getTime();
  const lunchtime = at(13);

  check('dinner added at lunchtime is planned', plansAt(day(9), 'dinner', lunchtime), true);
  check('lunch added at lunchtime is logged', plansAt(day(9), 'lunch', lunchtime), false);
  check('breakfast added at lunchtime is logged', plansAt(day(9), 'breakfast', lunchtime), false);
  check('evening snack at 1 pm is planned', plansAt(day(9), 'esnack', lunchtime), true);
  // The boundary is the slot's start hour, the same one guessSlot uses.
  check('dinner at 6:59 pm is still planned', plansAt(day(9), 'dinner', at(18, 59)), true);
  check('dinner at 7:00 pm is logged', plansAt(day(9), 'dinner', at(19, 0)), false);
  check('lunch at 11:30 am is planned', plansAt(day(9), 'lunch', at(11, 30)), true);
  // His decision: "Something else" has no time, so it is never ahead today.
  check('"Something else" is never planned today', plansAt(day(9), 'other', at(8)), false);
  check('but it is on a later day', plansAt(day(10), 'other', at(8)), true);
  check('anything tomorrow is planned, breakfast too', plansAt(day(10), 'breakfast', at(23, 30)), true);
  check('anything on a past day is logged', plansAt(day(8), 'dinner', at(0, 5)), false);
  // Planning the morning after midnight: breakfast starts at hour 0, so
  // without the night every breakfast added at 01:30 saved as eaten.
  check('breakfast added at 01:30 is planned', plansAt(day(9), 'breakfast', at(1, 30)), true);
  check('breakfast added at 04:59 is planned', plansAt(day(9), 'breakfast', at(4, 59)), true);
  check('breakfast added at 05:00 is logged', plansAt(day(9), 'breakfast', at(5, 0)), false);
  check('lunch added at 01:30 is planned', plansAt(day(9), 'lunch', at(1, 30)), true);
  check('"Something else" at 01:30 is still logged', plansAt(day(9), 'other', at(1, 30)), false);

  // When a ticked plan was eaten (his rule, 15 Oct 2026).
  check('ticked on its day: now', tickStamp(day(9), 'dinner', at(20, 40)), at(20, 40).getTime());
  check('ticked a day late: its slot\'s usual hour', tickStamp(day(8), 'dinner', at(9, 15)), new Date(2026, 9, 8, 20).getTime());
  check('breakfast\'s usual hour is 8', tickStamp(day(8), 'breakfast', at(9, 15)), new Date(2026, 9, 8, 8).getTime());
  check('"Something else" has none, and keeps its time', tickStamp(day(8), 'other', at(9, 15)), null);
  check('nothing for a day not yet come', tickStamp(day(10), 'lunch', at(9, 15)), null);
  check('every usual hour sits in the window the clock guesses for its slot',
    Object.entries(USUAL_HOUR).every(([id, h]) => guessSlot(new Date(2026, 9, 9, h!)) === id), true);
  check('7 days ahead is the last plannable day', lastPlannableDay(lunchtime), day(16));
  check('tomorrow is 1 day away', daysFromToday(day(10), lunchtime), 1);
  check('yesterday is -1', daysFromToday(day(8), lunchtime), -1);
  // 25 Oct has 25 hours in Europe and the US; an exact division would floor
  // the day after to the wrong count wherever the clocks change.
  check('a day count survives a clock change',
    daysFromToday(new Date(2026, 9, 27).getTime(), new Date(2026, 9, 24, 22)), 3);

  check('labels: today, tomorrow, in N days, past',
    [9, 10, 13, 8].map((d) => dayLabel(day(d), lunchtime)), ['Today', 'Tomorrow', 'In 4 days', '']);
}

section('Meals planned ahead: ticks and totals');
{
  const now = new Date(2026, 9, 9, 13, 0);
  const day = (d: number) => new Date(2026, 9, d).getTime();

  check('the circle goes planned → eaten → skipped → planned',
    [nextPlanState('planned'), nextPlanState('eaten'), nextPlanState('skipped')],
    ['eaten', 'skipped', 'planned']);
  check('a meal logged as eaten has no circle to turn', nextPlanState(null), null);

  check('logged and ticked count; planned and skipped do not',
    [counts(null), counts('eaten'), counts('planned'), counts('skipped')],
    [true, true, false, false]);

  check('no circle on a meal logged as eaten', circleOf(null, day(9), now), null);
  check('a plan today is a ring', circleOf('planned', day(9), now), 'planned');
  check('a plan tomorrow cannot be ticked yet', circleOf('planned', day(10), now), 'ahead');
  check('a plan whose day is over is unticked', circleOf('planned', day(8), now), 'unticked');
  check('ticked and skipped draw as themselves on any day',
    [circleOf('eaten', day(8), now), circleOf('skipped', day(9), now)], ['eaten', 'skipped']);
  check('ticking is allowed today and before, not after',
    [canTick(day(8), now), canTick(day(9), now), canTick(day(10), now)], [true, true, false]);
}

section('Ask Mealo: which lines carry the AI tag');
{
  const chest = 'I have chest pain since an hour';
  const flagged = triage(chest);
  const stopText = flagged.triggered ? flagged.message : '';
  check('the fixture really is a red flag', flagged.triggered, true);
  const row = (role: string, content: string, created_at = 1) => ({ role, content, created_at });

  const thread = entriesFrom([
    row('user', 'how has my week looked?', 10),
    row('assistant', 'You logged six days.', 11),
    row('user', chest, 20),
    row('assistant', stopText, 21),
  ]);
  check('a question, an answer, a question, a stop', thread.map((e) => e.kind), ['asked', 'answer', 'asked', 'stop']);
  check('each keeps its words and its time', [thread[1].text, thread[1].at, thread[3].text], ['You logged six days.', 11, stopText]);
  check('a model answer after an ordinary question is AI',
    entriesFrom([row('user', 'hello'), row('assistant', stopText)])[1].kind, 'answer');
  // A pattern added later must not relabel what a model said back then.
  check('a model answer after a red-flag question, in other words, stays AI',
    entriesFrom([row('user', chest), row('assistant', 'Please see someone about that.')])[1].kind, 'answer');
  check('a stop with no question before it is not taken on trust',
    entriesFrom([row('assistant', stopText)])[0].kind, 'answer');
  check('system and tool rows are not shown',
    entriesFrom([row('system', 'x'), row('tool', 'y'), row('user', 'z')]).map((e) => e.kind), ['asked']);
  check('an empty thread is empty', entriesFrom([]), []);

  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const now = at(10, 15, 0);
  check('today, afternoon', entryTime(at(10, 14, 14), now), 'Today \u00b7 2:14 pm');
  check('today, morning, minutes padded', entryTime(at(10, 9, 5), now), 'Today \u00b7 9:05 am');
  check('midnight is 12 am, noon is 12 pm', [entryTime(at(10, 0, 0), now), entryTime(at(10, 12, 0), now)],
    ['Today \u00b7 12:00 am', 'Today \u00b7 12:00 pm']);
  check('late last night is yesterday, however few hours ago', entryTime(at(9, 23, 50), at(10, 0, 10)), 'Yesterday \u00b7 11:50 pm');
  check('older than that carries its date', entryTime(at(8, 14, 14), now), '8 Oct \u00b7 2:14 pm');
  check('across a month end', entryTime(new Date(2026, 8, 30, 8, 0).getTime(), now), '30 Sep \u00b7 8:00 am');

  check('three questions are offered', TRY_ASKING.length, 3);
  check('none of them is itself a red flag', TRY_ASKING.map((q) => triage(q).triggered), [false, false, false]);
}

section('Ask Mealo: the pills');
{
  const dish = (kcal: number | null, known = true) => ({ food: known ? {} : null, energy_kcal: kcal });
  const all = mealSummary([dish(156), dish(98)]);
  check('every dish known: one plain button, no hint', [all.action, all.hint, all.kcal], ['Log meal', null, 254]);
  const part = mealSummary([dish(156), dish(98), dish(null, false)]);
  check('an unknown dish is left out of the total and the button says how many', [part.known, part.unknown, part.kcal, part.action],
    [2, 1, 254, 'Log 2 dishes']);
  check('and the card says it will not be logged', part.hint, 'One dish is not in your food table and will not be logged.');
  check('two unknown', mealSummary([dish(100), dish(null, false), dish(null, false)]).hint,
    '2 dishes are not in your food table and will not be logged.');
  check('one known dish is singular', mealSummary([dish(100), dish(null, false)]).action, 'Log 1 dish');
  const none = mealSummary([dish(null, false)]);
  check('nothing known: no button at all', [none.action, none.kcal], [null, 0]);
  check('nothing typed that reads as a dish: no button', mealSummary([]).action, null);
  // A matched dish with unknown calories must not throw the sum off or count as unknown.
  check('a known dish without calories counts as a dish, as zero', [mealSummary([dish(null), dish(98)]).known, mealSummary([dish(null), dish(98)]).kcal], [2, 98]);
  check('a card never claims calories for what it could not place', mealSummary([dish(500, false)]).kcal, 0);
  check('the meal receipt', mealReceipt('Breakfast', 2, 1254), 'Logged to breakfast \u00b7 2 dishes \u00b7 1,254 Cal');
  check('one dish', mealReceipt('Evening snack', 1, 98), 'Logged to evening snack \u00b7 1 dish \u00b7 98 Cal');

  check('the circle turns empty, taken, skipped, empty', [nextMark(null), nextMark('taken'), nextMark('skipped')], ['taken', 'skipped', null]);
  check('nothing ticked: nothing to save', dosesAction([null, null]), null);
  check('ticks only', [dosesAction(['taken', null, 'taken']), dosesReceipt(['taken', null, 'taken'])], ['Tick 2 doses', '2 doses ticked']);
  check('one tick is singular', [dosesAction(['taken']), dosesReceipt(['taken'])], ['Tick 1 dose', '1 dose ticked']);
  check('a skip changes the verb, and is never called ticked', [dosesAction(['taken', 'skipped']), dosesReceipt(['taken', 'skipped'])],
    ['Save 2 doses', '1 taken, 1 skipped']);
  check('skips only', dosesReceipt(['skipped', null]), '1 dose marked skipped');

  check('the clock alone', [clock(new Date(2026, 9, 10, 14, 5).getTime()), clock(new Date(2026, 9, 10, 0, 30).getTime())], ['2:05 pm', '12:30 am']);
  check('three pills, each with a name and a question', Object.values(PILLS).every((p) => p.label && p.asks), true);
}

section('The "For AI" file');
{
  const xat = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const item = (name: string, quantity: number | null, unit: string | null, grams: number, kcal: number,
    p = 0, f = 0, c = 0, fi = 0, plan_state: ExportItem['plan_state'] = null): ExportItem =>
    ({ name, quantity, unit, grams, energy_kcal: kcal, protein_g: p, fat_g: f, carbs_g: c, fibre_g: fi, plan_state });
  const FIX: ExportInput = {
    scope: 'full',
    days: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'],
    targets: { energy_kcal: 1900, protein_g: 90, fat_g: 60, carbs_g: 230, fibre_g: 30 },
    goalWeightKg: 70,
    goalBurnKcal: 400,
    meals: [
      { day: '2026-10-04', at: xat(4, 13, 15), slot: 'Lunch', items: [item('Dal tadka', 225, 'g', 225, 236, 12, 8, 29, 7)] },
      { day: '2026-10-04', at: xat(4, 8, 40), slot: 'Breakfast', items: [
        item('Idli', 2, 'piece', 120, 156, 5, 1, 32, 2), item('Sambar', 1, 'katori', 150, 98, 5, 3, 14, 4)] },
      { day: '2026-10-04', at: xat(4, 20, 0), slot: 'Dinner', items: [item('Paneer curry', 1, 'bowl', 300, 500, 20, 35, 12, 3, 'planned')] },
      { day: '2026-10-05', at: xat(5, 13, 0), slot: 'Lunch', items: [item('Thali', 1, 'plate', 100, 1900, 60, 62, 240, 20)] },
    ],
    weights: [{ day: '2026-10-04', kg: 72.4 }, { day: '2026-10-09', kg: 71.95 }],
    burns: [{ day: '2026-10-04', kcal: 310 }],
    medicines: [
      { name: 'Calcium + D3', strength: '1250 mg', ingredients: ['Calcium carbonate 1250 mg', 'Cholecalciferol 250 IU'],
        doses: ['1 tablet, after meal (morning)', '1 tablet, after meal (night)'], schedule: 'Every day', longTerm: true,
        startedOn: '2026-08-01', endedOn: null, sickness: null },
      { name: 'Cough syrup', strength: null, ingredients: [], doses: ['10 ml, after meal (night)'], schedule: 'Every day',
        longTerm: false, startedOn: '2026-10-03', endedOn: '2026-10-06', sickness: 'Viral fever' },
    ],
    doseDays: [
      { day: '2026-10-04', taken: 2, skipped: 0, missed: 0, pending: 0 },
      { day: '2026-10-05', taken: 1, skipped: 1, missed: 0, pending: 0 },
      { day: '2026-10-06', taken: 1, skipped: 0, missed: 1, pending: 0 },
      { day: '2026-10-07', taken: 0, skipped: 0, missed: 0, pending: 0 },
      { day: '2026-10-10', taken: 1, skipped: 0, missed: 0, pending: 1 },
    ],
    notTaken: [
      { day: '2026-10-05', medicine: 'Calcium + D3 1250 mg', time: 'Night', state: 'skipped' },
      { day: '2026-10-06', medicine: 'Calcium + D3 1250 mg', time: 'Night', state: 'missed' },
    ],
    symptoms: [
      { at: xat(9, 18, 30), text: 'Bloating after dinner', resolvedAt: xat(10, 9, 0) },
      { at: xat(5, 9, 0), text: 'Headache since morning, behind the eyes', resolvedAt: null },
    ],
    episodes: [{ name: 'Viral fever', from: '2026-10-03', to: '2026-10-06', recoveredOn: '2026-10-06' }],
  };

  const full = buildExport(FIX);
  const mealsOnly = buildExport({ ...FIX, scope: 'meals' });
  const medsOnly = buildExport({ ...FIX, scope: 'meds' });
  const has = (text: string, part: string) => text.includes(part);

  check('the title carries the period and its length', full.split('\n')[0],
    '# Health records export: 4 Oct 2026 to 10 Oct 2026 (7 days)');
  check('it says no AI wrote it and the name is left out', [has(full, 'No part of it was written by an AI'), has(full, 'name is left out')], [true, true]);
  check('a day with nothing logged is called missing data', has(full, 'MISSING DATA, not a day without food'), true);
  check('and what the app does not record is said, so it is not assumed', has(full, 'Age, sex, height'), true);

  // The arithmetic the reader must not be left to do.
  check('a day\'s total leaves out a planned meal: 156 + 98 + 236, not + 500', has(full, '| Sun 4 Oct | 490 | 22 | 12 | 75 | 13 | 72.4 | 310 | 2 | 2 | 0 | 0 |'), true);
  check('an empty day is "not logged", never zero', has(full, '| Tue 6 Oct | not logged |'), true);
  check('no day row shows a zero-calorie day', /\| \w{3} \d+ Oct \| 0 \|/.test(full), false);
  check('days logged counts days with something eaten', has(full, 'Meals logged on 2 of 7 days.'), true);
  check('the average is over logged days only: (490 + 1,900) / 2', has(full, 'Average on logged days: 1,195 Cal, protein 41 g'), true);
  check('days within target use the app\'s own rule and say so', has(full, 'Days within the calorie target: 1 of 2 logged. "Within" is the app\'s own rule: 76% to 100% of the target.'), true);
  check('doses add up, with today\'s unanswered one not called missed',
    has(full, 'Doses: 5 taken of 8 scheduled; 1 skipped, 1 missed, 1 still to be answered today.'), true);
  check('today\'s row counts the pending dose as scheduled, not missed', has(full, '| Sat 10 Oct | not logged |  |  |  |  |  |  | 1 | 2 | 0 | 0 |'), true);
  check('a day with no doses scheduled is left blank, not 0 of 0', has(full, '| Wed 7 Oct | not logged |  |  |  |  |  |  |  |  |  |  |'), true);
  check('weight is first and last reading, to one decimal', has(full, 'Weight: 72.4 kg on Sun 4 Oct, 72.0 kg on Fri 9 Oct (2 readings).'), true);

  check('a household measure is given with its weight, as an estimate',
    has(full, 'Idli, 2 \u00d7 piece, 120 g, 156 Cal (P 5, F 1, C 32, Fi 2)'), true);
  check('only an amount logged in grams is called weighed', [has(full, 'Dal tadka, 225 g (weighed), 236 Cal'), (full.match(/\(weighed\)/g) ?? []).length], [true, 2]);
  check('a planned meal is shown as planned', has(full, 'Paneer curry, 1 \u00d7 bowl (350 ml), 300 g, 500 Cal (P 20, F 35, C 12, Fi 3) [planned, not eaten]'), true);
  check('meals within a day are in time order', full.indexOf('- Breakfast 8:40 am') < full.indexOf('- Lunch 1:15 pm'), true);
  check('empty days are not given a heading each', has(full, '### Tue 6 Oct'), false);

  check('a medicine carries doses, schedule, start and what it contains',
    has(full, '- Calcium + D3 1250 mg. Doses: 1 tablet, after meal (morning); 1 tablet, after meal (night). Every day. Long-term. Started 1 Aug 2026. Contains: Calcium carbonate 1250 mg; Cholecalciferol 250 IU.'), true);
  check('a medicine stopped in the period says so, and what it was for',
    has(full, '- Cough syrup. Doses: 10 ml, after meal (night). Every day. Taken for: Viral fever. Started 3 Oct 2026. STOPPED 6 Oct 2026.'), true);
  check('each dose not taken is listed by day, medicine and time',
    [has(full, '- Mon 5 Oct: Calcium + D3 1250 mg, night, skipped'), has(full, '- Tue 6 Oct: Calcium + D3 1250 mg, night, missed')], [true, true]);
  check('symptoms are quoted, in time order, open or resolved',
    full.slice(full.indexOf('## Symptoms')).trim().split('\n').slice(2),
    ['- Mon 5 Oct, 9:00 am: "Headache since morning, behind the eyes". Still open.',
      '- Fri 9 Oct, 6:30 pm: "Bloating after dinner". Resolved Sat 10 Oct.']);

  const heads = (t: string) => t.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).replace(/ \(.*/, ''));
  check('a full file has every section', heads(full),
    ['How to read this', 'What the app does not record', 'Period summary', 'Daily targets', 'Medicines', 'Day by day', 'Meals', 'Doses not taken', 'Sick periods', 'Symptoms']);
  check('a meals file has no medicines, doses, sickness or symptoms', heads(mealsOnly),
    ['How to read this', 'What the app does not record', 'Period summary', 'Daily targets', 'Day by day', 'Meals']);
  check('nor a word about them', /Calcium|dose|Headache|Viral|kg/i.test(mealsOnly), false);
  check('a meds file has no food, targets, weight or symptoms', heads(medsOnly),
    ['How to read this', 'What the app does not record', 'Period summary', 'Medicines', 'Day by day', 'Doses not taken', 'Sick periods']);
  check('nor a word about them', /Idli|Cal\b|Protein|Headache|72\.4|MISSING DATA/.test(medsOnly), false);
  check('each scope names itself', [mealsOnly.startsWith('# Meals export: '), medsOnly.startsWith('# Medicines export: ')], [true, true]);

  const bare = buildExport({ ...FIX, meals: [], weights: [], burns: [], medicines: [], doseDays: [], notTaken: [], symptoms: [], episodes: [],
    targets: { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null }, goalWeightKg: null, goalBurnKcal: null });
  check('an empty record still makes a file that says what is empty',
    ['Meals logged on 0 of 7 days.', 'No doses were scheduled in this period.', 'Weight: not recorded in this period.', 'None set.', 'None recorded.', 'None logged in this period.']
      .every((line) => has(bare, line)), true);
  check('no file, full or empty, ever prints a missing value as one',
    [full, mealsOnly, medsOnly, bare].some((t) => /undefined|NaN|null|\[object/.test(t)), false);
  check('it ends with one newline', [full.endsWith('.\n'), full.endsWith('\n\n')], [true, false]);

  check('the file is named for its scope and dates', fileName('full', FIX.days), 'mealo-full-2026-10-04-to-2026-10-10.md');
  check('seven days ending today', periodDays(7, '2026-10-10'), FIX.days);
  check('one day is today alone', periodDays(1, '2026-10-10'), ['2026-10-10']);
  check('the period is held to 1 to 90 days', [periodDays(0, '2026-10-10').length, periodDays(500, '2026-10-10').length, MAX_DAYS], [1, 90, 90]);
  check('ninety days back from 10 Oct starts on 13 Jul, across month ends', periodDays(90, '2026-10-10')[0], '2026-07-13');
  check('a day is named with its weekday', dateLabel('2026-10-04'), 'Sun 4 Oct');
  check('the sheet\'s dates', [periodLabel(periodDays(21, '2026-10-10')), periodLabel(periodDays(1, '2026-10-10')), periodLabel(periodDays(30, '2026-01-10'))],
    ['20 Sep \u2013 10 Oct 2026', '10 Oct 2026', '12 Dec 2025 \u2013 10 Jan 2026']);
  check('what each file holds', [scopeHolds('meals'), scopeHolds('meds'), scopeHolds('full')],
    ['Meals and targets', 'Medicines and doses', 'Meals, medicines, weight, symptoms']);

  // ---- the same records, laid out for a person to read
  const R = humanReport(FIX);
  const round = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  check('the report names itself and its period', [R.title, R.period, R.days], ['Full report', '4 Oct \u2013 10 Oct 2026', 7]);
  check('averages are over logged days only', R.food!.averages.map((a) => [a.label, round(a.avg), a.target]),
    [['Calories', 1195, 1900], ['Protein', 41, 90], ['Carbs', 157.5, 230], ['Fats', 37, 60], ['Fibre', 16.5, 30]]);
  check('days logged, and days within the calorie target', [R.food!.daysLogged, R.food!.withinTarget], [2, { days: 1, of: 2 }]);
  // The chart's whole point: an unlogged day is a gap, never a zero.
  check('a day with nothing logged is null, not zero', R.food!.perDay.map((d) => d.kcal), [490, 1900, null, null, null, null, null]);
  check('each day carries its label', R.food!.perDay[0].label, 'Sun 4 Oct');
  check('a planned dish is counted in no total, and is reported as planned', [R.food!.planned, R.food!.skipped, R.food!.perDay[0].kcal], [1, 0, 490]);
  check('the dishes behind the calories, largest first', R.food!.behind[0].dishes.map((d) => [d.name, d.amount, Math.round(d.share * 100)]),
    [['Thali', 1900, 79], ['Dal tadka', 236, 10], ['Idli', 156, 7]]);
  check('a tie is broken by name, the same way every time', R.food!.behind[1].dishes.map((d) => d.name), ['Thali', 'Dal tadka', 'Idli']);
  check('never more than three', R.food!.behind.every((b) => b.dishes.length <= 3), true);
  check('when meals are eaten: a slot with only a planned dish is left out', R.food!.slots.map((s) => [s.slot, s.meals, Math.round(s.avgKcal)]),
    [['Breakfast', 1, 254], ['Lunch', 2, 1068]]);
  check('doses add up to what was due', R.meds!.taken + R.meds!.skipped + R.meds!.missed + R.meds!.pending, R.meds!.due);
  check('and match the file for another AI', [R.meds!.taken, R.meds!.skipped, R.meds!.missed, R.meds!.pending],
    (['taken', 'skipped', 'missed', 'pending'] as const).map((k) => FIX.doseDays.reduce((s, d) => s + d[k], 0)));
  check('doses not taken are gathered by medicine and time of day', R.meds!.notTaken,
    [{ medicine: 'Calcium + D3 1250 mg', time: 'Night', skipped: 1, missed: 1 }]);
  check('a stopped medicine says so, and what it was for', R.meds!.medicines[1], { name: 'Cough syrup', schedule: 'Every day', stoppedOn: '2026-10-06', sickness: 'Viral fever' });
  check('a sick period ends when recovery was recorded', R.meds!.episodes, [{ name: 'Viral fever', from: '2026-10-03', to: '2026-10-06' }]);
  check('weight: the change between first and last reading', [round(R.body!.change), R.body!.weights.length, R.body!.goalWeightKg], [-0.5, 2, 70]);
  check('burn is averaged over days it was recorded', [R.body!.avgBurn, R.body!.burnDays, R.body!.goalBurnKcal], [310, 1, 400]);
  check('symptoms in time order, open or resolved', R.body!.symptoms.map((s) => [s.day, s.resolved]), [['Mon 5 Oct', false], ['Fri 9 Oct', true]]);
  check('a meals report has no medicines and no body', [humanReport({ ...FIX, scope: 'meals' }).meds, humanReport({ ...FIX, scope: 'meals' }).body], [null, null]);
  check('a medicines report has no food and no body', [humanReport({ ...FIX, scope: 'meds' }).food, humanReport({ ...FIX, scope: 'meds' }).body], [null, null]);
  const empty = humanReport({ ...FIX, meals: [], weights: [], burns: [], medicines: [], doseDays: [], notTaken: [], symptoms: [], episodes: [],
    targets: { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null } });
  check('an empty period makes a report of nothing, without dividing by it',
    [empty.food!.daysLogged, empty.food!.averages[0].avg, empty.food!.withinTarget, empty.meds!.due, empty.body!.change, empty.body!.avgBurn], [0, null, null, 0, null, null]);
  check('one weight reading has no change', humanReport({ ...FIX, weights: [{ day: '2026-10-04', kg: 72.4 }] }).body!.change, null);
  // Reading is the default; the file has to be asked for by what it is for.
  check('a typed request is for reading unless it says otherwise',
    ['my food report from the past 3 weeks', 'generate a meds report', 'report for my doctor'].map(wantsAiFile), [false, false, false]);
  check('and for another AI when it says so',
    ['a report for ai, last month', 'my food report for chatgpt', 'export my full report since monday', 'report as a markdown file', 'full report to give to claude'].map(wantsAiFile),
    [true, true, true, true, true]);

  // A typed request fills in the sheet. 10 Oct 2026 is a Saturday.
  const ask = (t: string) => reportRequest(t, '2026-10-10');
  check('his own example', ask('Give me my food report from the past 3 weeks'), { scope: 'meals', days: 21 });
  check('medicines, a month', ask('can I have a meds report for the last month'), { scope: 'meds', days: 30 });
  check('no scope named means everything', ask('generate a report for the past 10 days'), { scope: 'full', days: 10 });
  check('both named means everything', ask('make a report of my meals and medicines, last week'), { scope: 'full', days: 7 });
  check('numbers as words', ask('show me a meal report for two weeks'), { scope: 'meals', days: 14 });
  check('since Monday, on a Saturday, is six days', ask('export my full report since Monday'), { scope: 'full', days: 6 });
  check('since Saturday, on a Saturday, is today', ask('give me a report since saturday'), { scope: 'full', days: 1 });
  check('since last Saturday is eight days', ask('give me a report since last saturday'), { scope: 'full', days: 8 });
  check('today alone', ask('food report for today please'), { scope: 'meals', days: 1 });
  check('longer than the limit is held to it', ask('give me a report for the last 6 months'), { scope: 'full', days: 90 });
  check('no period named starts at the default', ask('generate a dose report'), { scope: 'meds', days: 30 });
  check('two words are enough', ask('meds report'), { scope: 'meds', days: 30 });
  check('a question about a report is not a request for one', ask('why does the number in my last report look different from the day screen?'), null);
  check('nor is a message with no report in it', [ask('how has my week looked?'), ask('what did I eat for the past 3 weeks')], [null, null]);
  check('"reported" is not "report"', ask('I reported a headache yesterday'), null);
}

section('A symptom: the label the app suggests');
{
  const label = (t: string) => suggestLabel(t);
  check('the plain case', label('bloated and gassy since lunch, had rajma chawal'), 'Bloating');
  // The miss that started this: "itch" found inside another word.
  check('"twitching" is not itching', label('left eyelid keeps twitching since morning'), null);
  check('nor is "pitching" or "switching" anything', [label('pitching in at work all day'), label('stomach is switching between fine and awful')], [null, null]);
  check('the first one named wins', [label('headache, and a bit of nausea'), label('nauseous, then a headache')], ['Headache', 'Nausea']);
  check('a symptom said to be absent is skipped', [label('no fever but a bad cough since last night'), label('not dizzy any more but nauseous')], ['Cough', 'Nausea']);
  check('"no appetite" and "no energy" are symptoms, not denials', [label('no appetite since yesterday'), label('no energy at all')], ['Low appetite', 'Tiredness']);
  check('cold needs its article', [label('I have a cold and a sore throat'), label('had a cold coffee and felt fine'), label('feeling cold in the AC')], ['Cold', null, null]);
  check('romanised Hindi', [label('sir dard ho raha hai subah se'), label('pet mein dard after pani puri'), label('bukhar 101 since yesterday'), label('khansi aur zukam'), label('saans phool rahi hai')],
    ['Headache', 'Stomach pain', 'Fever', 'Cough', 'Breathlessness']);
  check('capitals do not matter', label('HEADACHE since morning'), 'Headache');
  check('an emergency still gets its label', [label('chest pain going down my left arm'), label("can't breathe properly")], ['Chest pain', 'Breathlessness']);
  check('words that fit nothing get none', [label('feels like something stuck in my throat'), label(''), label('   ')], [null, null, null]);
  // Known, and the reason the card shows the label before saving: it reads
  // words, not who they are about.
  check('it cannot tell whose cough it is', label('my partner has a cough'), 'Cough');

  check('every label in the list is one a suggestion can name, and only those',
    [...new Set([
      'bloated', 'gassy', 'acidity', 'indigestion', 'nauseous', 'vomiting', 'stomach ache', 'loose motions', 'constipated', 'no appetite',
      'headache', 'migraine', 'dizzy', 'coughing', 'caught a cold', 'blocked nose', 'sore throat', 'short of breath', 'wheezing', 'chest pain', 'palpitations',
      'fever', 'chills', 'tired', 'weak', 'body ache', 'swollen ankle', 'rash', 'itchy', 'pimples', 'back pain', 'stiff neck', 'joint pain', 'leg cramps', 'toothache', 'period pain',
      'eye strain', 'ear ache', 'mouth ulcer', 'burning when I pee', 'peeing a lot', "couldn't sleep", 'feeling low', 'anxious', 'stressed',
    ].map(label))].sort(),
    [...SYMPTOM_LABELS].sort());
  check('no label is listed twice', new Set(SYMPTOM_LABELS).size, SYMPTOM_LABELS.length);
  check('the list he approved on the mock-up is all still there',
    ['Bloating', 'Gas', 'Acidity', 'Nausea', 'Vomiting', 'Stomach pain', 'Loose motion', 'Constipation', 'Headache', 'Dizziness', 'Cough', 'Cold', 'Sore throat',
      'Breathlessness', 'Chest pain', 'Fever', 'Tiredness', 'Body ache', 'Rash', 'Itching', 'Back pain', 'Joint pain', 'Poor sleep', 'Low mood', 'Anxiety']
      .filter((l) => !SYMPTOM_LABELS.includes(l)), []);
  check('every group has a name and something in it', SYMPTOM_GROUPS.every((g) => g.group.length > 0 && g.labels.length > 0), true);
}

section('A symptom: the words that travel');
{
  const scrub = (t: string) => scrubContacts(t).text;
  check('an Indian mobile, the ways it is written',
    [scrub('call 9820155512 now'), scrub('call 98201 55512'), scrub('call +91 98201 55512'), scrub('call 0 98201 55512'), scrub('call +91-98201-55512')],
    ['call [phone] now', 'call [phone]', 'call [phone]', 'call [phone]', 'call [phone]']);
  check('a landline with its code, and a foreign number', [scrub('clinic 022 2345 6789'), scrub('ring +65 9123 4567')], ['clinic [phone]', 'ring [phone]']);
  check('an email address', scrub('wrote to dr.rao@clinic.co.in about it'), 'wrote to [email] about it');
  check('and it counts what it took', scrubContacts('98201 55512 or rao@clinic.in').count, 2);
  // What a symptom is full of, and none of it a phone number.
  const kept = ['sugar 140 180 210 190', 'temp 101.5 at 10 pm', 'took 2 crocin 650 at 9', 'BP 140/90, pulse 88', 'weight 72.4 kg on 11 Oct 2026',
    'for 3 days since 2026-10-08', 'between 2026-10-01 2026-10-11', '1850 1920 2010 1780 1990 2100 1700', 'pin 400050 flat 1203'];
  check('readings, doses, dates and a week of calories are left alone', kept.map(scrub), kept);
  check('a longer number is not cut into', scrub('ref 1234 5678 9012 3456'), 'ref 1234 5678 9012 3456');
  check('ordinary words redact nothing', scrubContacts('bloated and gassy since lunch').count, 0);

  check('the limit is the one he chose', WORDS_FOR_MODEL, 200);
  check('short words go whole', wordsForModel('  bloated and gassy\n since lunch '), 'bloated and gassy since lunch');
  const long = 'Headache again since the afternoon. Dr. Rao at the clinic said to call 98201 55512 if it lasts more than two days. '
    + 'Took nothing for it yet because I wanted to see whether it passes after dinner and a proper night of sleep, which it usually does.';
  check('long words stop at a sentence end, with the number gone',
    wordsForModel(long), 'Headache again since the afternoon. Dr. Rao at the clinic said to call [phone] if it lasts more than two days.');
  check('"Dr." does not end a sentence', wordsForModel('Felt faint at the gym and went to see Dr. Rao who said rest', 45), 'Felt faint at the gym and went to see Dr.\u2026');
  check('with no sentence end it stops at a whole word and says there was more',
    wordsForModel('dizzy every time I stand up from the desk and it has been going on all week', 40), 'dizzy every time I stand up from the\u2026');
  check('a decimal point at the limit is not a sentence end', wordsForModel('ok. fever was 38.5 this morning', 17), 'ok.');
  check('never longer than the limit, ellipsis aside', wordsForModel('word '.repeat(100)).length <= WORDS_FOR_MODEL + 1, true);
  // Scrubbed first: cut first, and "98201 55512" split at the limit leaves
  // five digits that no longer look like a number to remove.
  check('a number straddling the limit does not leave half of itself', /\d{4}/.test(wordsForModel('call the clinic on 98201 55512 tomorrow', 26)), false);
}

section('Ask Mealo: the figures the app works out');
{
  const facts = {
    nutrition7d: { daysLogged: 2, avgEnergy: 581, avgProtein: 17, avgFat: 21, avgCarbs: 74, avgFibre: 9 },
    adherence7d: { taken: 0, skipped: 0, missed: 0 },
    todayTotals: { energy: 640, protein: 22, fat: 18, carbs: 96, fibre: 11 },
    mealsToday: [{ type: 'Lunch', time: '13:10', items: ['Dal tadka'], energy: 640, protein: 22, fat: 18, carbs: 96, fibre: 11 }],
  };
  const none = { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null };
  const set = { energy_kcal: 1900, protein_g: 90, fat_g: 60, carbs_g: 240, fibre_g: 30 };
  const week = figuresFor('How has my week looked?', facts, set)!;
  // What he asked for on 11 Oct: the week's answer had no carbs and no fat.
  check('the week has all five, and the days they are averaged over', week.cells.map((c) => c.label),
    ['Calories a day', 'Protein a day', 'Carbs a day', 'Fats a day', 'Fibre a day', 'Days logged']);
  check('each against its target', week.cells.map((c) => `${c.value} ${c.of}`),
    ['581 / 1,900 Cal', '17 / 90 g', '74 / 240 g', '21 / 60 g', '9 / 30 g', '2 of 7']);
  check('with no target set, the unit alone', figuresFor('my week', facts, none)!.cells.slice(0, 2).map((c) => `${c.value} ${c.of}`), ['581 Cal', '17 g']);
  check('doses join the week only when some were due',
    figuresFor('my week', { ...facts, adherence7d: { taken: 24, skipped: 1, missed: 3 } }, set)!.cells.slice(6).map((c) => `${c.label} ${c.value} ${c.of}`),
    ['Doses taken 24 of 28', 'Skipped or missed 4 of 28']);
  check('a figure that could not be summed is a dash, not a zero',
    figuresFor('my week', { ...facts, nutrition7d: { ...facts.nutrition7d, avgFat: null } }, none)!.cells[3].value, '\u2013');
  check('today', figuresFor('What have I eaten today?', facts, set)!.cells.map((c) => `${c.label} ${c.value} ${c.of}`.trim()),
    ['Calories 640 / 1,900 Cal', 'Protein 22 / 90 g', 'Carbs 96 / 240 g', 'Fats 18 / 60 g', 'Fibre 11 / 30 g', 'Meals logged 1']);
  check('nothing logged, no table of zeros',
    [figuresFor('What have I eaten today?', { ...facts, mealsToday: [] }, set),
      figuresFor('my week', { ...facts, nutrition7d: { daysLogged: 0, avgEnergy: null, avgProtein: null, avgFat: null, avgCarbs: null, avgFibre: null } }, set)], [null, null]);
  check('a question about doses gets none yet', figuresFor('Which doses are left today?', facts, set), null);
  check('nor does a question about neither', figuresFor('is dal a good source of protein?', facts, set), null);
  check('"weekend" is not "week"', figuresFor('plans for the weekend', facts, set), null);
  check('the model is told the table is on screen',
    figuresNote(week).startsWith('The app is showing the person this table above your answer (Last 7 days): Calories a day 581 / 1,900 Cal; Protein a day 17 / 90 g;'), true);
}

section('Ask Mealo: Elaborate');
{
  const q = (text: string) => ({ kind: 'asked', text });
  const a = { kind: 'answer', text: 'A summary.' };
  check('under a first answer', canElaborate([q('How has my week looked so far?'), a]), true);
  check('with the app\'s table between question and answer', canElaborate([q('my week'), { kind: 'figures' }, a]), true);
  check('not under the elaboration itself', canElaborate([q('my week'), a, q(ELABORATE), a]), false);
  check('back again after the next real question', canElaborate([q('my week'), a, q(ELABORATE), a, q('and today?'), a]), true);
  check('not while a question has no answer yet', canElaborate([q('my week')]), false);
  check('not under a red-flag stop', canElaborate([q('chest pain'), { kind: 'stop', text: 'Seek care now' }]), false);
  check('not under a card or a receipt', canElaborate([q('my week'), a, { kind: 'flow' }]), false);
  check('not on an empty chat', canElaborate([]), false);
  // The button sends an ordinary message, so what it sends must not be read
  // as a request for a report or a table of its own.
  check('what it sends is not taken for anything else',
    [reportRequest(ELABORATE, '2026-10-10'), figuresFor(ELABORATE, { nutrition7d: { daysLogged: 2, avgEnergy: 1, avgProtein: 1, avgFat: 1, avgCarbs: 1, avgFibre: 1 },
      adherence7d: { taken: 0, skipped: 0, missed: 0 }, todayTotals: { energy: 1, protein: 1, fat: 1, carbs: 1, fibre: 1 }, mealsToday: [] },
      { energy_kcal: null, protein_g: null, fat_g: null, carbs_g: null, fibre_g: null })], [null, null]);
}

section('Ask Mealo: an answer drawn, not shown as Markdown');
{
  // The answer on his phone on 11 Oct, as the model wrote it.
  const his = ['Your week so far shows:', '', '- **Medications**: No doses recorded.',
    '- **Meals logged**: You haven\u2019t logged any meals today.', '- **Nutrition summary (2 days)**:',
    '  - Calories: ~581 kcal/day', '  - Protein: ~17 g/day', '', 'If you\u2019d like more, let me know.'].join('\n');
  const blocks = answerBlocks(his);
  check('a paragraph, a list, a paragraph', blocks.map((b) => b.kind), ['p', 'list', 'p']);
  const list = blocks[1] as Extract<typeof blocks[number], { kind: 'list' }>;
  check('the bold words are bold and the asterisks are gone', list.items[0].spans,
    [{ text: 'Medications', bold: true }, { text: ': No doses recorded.', bold: false }]);
  check('the nested lines sit one level in', list.items.map((i) => i.depth), [0, 0, 0, 1, 1]);
  check('no asterisk survives anywhere', JSON.stringify(blocks).includes('*'), false);
  check('a numbered list keeps its numbers',
    (answerBlocks('1. First\n2) Second')[0] as typeof list).items.map((i) => [i.marker, i.spans[0].text]), [['1.', 'First'], ['2)', 'Second']]);
  check('a heading is a bold line', answerBlocks('## Summary\nAll fine.'), [{ kind: 'p', spans: [{ text: 'Summary', bold: true }] }, { kind: 'p', spans: [{ text: 'All fine.', bold: false }] }]);
  check('italics and code marks are dropped, the words kept', spansOf('this is *really* `fine` and _ok_'), [{ text: 'this is really fine and ok', bold: false }]);
  // Arithmetic and ranges are not emphasis.
  check('a lone asterisk or underscore is left alone', spansOf('2 * 3 = 6, snake_case, 5*4'), [{ text: '2 * 3 = 6, snake_case, 5*4', bold: false }]);
  check('an unclosed ** is text', spansOf('a ** b'), [{ text: 'a ** b', bold: false }]);
  check('lines of one paragraph stay together', answerBlocks('one\ntwo\n\nthree').map((b) => b.kind === 'p' && b.spans[0].text), ['one\ntwo', 'three']);
  check('plain text is one paragraph, untouched', answerBlocks('Protein is the gap, about 19 g short.'), [{ kind: 'p', spans: [{ text: 'Protein is the gap, about 19 g short.', bold: false }] }]);
  check('an empty reply is no blocks', answerBlocks('  \n '), []);
  // Nothing is ever parsed as HTML; the screen builds elements from spans.
  check('markup in a reply stays text', spansOf('<img src=x onerror=alert(1)>')[0].text, '<img src=x onerror=alert(1)>');
}

section('Backup and restore: what a file must be');
{
  const tables = [...new Set([...COUNTED, ...REQUIRED, 'foods', 'med_products'])];
  const good: BackupInfo = { integrity: 'ok', version: LATEST_VERSION, bytes: 1_300_000, tables,
    counts: { profiles: 2, meals: 412, meal_items: 1870, custom_foods: 96, food_portions: 140, medications: 3, med_doses: 5, intake_events: 44, sick_episodes: 1, weights: 30, burns: 12, symptoms: 7, targets: 2, messages: 58 } };
  check('a sound backup from this version may be restored', refusal(good, LATEST_VERSION), null);
  check('so may one from an older version: it is brought forward', refusal({ ...good, version: LATEST_VERSION - 2 }, LATEST_VERSION), null);
  check('a newer one is refused, and says to update', refusal({ ...good, version: LATEST_VERSION + 1 }, LATEST_VERSION)?.includes('newer version of Mealo'), true);
  check('a damaged file is refused with what SQLite said', refusal({ ...good, integrity: '*** in database main *** Page 12: btreeInitPage() returns error code 11' }, LATEST_VERSION)?.startsWith('This file is damaged'), true);
  check('an empty database is refused', refusal({ ...good, version: 0, tables: [], counts: {} }, LATEST_VERSION), 'This file is an empty database. There is nothing in it to restore.');
  check('some other app\'s database is refused', refusal({ ...good, tables: ['notes', 'tags'], counts: {} }, LATEST_VERSION), 'This is a database, but not one made by Mealo.');
  check('damage is reported before anything else', refusal({ ...good, integrity: 'bad', version: LATEST_VERSION + 5 }, LATEST_VERSION)?.startsWith('This file is damaged'), true);
  for (const t of REQUIRED) check(`without ${t} it is not Mealo's`, refusal({ ...good, tables: tables.filter((x) => x !== t) }, LATEST_VERSION), 'This is a database, but not one made by Mealo.');

  check('the same rows in every table is a restore that worked', sameRows(good, { ...good, bytes: 0 }), null);
  check('one meal short is not', sameRows(good, { ...good, counts: { ...good.counts, meals: 411 } }), 'meals: the file has 412 rows, the restored database has 411');
  check('a table gone missing is not', sameRows(good, { ...good, counts: { ...good.counts, weights: undefined as unknown as number } }), 'weights: the file has 30 rows, the restored database has none');
  check('a table the file never had is not held against it', sameRows({ ...good, counts: { meals: 412 } }, good), null);
  check('every counted table is one the app has', COUNTED.every((t) => MIGRATIONS.some((m) => m.sql.includes(`TABLE IF NOT EXISTS ${t}`) || m.sql.includes(`TABLE ${t}`))), true);
  check('everything a person logs is counted', ['meals', 'meal_items', 'medications', 'intake_events', 'weights', 'symptoms', 'messages', 'profiles'].every((t) => (COUNTED as readonly string[]).includes(t)), true);

  check('what a backup holds, in words', describe(good),
    ['412 meals', '1,870 dishes eaten', '96 dishes in the food table', '3 medicines', '44 doses answered', '30 weights', '7 symptoms', '58 chat messages', '2 profiles']);
  check('one of each reads right', describe({ ...good, counts: { profiles: 1, meals: 1, meal_items: 1, custom_foods: 1, medications: 1, intake_events: 1, weights: 1, symptoms: 1, messages: 1 } })[0], '1 meal');
  check('a missing table reads as none', describe({ ...good, counts: {} })[0], '0 meals');
  check('sizes', [sizeLabel(900), sizeLabel(250_000), sizeLabel(1_300_000), sizeLabel(48_000_000)], ['1 KB', '244 KB', '1.2 MB', '45.8 MB']);
  // 00:30 on 12 Oct in India is still 11 Oct in UTC; the name is the day it is where the person is.
  check('the file is named for the local day', backupName(new Date(2026, 9, 12, 0, 30)), 'mealo-backup-2026-10-12.sqlite3');
}

// ----------------------------------------------- planning a day by chat
import { aimLine, asksAtNight, belowFloor, countFromToday, distance, nightAhead, planReceipt, planRequest, rankDays, usualOptions, USUAL_MIN_DAYS, type Five, type Option, type PastMeal } from '../src/domain/mealplan';
import { stampFor } from '../src/domain/plan';
{
  // Sunday 11 Oct 2026, 10:00.
  const now = new Date(2026, 9, 11, 10, 0);
  const ask = (t: string) => planRequest(t, now);
  check('the sentence it was built for', ask('Plan tomorrow so I hit 90 g protein, using things I usually eat'), { ahead: 1, counted: true, protein: 90, kcal: null });
  check('a bare day', ask('plan tomorrow'), { ahead: 1, counted: true, protein: null, kcal: null });
  check('today', ask('Plan my meals for today'), { ahead: 0, counted: false, protein: null, kcal: null });
  check('tonight is today', ask('plan dinner tonight'), { ahead: 0, counted: false, protein: null, kcal: null });
  check('the day after', ask('please plan the day after tomorrow'), { ahead: 2, counted: true, protein: null, kcal: null });
  check('a weekday is the next one', [ask('plan Friday')?.ahead, ask('plan my food for wed')?.ahead, ask('plan monday')?.ahead], [5, 3, 1]);
  check('said on a Sunday, Sunday is a week away', ask('plan sunday')?.ahead, 7);
  check('in N days', ask('plan my meals in 3 days')?.ahead, 3);
  check('no day named is tomorrow', ask('plan my meals so I get 100g of protein'), { ahead: 1, counted: true, protein: 100, kcal: null });
  check('politely', [ask('Can you plan tomorrow?')?.ahead, ask('could you please plan my meals for tomorrow')?.ahead, ask('I want you to plan tomorrow')?.ahead, ask("let's plan tomorrow")?.ahead, ask('help me plan tomorrow')?.ahead], [1, 1, 1, 1, 1]);
  check('a curly apostrophe from a phone', ask('let’s plan tomorrow')?.ahead, 1);
  check('other verbs need the word plan', [ask('make me a meal plan for tomorrow')?.ahead, ask('suggest a plan for Friday meals')?.ahead, ask('make me a sandwich tomorrow')], [1, 5, null]);
  check('calories typed', ask('plan tomorrow at 1800 kcal with 120 g protein'), { ahead: 1, counted: true, protein: 120, kcal: 1800 });
  check('calories with a comma', ask('plan tomorrow around 2,000 calories')?.kcal, 2000);
  check('a calorie figure under the floor is seen as one', [ask('plan tomorrow at 600 kcal'), ask('plan tomorrow at 999 calories'), ask('plan tomorrow at 1000 calories'), ask('plan tomorrow')].map((a) => [a!.kcal, belowFloor(a!)]),
    [[600, true], [999, true], [1000, false], [null, false]]);
  check('one meal\'s calories are not the day\'s', [ask('plan tomorrow with a 300 kcal snack')?.kcal, ask('plan tomorrow, 400 calorie breakfast')?.kcal, ask('make me a 500 calorie meal plan for tomorrow')?.kcal], [null, null, 500]);
  check('a silly protein figure is not used', [ask('plan tomorrow with 5 g protein')?.protein, ask('plan tomorrow with 900 g protein')?.protein], [null, null]);
  check('protein the other way round', ask('plan tomorrow, protein at least 95 g')?.protein, 95);
  // Not requests to plan a day's meals.
  for (const t of [
    'What did I plan for tomorrow?', 'did I plan anything for Friday', 'how is my plan going', 'plan my trip tomorrow', 'plan a workout for tomorrow',
    'I plan to eat less', 'my plan is to lose weight', 'the plan worked', 'tomorrow I will plan', 'is my meal plan ok', 'I just had 2 roti and dal',
    'make a report for last week', 'planning is hard', '', 'plan my medicines for tomorrow', 'plan when to take my tablets',
  ]) check(`not a plan request: ${t || '(empty)'}`, ask(t), null);

  // ---- "tomorrow" after midnight: counted days are asked about, named ones are not
  check('a weekday is named, not counted', [ask('plan Friday')?.counted, ask('plan sunday')?.counted], [false, false]);
  check('kal, parso and in N days are counted', [ask('plan kal')?.counted, ask('plan parso')?.ahead, ask('plan my meals in 3 days')?.counted], [true, 2, true]);
  // Thursday 15 Oct 2026, the night he found it.
  const late = new Date(2026, 9, 15, 1, 30);
  const lateAsk = (t: string) => planRequest(t, late)!;
  check('at 01:30 "plan tomorrow" asks', asksAtNight(lateAsk('plan tomorrow so I hit 90 g protein'), late), true);
  check('so does a plan with no day', asksAtNight(lateAsk('plan my meals so I get 100g of protein'), late), true);
  check('"plan today" at 01:30 does not', asksAtNight(lateAsk('plan today'), late), false);
  check('nor does a weekday', asksAtNight(lateAsk('plan Saturday'), late), false);
  check('at 04:59 it still asks', asksAtNight(lateAsk('plan tomorrow'), new Date(2026, 9, 15, 4, 59)), true);
  check('at 05:00 tomorrow is the calendar\'s', asksAtNight(planRequest('plan tomorrow', new Date(2026, 9, 15, 5))!, new Date(2026, 9, 15, 5)), false);
  check('a plan with no sentence behind it never asks', asksAtNight({ ahead: 1, protein: null, kcal: null }, late), false);
  check('the day that has just begun', [nightAhead(1, 'begun'), nightAhead(2, 'begun'), nightAhead(0, 'begun')], [0, 1, 0]);
  check('the calendar\'s', [nightAhead(1, 'after'), nightAhead(2, 'after')], [1, 2]);
  // Said on a Thursday at 01:30, "Thursday" was a week away.
  check('the weekday that has just begun is today, not next week', lateAsk('plan thursday').ahead, 0);
  check('and in the daytime still a week away', planRequest('plan thursday', new Date(2026, 9, 15, 10))!.ahead, 7);
  // A model's plan: the person's words decide the day when they count it.
  check('a model\'s plan reads the count from the words', [countFromToday('what should I eat tomorrow?'), countFromToday('kal ke liye'), countFromToday('the day after tomorrow please')], [1, 1, 2]);
  check('and leaves its own day alone when they do not', [countFromToday('help me eat better'), countFromToday('what about friday')], [null, null]);

  // His choice, 15 Oct 2026: another day takes the slot's usual hour, not noon.
  const d10 = new Date(2026, 9, 10).getTime();
  check('a past day: breakfast at 8, dinner at 20', [stampFor(d10, now, 'breakfast'), stampFor(d10, now, 'dinner')], [new Date(2026, 9, 10, 8).getTime(), new Date(2026, 9, 10, 20).getTime()]);
  check('"Something else" keeps noon', stampFor(d10, now, 'other'), new Date(2026, 9, 10, 12).getTime());
  check('a day ahead, a plan, keeps noon until its tick', stampFor(new Date(2026, 9, 13).getTime(), now, 'breakfast'), new Date(2026, 9, 13, 12).getTime());
  check('today is the clock, whatever the slot', stampFor(new Date(2026, 9, 11).getTime(), now, 'breakfast'), now.getTime());
  check('noon on another day, the clock today', [stampFor(new Date(2026, 9, 12).getTime(), now), stampFor(new Date(2026, 9, 11).getTime(), now)], [new Date(2026, 9, 12, 12).getTime(), now.getTime()]);

  // ---- which meals are usual
  const dish = (foodId: string, quantity: number | null = 1, unit: string | null = 'katori', grams: number | null = null) => ({ foodId, name: foodId, quantity, unit, grams });
  const meal = (slot: PastMeal['slot'], day: number, dishes: PastMeal['dishes']): PastMeal => ({ slot, at: new Date(2026, 9, day, 9).getTime(), day: `2026-10-${String(day).padStart(2, '0')}`, dishes });
  const poha = [dish('poha'), dish('chai', 1, 'cup')];
  const idli = [dish('idli', 3, 'piece'), dish('sambar')];
  const dalRoti = [dish('dal'), dish('roti', 2, 'piece')];
  const past: PastMeal[] = [
    meal('breakfast', 1, poha), meal('breakfast', 2, poha), meal('breakfast', 3, idli), meal('breakfast', 4, [...poha].reverse()), meal('breakfast', 5, idli), meal('breakfast', 6, [dish('poha', 2), dish('chai', 1, 'cup')]),
    meal('lunch', 1, dalRoti), meal('lunch', 2, dalRoti), meal('lunch', 3, dalRoti), meal('lunch', 4, dalRoti),
    meal('dinner', 1, [dish('khichdi', null, null, 300)]), meal('dinner', 2, [dish('khichdi', null, null, 300)]),
    meal('esnack', 1, [dish('chana')]), meal('esnack', 2, [dish('chana')]), meal('esnack', 3, [dish('fruit', 1, 'piece')]),
    meal('other', 1, [dish('cake')]), meal('other', 2, [dish('cake')]), meal('other', 3, [dish('cake')]),
  ];
  const usual = usualOptions(past);
  check('three days make a slot usual, two do not, and "something else" never is', [USUAL_MIN_DAYS, usual.map((u) => u.slot)], [3, ['breakfast', 'lunch', 'esnack']]);
  const bf = usual[0];
  check('the same dishes in another order are one meal', bf.options.map((o) => [o.dishes.map((d) => d.foodId).sort().join('+'), o.times]), [['chai+poha', 3], ['idli+sambar', 2], ['chai+poha', 1]]);
  check('a different amount is a different meal', bf.options[2].dishes.find((d) => d.foodId === 'poha')?.quantity, 2);
  check('a slot logged on fewer than half the days may be left empty', usual.map((u) => [u.slot, u.days, u.optional]), [['breakfast', 6, false], ['lunch', 4, false], ['esnack', 3, false]]);
  check('and one that is, is optional', usualOptions([...past, meal('breakfast', 7, poha), meal('breakfast', 8, poha)]).find((u) => u.slot === 'esnack')?.optional, true);
  check('the same meal twice on one day counts once', usualOptions([meal('lunch', 1, dalRoti), meal('lunch', 1, dalRoti), meal('lunch', 2, dalRoti), meal('lunch', 3, dalRoti)])[0].options[0].times, 3);

  // ---- choosing the day
  const five = (energy_kcal: number, protein_g: number): Five => ({ energy_kcal, protein_g, fat_g: 0, carbs_g: 0, fibre_g: 0 });
  const price: Record<string, Five> = { 'chai+poha': five(350, 8), 'idli+sambar': five(300, 12), 'dal+roti': five(450, 18), chana: five(200, 11), fruit: five(90, 1), 'chai+poha2': five(600, 14) };
  const priced = (o: Option) => price[o.dishes.map((d) => d.foodId).sort().join('+') + (o.dishes.some((d) => d.quantity === 2 && d.foodId === 'poha') ? '2' : '')];
  const names = (d: { picks: { option: Option }[] }) => d.picks.map((p) => p.option.dishes.map((x) => x.foodId).sort().join('+'));
  const none = { protein: null, kcal: null, proteinAsked: false };
  check('with no aim, the most usual day', names(rankDays(usual, priced, none)[0]), ['chai+poha', 'dal+roti', 'chana']);
  const highP = rankDays(usual, priced, { protein: 41, kcal: null, proteinAsked: true });
  check('a protein figure picks the meals that reach it', [names(highP[0]), highP[0].totals.protein_g], [['idli+sambar', 'dal+roti', 'chana'], 41]);
  check('it never invents: every pick is one of the options handed in', highP.every((d) => d.picks.every((p) => usual.some((u) => u.options.includes(p.option)))), true);
  check('five days at most, nearest first, all different', [highP.length, new Set(highP.map((d) => d.picks.map((p) => p.option.dishes.map((x) => `${x.foodId}*${x.quantity}`).sort().join('+')).join('|'))).size], [5, 5]);
  const cut = rankDays(usual, priced, { protein: null, kcal: 800, proteinAsked: false });
  check('going over the calorie target costs more than falling short', [names(cut[0]), cut[0].totals.energy_kcal], [['idli+sambar', 'dal+roti', 'fruit'], 840]);
  check('what the day already holds is counted', rankDays(usual.filter((u) => u.slot !== 'lunch'), priced, { protein: 41, kcal: null, proteinAsked: true }, five(450, 18))[0].dayTotals.protein_g, 41);
  check('nothing to choose from is no plan', [rankDays([], priced, none), rankDays([{ slot: 'lunch', days: 3, optional: false, options: [] }], priced, none)], [[], []]);
  const opt = rankDays([{ ...usual[2], optional: true }, usual[1]], priced, { protein: null, kcal: 450, proteinAsked: false });
  check('an optional slot can be left out to stay under the target', names(opt[0]), ['dal+roti']);
  check('distance: over counts three times under', [distance(five(1100, 0), { protein: null, kcal: 1000, proteinAsked: false }), distance(five(900, 0), { protein: null, kcal: 1000, proteinAsked: false })].map((n) => Math.round(n * 100) / 100), [0.3, 0.1]);
  check('distance: protein asked for counts double protein from the target', [distance(five(0, 80), { protein: 100, kcal: null, proteinAsked: true }), distance(five(0, 80), { protein: 100, kcal: null, proteinAsked: false })].map((n) => Math.round(n * 100) / 100), [0.8, 0.4]);

  // ---- the words
  check('the aim line states the gap', aimLine(five(1640, 78), { protein: 90, kcal: 1800, proteinAsked: true }), '78 g protein, 12 g under the 90 g you asked for · 160 Cal under the 1,800 Cal target');
  check('and says "target" when the figure was not typed', aimLine(five(1900, 95), { protein: 90, kcal: 1800, proteinAsked: false }), '95 g protein, 5 g over the 90 g target · 100 Cal over the 1,800 Cal target');
  check('no aim, no line', aimLine(five(1900, 95), none), null);
  check('the receipt is written from what was stored', [planReceipt('Mon 12 Oct', 3, 7, 1640.4, 7), planReceipt('Mon 12 Oct', 1, 1, 300, 2)],
    ['Planned for Mon 12 Oct: 3 meals, 7 dishes, 1,640 Cal. In Track meals.', 'Planned for Mon 12 Oct: 1 meal, 1 dish, 300 Cal. In Track meals. The card showed 2 dishes; 1 were saved.']);
}

// ------------------------------------------------------------ reminders
import { duration, fastLine, GAP_HOURS } from '../src/domain/fasting';
import { ago, backupDue, BACKUP_NUDGE_DAYS, RELAY_KEEP_DAYS, SYNC_AMBER_DAYS, SYNC_URGENT_DAYS, syncTone } from '../src/domain/upkeep';
import { needsSending, RESEND_AFTER_MS, scheduleSig, testRingAt, testRingTime, wordsOf } from '../src/domain/reminders';
import { clockOn, clockOnCalendar, DEFAULT_REMINDERS, doseRings, inOrder, isClock, mealRings, readSettings, scheduleDays, SCHEDULE_DAYS, type ReminderSettings } from '../src/domain/reminders';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
{
  const on: ReminderSettings = { ...DEFAULT_REMINDERS, on: true, profileId: 'primary' };
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  // Sunday 11 Oct 2026, 10:00.
  const now = at(11, 10);

  check('a clock time on a day', clockOn('2026-10-11', '08:00'), at(11, 8));
  check('before three is the night of the day before, so the next calendar day', clockOn('2026-10-11', '00:30'), at(12, 0, 30));
  check('three itself is the morning of the day', clockOn('2026-10-11', '03:00'), at(11, 3));
  check('what a clock time looks like', ['08:00', '23:59', '00:00', '8:00', '24:00', '12:60', '', null, 800].map(isClock), [true, true, true, false, false, false, false, false, false]);
  check('each default sits inside its part of the day', Object.values(DEFAULT_REMINDERS.times).map((t) => partOfDay(new Date(clockOn('2026-10-11', t)))), ['morning', 'afternoon', 'evening', 'night']);
  check('off until turned on, and names off until chosen', [DEFAULT_REMINDERS.on, DEFAULT_REMINDERS.names], [false, false]);
  check('fourteen days, today first', [SCHEDULE_DAYS, scheduleDays('2026-10-11').length, scheduleDays('2026-10-11')[0], scheduleDays('2026-10-11')[13]], [14, 14, '2026-10-11', '2026-10-24']);

  const days = [
    { day: '2026-10-11', groups: [{ time: 'morning' as const, names: ['Metformin'] }, { time: 'night' as const, names: ['Metformin', 'Atorvastatin'] }, { time: 'evening' as const, names: [] }] },
    { day: '2026-10-12', groups: [{ time: 'morning' as const, names: ['Metformin'] }] },
  ];
  const rings = doseRings(days, on, now);
  check('one ring for each part of the day with something to take', rings.map((r) => r.at), [at(11, 21, 30), at(12, 8)]);
  check('this morning has passed and does not ring', rings.some((r) => r.at === at(11, 8)), false);
  check('a part of the day with nothing left does not ring', rings.some((r) => r.title.startsWith('Evening')), false);
  check('the lock screen names no medicine unless asked', rings.map((r) => [r.title, r.body]), [['Night medicines', '2 to take. Open Mealo to tick them.'], ['Morning medicines', 'One to take. Open Mealo to tick it.']]);
  const named = doseRings(days, { ...on, names: true }, now);
  check('asked, it names them', named.map((r) => r.body), ['Metformin, Atorvastatin', 'Metformin']);
  // R2: an amount is never the app's to state, least of all on a lock screen.
  const loud = doseRings([{ day: '2026-10-12', groups: [{ time: 'morning' as const, names: ['Metformin 500 mg'] }] }], { ...on, names: true }, now);
  check('and with names off, a strength in a medicine\'s name stays off the lock screen', /500|mg/.test(JSON.stringify(doseRings([{ day: '2026-10-12', groups: [{ time: 'morning' as const, names: ['Metformin 500 mg'] }] }], on, now))), false);
  check('names on shows the name as the person wrote it, nothing added', loud[0].body, 'Metformin 500 mg');
  check('no reminder text carries a number of tablets or a unit', [...rings, ...named].some((r) => /\b\d+(\.\d+)?\s*(mg|ml|tablets?|g|mcg|drops?|scoops?)\b/i.test(`${r.title} ${r.body}`)), false);
  check('the same medicine twice at one time is named once', doseRings([{ day: '2026-10-12', groups: [{ time: 'morning' as const, names: ['Metformin', 'Metformin'] }] }], { ...on, names: true }, now)[0].body, 'Metformin');
  check('doses switched off: none', doseRings(days, { ...on, doses: false }, now), []);
  check('a chosen time is the time', doseRings(days, { ...on, times: { ...on.times, night: '22:15' } }, now)[0].at, at(11, 22, 15));

  const meals = mealRings(['2026-10-11', '2026-10-12', '2026-10-13'], new Set(), on, now);
  check('the evening nudge, each day', meals.map((r) => r.at), [at(11, 21), at(12, 21), at(13, 21)]);
  check('not on a day that has a meal', mealRings(['2026-10-11', '2026-10-12'], new Set(['2026-10-11']), on, now).map((r) => r.at), [at(12, 21)]);
  check('not once its time has passed', mealRings(['2026-10-11'], new Set(), on, at(11, 21, 1)), []);
  check('switched off: none', mealRings(['2026-10-11'], new Set(), { ...on, meals: false }, now), []);
  // A nudge before three is on its own calendar day. It went through the
  // medicine clock and rang a day late: set at 02:20 on Thursday for 02:31,
  // the first ring was Friday's (15 Oct 2026).
  const small = at(15, 2, 20);
  check('a 02:31 nudge rings today at 02:31', mealRings(['2026-10-15', '2026-10-16'], new Set(), { ...on, mealTime: '02:31' }, small).map((r) => r.at), [at(15, 2, 31), at(16, 2, 31)]);
  check('one at 00:00 is that day\'s midnight', clockOnCalendar('2026-10-15', '00:00'), at(15, 0));
  check('doses keep the night rule', clockOn('2026-10-15', '02:31'), at(16, 2, 31));
  // His decision, 10 Oct: plain. No guilt, no streaks, nothing about calories.
  const words = [...rings, ...named, ...meals].map((r) => `${r.title} ${r.body}`).join(' ').toLowerCase();
  check('plain words: no guilt, no streak, no calories, no "should"', ['streak', 'calorie', 'kcal', 'should', 'forgot', 'missed', 'again', "don't", 'must', '!'].filter((w) => words.includes(w)), []);
  check('soonest first, and no more than the relay holds', [inOrder([...meals, ...rings]).map((r) => r.at)[0], inOrder(Array.from({ length: 150 }, (_, i) => ({ ...meals[0], at: now + i }))).length], [at(11, 21), 100]);

  check('stored settings are read back whole', readSettings({ on: true, profileId: 'p2', doses: false, meals: true, names: true, times: { morning: '07:15', afternoon: '13:00', evening: '18:00', night: '22:00' }, mealTime: '20:30', week: false, weekTime: '09:15' }),
    { on: true, profileId: 'p2', doses: false, meals: true, names: true, times: { morning: '07:15', afternoon: '13:00', evening: '18:00', night: '22:00' }, mealTime: '20:30', week: false, weekTime: '09:15' });
  check('nothing stored is the defaults', readSettings(undefined), DEFAULT_REMINDERS);
  check('a broken time falls back to its default, the rest is kept', readSettings({ on: true, times: { morning: 'early', night: '23:00' }, mealTime: 9 }),
    { ...DEFAULT_REMINDERS, on: true, times: { ...DEFAULT_REMINDERS.times, night: '23:00' } });
  check('"on" is only ever a real true', [readSettings({ on: 'yes' }).on, readSettings({ on: 1 }).on, readSettings({ names: 'true' }).names], [false, false, false]);

  // ---- the service worker's half, loaded from the file phones run
  const sw = runInNewContext(`${readFileSync('public/push-sw.js', 'utf8')}; ({ pickRings, FALLBACK })`, {}) as {
    pickRings: (note: unknown, now: number) => { at: number; title: string }[];
    FALLBACK: { title: string; body: string };
  };
  const note = [
    { at: at(11, 8), kind: 'doses', title: 'Morning medicines', body: 'x' },
    { at: at(11, 21), kind: 'meals', title: 'Today’s meals', body: 'x' },
    { at: at(11, 21, 30), kind: 'doses', title: 'Night medicines', body: 'x' },
    { at: at(12, 8), kind: 'doses', title: 'Morning medicines', body: 'x' },
  ];
  const picked = (h: number, m = 0, n: unknown = note) => sw.pickRings(n, at(11, h, m)).map((r) => r.title);
  check('a push on the minute shows that minute\'s ring', picked(21), ['Today’s meals']);
  check('and not the one half an hour later', picked(21).includes('Night medicines'), false);
  check('a push a minute early still finds it', picked(20, 59), ['Today’s meals']);
  check('one delivered late, to a phone that was off, still finds it', picked(21, 50), ['Today’s meals', 'Night medicines']);
  check('more than an hour late, it is not shown as if it were now', picked(22, 40), []);
  check('a ring already shown is not shown again', picked(21, 0, note.map((r) => ({ ...r, shown: true }))), []);
  check('no list, a broken list: nothing picked, and no crash', [picked(21, 0, null), picked(21, 0, 'x'), picked(21, 0, [null, 5, {}])], [[], [], []]);
  // iOS withdraws a subscription after three pushes that show nothing.
  check('there is always a line to show', [typeof sw.FALLBACK.title, sw.FALLBACK.body.length > 10], ['string', true]);
  const src = readFileSync('public/push-sw.js', 'utf8');
  check('the worker reads the key the app writes', [/NOTE_KEY = 'reminders\.note'/.test(src), /NOTE_KEY = 'reminders\.note'/.test(readFileSync('src/domain/remindersync.ts', 'utf8'))], [true, true]);
  check('every push ends in showNotification, whatever happened before it', /if \(rings\.length === 0\) rings = \[FALLBACK\];\s+await Promise\.all\(\s+rings\.map\(\(r\) =>\s+self\.registration\.showNotification/.test(src), true);
}

section('Sync: a large push goes in batches the relay will take');
{
  // A dish as it crosses the wire, with a long name and notes, the heavy case.
  const dish = (i: number): WireRow => ({
    t: 'custom_foods', k: `dish-${i}`, at: 1_000_000 + (i % 977) * 13 + i, del: null,
    f: { slug: `dish-${i}`, name: `Home-style dish number ${i} with a longish name`, per_unit: 'g', energy_kcal: 123.4,
      protein_g: 5.6, fat_g: 7.8, carbs_g: 9.1, fibre_g: 2.3, notes: 'x'.repeat(120), share: 1 },
  });
  const many = Array.from({ length: 3000 }, (_, i) => dish(i));
  const chunks = chunkRows(many);
  const sealedBase64 = (rows: WireRow[]) => Math.ceil((new TextEncoder().encode(JSON.stringify({ v: 2, rows })).length + 28) / 3) * 4;
  check('3,000 dishes go as more than one batch', chunks.length > 1, true);
  check('every batch is under the relay\'s 512 KiB once sealed', chunks.every((c) => sealedBase64(c) < 512 * 1024), true);
  check('with room to spare', Math.max(...chunks.map(sealedBase64)) < 400 * 1024, true);
  check('nothing lost, nothing doubled', chunks.flat().map((r) => r.k).sort().join() === many.map((r) => r.k).sort().join(), true);
  const flat = chunks.flat();
  check('oldest first, so the cursor can follow each batch', flat.every((r, i) => i === 0 || flat[i - 1].at <= r.at), true);
  check('a small push is one batch', chunkRows(many.slice(0, 10)).length, 1);
  check('nothing to push, no batch', chunkRows([]).length, 0);
  const huge = { ...dish(1), f: { ...dish(1).f, notes: 'y'.repeat(CHUNK_BYTES) } };
  check('a row bigger than a batch goes alone', chunkRows([dish(2), huge, dish(3)]).map((c) => c.length).sort().join(), '1,2');
  check('the relay\'s limit is what this was sized against', /const MAX_BODY = 512 \* 1024;/.test(readFileSync('worker/index.ts', 'utf8')), true);
}

section('The overnight line: time between meals, as a fact');
{
  const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const day15 = new Date(2026, 9, 15).getTime();
  check('dinner 21:10, breakfast 09:30: 12 h 20 min overnight',
    fastLine(day15, [t(14, 21, 10), t(15, 9, 30)], t(15, 13)), { kind: 'overnight', last: t(14, 21, 10), first: t(15, 9, 30), ms: 12 * 3_600_000 + 20 * 60_000 });
  check('in words', duration(12 * 3_600_000 + 20 * 60_000), '12 h 20 min');
  check('under an hour', duration(45 * 60_000), '45 min');
  check('before the first meal today: the time since the last',
    fastLine(day15, [t(14, 21, 10)], t(15, 8, 15)), { kind: 'since', last: t(14, 21, 10), ms: 11 * 3_600_000 + 5 * 60_000 });
  // His late nights: a snack at 00:30 is the night before, not the morning.
  check('a snack at 00:30 is the night before, so the fast runs from it',
    (fastLine(day15, [t(14, 21), t(15, 0, 30), t(15, 9)], t(15, 13)) as { last: number }).last, t(15, 0, 30));
  check('and is never the first meal of the day',
    (fastLine(day15, [t(14, 21), t(15, 0, 30), t(15, 9)], t(15, 13)) as { first: number }).first, t(15, 9));
  check('over 20 hours: no number, a meal may have gone unlogged',
    fastLine(day15, [t(13, 21, 10), t(15, 12, 40)], t(15, 13)), { kind: 'gap', last: t(13, 21, 10), first: t(15, 12, 40) });
  check('20 hours exactly is still a time', fastLine(day15, [t(14, 13), t(15, 9)], t(15, 13))?.kind, 'overnight');
  check('still waiting after 20 hours: the same sentence', fastLine(day15, [t(14, 10)], t(15, 7))?.kind, 'gap');
  check('no meal before it: nothing to say', fastLine(day15, [t(15, 9)], t(15, 13)), null);
  check('a day not yet come: nothing', fastLine(new Date(2026, 9, 16).getTime(), [t(15, 21)], t(15, 22)), null);
  check('a past day with no meal of its own: nothing', fastLine(new Date(2026, 9, 13).getTime(), [t(12, 21)], t(15, 13)), null);
  check('the line\'s cut-off is his 20 hours', GAP_HOURS, 20);
}

section('Keeping the record safe: backup and sync warnings, the test ring');
{
  const DAY = 86_400_000;
  const now = new Date(2026, 9, 15, 9).getTime();
  // His numbers, 15 Oct 2026: a backup nudge after 7 days, sync amber after 7.
  check('the thresholds', [BACKUP_NUDGE_DAYS, SYNC_AMBER_DAYS, SYNC_URGENT_DAYS, RELAY_KEEP_DAYS], [7, 7, 25, 30]);
  check('the relay really keeps 30 days', /const KEEP_DAYS = 30;/.test(readFileSync('worker/index.ts', 'utf8')), true);
  check('no backup nudge on a phone with nothing on it', backupDue(null, now, false), false);
  check('a phone with records and no backup is asked', backupDue(null, now, true), true);
  check('six days is fine, seven is asked', [backupDue(now - 6 * DAY, now, true), backupDue(now - 7 * DAY, now, true)], [false, true]);
  check('sync: never, fresh, a week, nearly forgotten',
    [syncTone(null, now), syncTone(now - 6 * DAY, now), syncTone(now - 7 * DAY, now), syncTone(now - 25 * DAY, now)], ['never', 'ok', 'amber', 'urgent']);
  check('how long ago, in words',
    [ago(now - 20_000, now), ago(now - 4 * 60_000, now), ago(now - 3 * 3_600_000, now), ago(now - DAY - 3_600_000, now), ago(now - 12 * DAY, now)],
    ['just now', '4 min ago', '3 h ago', 'yesterday', '12 days ago']);
  // The test ring lands on a whole minute at least half a minute away, so
  // the relay's once-a-minute run has not already gone past it.
  const at = (h: number, m: number, sec: number) => new Date(2026, 9, 15, h, m, sec).getTime();
  check('asked at 03:41:10, rings at 03:42', testRingTime(at(3, 41, 10)), at(3, 42, 0));
  check('asked at 03:41:40, rings at 03:43', testRingTime(at(3, 41, 40)), at(3, 43, 0));
  // A list the relay already took is not sent again unless its minutes
  // changed or a day has passed (15 Oct 2026, "why waste compute").
  const r = (m: number) => ({ at: m, kind: 'meals' as const, title: 'Today’s meals', body: 'x' });
  const sig = scheduleSig('https://e/1', [r(1), r(2)]);
  check('nothing sent yet: send', needsSending(null, sig, now), true);
  check('the same minutes within a day: do not', needsSending({ sig, at: now - 3_600_000 }, sig, now), false);
  check('a day on: send anyway', needsSending({ sig, at: now - RESEND_AFTER_MS }, sig, now), true);
  check('a ring added or gone: send', needsSending({ sig, at: now - 60_000 }, scheduleSig('https://e/1', [r(1)]), now), true);
  check('another browser: send', scheduleSig('https://e/2', [r(1), r(2)]) === sig, false);
  check('words changed but not minutes: the relay need not hear, the phone rewrites its words',
    [scheduleSig('https://e/1', [{ ...r(1), body: 'y' }, r(2)]) === sig, wordsOf([{ ...r(1), body: 'y' }, r(2)]) === wordsOf([r(1), r(2)])], [true, false]);
  check('a ring marked shown is not a change of words', wordsOf([{ ...r(1), shown: true }]) === wordsOf([r(1)]), true);
  check('a test ring says so, with no medicine and no amount', [testRingAt(0).kind, /test/i.test(testRingAt(0).body), /\d/.test(testRingAt(0).body)], ['test', true, false]);
}

// ------------------------------------------------------------ the week
import { latestWeek, observations, weekData, weekDays, weekFigures, weekLabel, weekStartOf, WEEKS_BACK } from '../src/domain/week';
import { weekRings } from '../src/domain/reminders';

section('The week: Sunday to Saturday, and the latest complete one');
{
  check('every day of a week has the same Sunday', ['2026-10-11', '2026-10-14', '2026-10-17'].map(weekStartOf), ['2026-10-11', '2026-10-11', '2026-10-11']);
  check('on a Sunday the latest week is the one that ended yesterday', latestWeek('2026-10-18'), '2026-10-11');
  check('on a Saturday it is the one before, not the week still running', latestWeek('2026-10-17'), '2026-10-04');
  check('seven days, Sunday first', [weekDays('2026-10-11')[0], weekDays('2026-10-11')[6], weekDays('2026-10-11').length], ['2026-10-11', '2026-10-17', 7]);
  check('a week in one month names it once', weekLabel('2026-10-11'), 'Sun 11 – Sat 17 Oct');
  check('a week across two months names both', weekLabel('2026-09-27'), 'Sun 27 Sep – Sat 3 Oct');
  // The oldest week, its week before and the patterns' month must fit in
  // one read of the record, whose limit is 90 days (MAX_DAYS).
  check('the arrows never reach past one read of the record', 13 + 7 * (WEEKS_BACK - 1) + 25 + 1 <= MAX_DAYS, true);
}

section('The week: its figures, from the report\'s own arithmetic');
{
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const iso = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
  const dish = (name: string, kcal: number, p: number): ExportItem =>
    ({ name, quantity: 1, unit: 'piece', grams: 100, energy_kcal: kcal, protein_g: p, fat_g: 0, carbs_g: 0, fibre_g: 0, plan_state: null });
  // A day: breakfast at 09:00 and dinner at 21:00, split down the middle.
  const day = (d: number, kcal: number, p: number, dinnerAt = 21) => [
    { day: iso(d), at: at(d, 9), slot: 'Breakfast', items: [dish('Poha', kcal / 2, p / 2)] },
    { day: iso(d), at: at(d, dinnerAt), slot: 'Dinner', items: [dish('Paneer curry', kcal / 2, p / 2)] },
  ];
  const doses = (d: number, taken: number, skipped = 0, missed = 0) => ({ day: iso(d), taken, skipped, missed, pending: 0 });
  const X: ExportInput = {
    scope: 'full',
    days: Array.from({ length: 30 }, (_, i) => addDaysIso('2026-09-19', i)),
    targets: { energy_kcal: 1900, protein_g: 90, fat_g: null, carbs_g: null, fibre_g: null },
    goalWeightKg: null,
    goalBurnKcal: null,
    meals: [
      // The week before: six days, 40 g protein, never over.
      ...[4, 5, 6, 7, 8].flatMap((d) => day(d, 1800, 40)),
      // Saturday's late dinner, which ends the next Sunday's overnight gap.
      ...day(10, 1800, 40, 22.5),
      // This week: every day; protein short on four, calories over on two.
      ...[11, 12, 13, 14].flatMap((d) => day(d, 1800, 50)),
      ...[15, 16].flatMap((d) => day(d, 2100, 90)),
      ...day(17, 1800, 90),
      // Planned and never eaten: counted nowhere.
      { day: iso(17), at: at(17, 13), slot: 'Lunch', items: [{ ...dish('Biryani', 900, 30), plan_state: 'planned' }] },
    ],
    weights: [{ day: '2026-10-03', kg: 72.4 }, { day: iso(9), kg: 72.0 }, { day: iso(16), kg: 71.6 }],
    burns: [],
    medicines: [],
    doseDays: [
      ...[4, 5, 6, 7, 8, 9, 10].map((d) => (d <= 7 ? doses(d, 1, 0, 1) : doses(d, 2))),
      ...[11, 12, 14, 16, 17].map((d) => doses(d, 2)),
      doses(13, 1, 0, 1),
      doses(15, 1, 1, 0),
    ],
    notTaken: [
      ...[4, 5, 6, 7].map((d) => ({ day: iso(d), medicine: 'Iron', time: 'Morning', state: 'missed' as const })),
      { day: iso(13), medicine: 'Iron', time: 'Night', state: 'missed' },
      { day: iso(15), medicine: 'Iron', time: 'Night', state: 'skipped' },
    ],
    symptoms: [12, 14, 16].map((d) => ({ at: at(d, 15), text: 'tummy felt tight', label: 'Bloating', resolvedAt: null })),
    episodes: [],
  };
  const cur = weekFigures(X, '2026-10-11');
  const prev = weekFigures(X, '2026-10-04');

  check('days with meals logged, this week and the week before', [cur.daysLogged, prev.daysLogged], [7, 6]);
  check('averages over logged days, the planned biryani counted nowhere', [Math.round(cur.macros.energy_kcal.avg!), Math.round(cur.macros.protein_g.avg!)], [1886, 67]);
  check('protein short of its target on four days: under 76%, the dial\'s own amber', cur.macros.protein_g.short, 4);
  check('calories over the target on two days', [cur.macros.energy_kcal.over, prev.macros.energy_kcal.over], [2, 0]);
  check('calories under the target are never counted against a day', cur.macros.energy_kcal.short, 0);
  check('doses taken of those due', [cur.doses, prev.doses], [{ taken: 12, due: 14 }, { taken: 10, due: 14 }]);
  check('doses not taken, gathered by time of day', cur.notTaken, [{ time: 'Night', n: 2 }]);
  // Sunday's gap began on Saturday night, in the week before: 22:30 to 09:00.
  check('the usual overnight gap: the middle one, Sunday\'s counted from Saturday night', [cur.overnight?.ms, cur.overnight?.nights], [12 * 3_600_000, 7]);
  check('the week\'s last weight, and the last one before it began', [cur.weight.last, cur.weight.before], [{ day: iso(16), kg: 71.6 }, { day: iso(9), kg: 72.0 }]);
  check('no fast-loss signal from a slow change', cur.weight.fastLoss, false);
  check('the fast-loss signal, from readings four to six weeks apart',
    weekFigures({ ...X, weights: [{ day: '2026-09-12', kg: 80 }, ...X.weights] }, '2026-10-11').weight.fastLoss, true);
  check('symptoms by bouts, and too few in the month to call a pattern', cur.symptoms.map((s) => [s.label, s.bouts, s.few]), [['Bloating', 3, true]]);
  check('a week with nothing logged says so', weekFigures({ ...X, meals: [], doseDays: [], weights: [], symptoms: [] }, '2026-10-11').any, false);

  section('The week: what the app counts as better, and as something to work on');
  const obs = observations(cur, prev);
  check('better: nearer the targets, more doses, more days logged; nothing else',
    obs.filter((o) => o.kind === 'better').map((o) => o.what),
    ['protein average went up, towards the target', 'more of the doses due were taken', 'meals logged on more days']);
  check('to work on: against the person\'s own targets, and doses not taken',
    obs.filter((o) => o.kind === 'work_on').map((o) => o.what),
    ['protein short of the target on most logged days', 'over the calorie target on some days', 'doses not taken']);
  check('fewer days logged is never something to work on',
    observations(prev, cur).some((o) => /meals logged|days logged/.test(o.what) && o.kind === 'work_on'), false);
  check('one short day of seven is not something to work on',
    observations({ ...cur, macros: { ...cur.macros, protein_g: { ...cur.macros.protein_g, short: 1 } } }, prev).some((o) => /protein short/.test(o.what)), false);
  const lean = { ...cur, macros: { ...cur.macros, energy_kcal: { ...cur.macros.energy_kcal, avg: 1100, over: 0, short: 7 } } };
  check('a week of low calories is neither better nor to work on', observations(lean, prev).some((o) => /calorie/.test(o.what)), false);
  check('nothing better against a week with nothing in it', observations(cur, { ...prev, any: false }).some((o) => o.kind === 'better'), false);

  const data = JSON.stringify(weekData(cur, prev));
  check('the model is sent no weight, no overnight gap and no symptom', [/kg|weight|overnight|bloating/i.test(data), /71\.6|72\.0/.test(data)], [false, false]);
  check('the model is sent both weeks and both lists', ['this_week', 'week_before', '"better"', '"to_work_on"', 'Sun 11'].map((k) => data.includes(k)), [true, true, true, true, true]);
}

section('The week: the Sunday ring');
{
  const on: ReminderSettings = { ...DEFAULT_REMINDERS, on: true, profileId: 'primary' };
  const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).getTime();
  const days = scheduleDays('2026-10-15');
  check('on each Sunday of the fortnight, at 10:00', weekRings(days, on, at(15, 12)).map((r) => r.at), [at(18, 10), at(25, 10)]);
  check('not once its minute has passed', weekRings(days, on, at(18, 10, 0, 1)).map((r) => r.at), [at(25, 10)]);
  check('switched off: none', weekRings(days, { ...on, week: false }, at(15, 12)), []);
  check('at the time chosen', weekRings(days, { ...on, weekTime: '19:30' }, at(15, 12))[0].at, at(18, 19, 30));
  const ring = weekRings(days, on, at(15, 12))[0];
  check('its own kind, and no figure on the lock screen', [ring.kind, /\d/.test(ring.title + ring.body)], ['week', false]);
  check('on unless turned off, at 10:00 unless changed', [readSettings({}).week, readSettings({}).weekTime, readSettings({ week: false, weekTime: '25:00' }).week, readSettings({ weekTime: '25:00' }).weekTime], [true, '10:00', false, '10:00']);
}

function addDaysIso(isoDay: string, n: number): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ done

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// --------------------------------------------------- text parsing
