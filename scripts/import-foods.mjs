/**
 * Build the bundled food reference table from USDA FoodData Central.
 *
 * FoodData Central is US federal data and therefore public domain, which is why
 * it is the default source — it can be redistributed inside an MIT project
 * without conditions. Note that the `ifct2017` npm package is AGPL-3.0 and
 * would relicense this whole app, so it is deliberately not used.
 *
 * Usage:
 *   1. Download a dataset from https://fdc.nal.usda.gov/download-datasets
 *      "Foundation Foods" (small, high quality) or "SR Legacy" (broader).
 *      Pick the CSV form and unzip it.
 *   2. node scripts/import-foods.mjs <path-to-unzipped-dir>
 *
 * Writes src/data/foods.json, which the app seeds into SQLite on first run.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'src/data/foods.json');

// FoodData Central nutrient ids for the five values we store, each list in
// order of preference.
//
// Energy. USDA publishes up to three figures for a food: 2048, worked out
// with Atwater factors specific to that kind of food; 2047, with the general
// 4-9-4 factors; and 1008, plain "Energy", on records that carry neither.
// Read from USDA's record for each of the 329 bundled ids on 11 Oct 2026:
// 256 foods have 2047 and 2048, 33 have 2047 alone, 40 have 1008 alone. The
// two Atwater figures are 5% or more apart for 134 foods (baby spinach 21
// against 27; Brazil nuts 621 against 664). The specific figure is used
// wherever USDA gives one, Upendra's decision the same day, so that one rule
// covers the table.
//
// Fibre. 1079 is "Fiber, total dietary"; 2033 is the same thing by the newer
// method (AOAC 2011.25), and for 17 of the 329, canned beans among them, it
// is the only fibre figure there is. 1079 stays first because 145 foods have
// it alone and the 17 that have both should not switch method.
const NUTRIENTS = {
  energy_kcal: ['2048', '2047', '1008'],
  protein_g: ['1003'],
  fat_g: ['1004'],
  carbs_g: ['1005'],
  fibre_g: ['1079', '2033'],
};

/** Minimal CSV reader — handles quoted fields and embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length >= header.length - 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const dir = process.argv[2];
if (!dir) {
  console.error(
    'Usage: node scripts/import-foods.mjs <path-to-unzipped-usda-csv-dir>\n' +
      'Download from https://fdc.nal.usda.gov/download-datasets',
  );
  process.exit(1);
}

/**
 * Find a CSV anywhere under the given path, up to three levels deep.
 *
 * USDA's archives are inconsistent: sometimes the CSVs sit at the root of the
 * extracted folder, sometimes one directory further in. Searching is cheaper
 * than making anyone work out which.
 */
async function locate(root, filename, depth = 3) {
  const direct = join(root, filename);
  if (existsSync(direct)) return direct;
  if (depth === 0) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await locate(join(root, e.name), filename, depth - 1);
    if (found) return found;
  }
  return null;
}

if (!existsSync(dir)) {
  console.error(
    `${dir} does not exist.\n` +
      'Download a CSV dataset from https://fdc.nal.usda.gov/download-datasets ' +
      'and unzip it first.',
  );
  process.exit(1);
}

const foodCsv = await locate(dir, 'food.csv');
const nutrientCsv = await locate(dir, 'food_nutrient.csv');

if (!foodCsv || !nutrientCsv) {
  console.error(
    `Could not find food.csv and food_nutrient.csv under ${dir}.\n\n` +
      'Check that you downloaded a **CSV** dataset rather than the JSON or\n' +
      'Access versions, and that it is unzipped. What is actually in there:\n',
  );
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      console.error(`  ${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`);
    }
  } catch {
    console.error('  (could not read the directory)');
  }
  process.exit(1);
}

console.log(`[foods] using ${foodCsv}`);

console.log('[foods] reading food.csv …');
const foods = parseCsv(await readFile(foodCsv, 'utf8'));

console.log('[foods] reading food_nutrient.csv (this one is large) …');
const nutrients = parseCsv(await readFile(nutrientCsv, 'utf8'));

const wanted = new Map();
for (const [key, ids] of Object.entries(NUTRIENTS)) {
  for (const id of ids) wanted.set(id, key);
}

// Every wanted figure is collected first and the choice made afterwards.
//
// This used to keep the first value it met for a key, under a comment saying
// the id lists were ordered by preference. They were, and the loop never
// consulted the order: it took whichever row came first in USDA's file. So
// the bundled calories were the specific figure for 181 foods and the general
// one for 66, by accident of file order (found 11 Oct 2026).
const seenById = new Map();
for (const n of nutrients) {
  if (!wanted.has(n.nutrient_id)) continue;
  // An empty amount is a missing figure, and Number('') is 0.
  if (n.amount === undefined || n.amount.trim() === '') continue;
  const value = Number(n.amount);
  if (!Number.isFinite(value)) continue;
  const figures = seenById.get(n.fdc_id) ?? new Map();
  if (!figures.has(n.nutrient_id)) figures.set(n.nutrient_id, value);
  seenById.set(n.fdc_id, figures);
}

const byFdcId = new Map();
for (const [fdcId, figures] of seenById) {
  const row = {};
  for (const [key, ids] of Object.entries(NUTRIENTS)) {
    const id = ids.find((i) => figures.has(i));
    if (id !== undefined) row[key] = figures.get(id);
  }
  byFdcId.set(fdcId, row);
}

// Lab values carry absurd precision - 602.510076 kcal per 100g implies a
// certainty nobody has about a spoonful of almond butter. Round to something
// honest, which also shrinks the bundle.
const r1 = (v) => (v === undefined || v === null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === undefined || v === null ? null : Math.round(v * 100) / 100);

const out = [];
const seen = new Set();
for (const f of foods) {
  const macros = byFdcId.get(f.fdc_id);
  if (!macros || macros.energy_kcal === undefined) continue;
  const name = (f.description || '').trim();
  if (!name) continue;
  // USDA ships the same description under several ids; keep the first.
  const key = name.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({
    id: `usda-${f.fdc_id}`,
    name,
    source_db: 'USDA',
    per_unit: '100g',
    energy_kcal: r1(macros.energy_kcal),
    protein_g: r2(macros.protein_g),
    fat_g: r2(macros.fat_g),
    carbs_g: r2(macros.carbs_g),
    fibre_g: r2(macros.fibre_g),
  });
}

out.sort((a, b) => a.name.localeCompare(b.name));

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(out));

const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`[foods] wrote ${out.length} foods to src/data/foods.json (${kb} KB)`);
console.log('[foods] the app compares its table with this file at every start and rewrites it when they differ.');
