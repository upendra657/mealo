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

// FoodData Central nutrient ids for the five values we store.
const NUTRIENTS = {
  energy_kcal: ['1008', '2047', '2048'], // Energy (kcal), variants
  protein_g: ['1003'],
  fat_g: ['1004'],
  carbs_g: ['1005'],
  fibre_g: ['1079'],
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

const byFdcId = new Map();
for (const n of nutrients) {
  const key = wanted.get(n.nutrient_id);
  if (!key) continue;
  const value = Number(n.amount);
  if (!Number.isFinite(value)) continue;
  const row = byFdcId.get(n.fdc_id) ?? {};
  // Keep the first value seen for a key; the id lists are ordered by preference.
  if (row[key] === undefined) row[key] = value;
  byFdcId.set(n.fdc_id, row);
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
console.log('[foods] restart the dev server; the app reseeds when the count changes.');
