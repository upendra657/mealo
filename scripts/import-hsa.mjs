/**
 * Fetches Singapore's HSA Listing of Registered Therapeutic Products from
 * data.gov.sg and writes the four columns the app uses to src/data/hsa.json.
 *
 *   node scripts/import-hsa.mjs
 *
 * HSA refreshes the listing about every six months. Run this then, commit the
 * file, and every phone reloads the list on its next start (ensureBuiltins
 * compares `version`).
 *
 * Bundled, unlike an imported list, because it is official and openly
 * licensed: "Free forever for personal or commercial use" under the Singapore
 * Open Data Licence, which asks only for attribution — carried in the file and
 * shown on every suggestion it makes.
 */

import { writeFileSync } from 'node:fs';

const DATASET = 'd_767279312753558cbf19d48344577084';
const SEARCH = 'https://data.gov.sg/api/action/datastore_search';
const META = `https://api-production.data.gov.sg/v2/public/api/datasets/${DATASET}/metadata`;
const COLUMNS = ['Productname', 'Activeingredients', 'Strength', 'Dosageform'];

async function json(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    // data.gov.sg rate-limits bursts; wait and ask again rather than fail.
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`${res.status} from ${url}`);
  }
}

const rows = [];
let total = Infinity;
for (let offset = 0; offset < total; offset += 1000) {
  const page = await json(`${SEARCH}?resource_id=${DATASET}&limit=1000&offset=${offset}`);
  if (!page.success) throw new Error(JSON.stringify(page.error ?? page));
  total = page.result.total;
  for (const r of page.result.records) rows.push(COLUMNS.map((c) => (r[c] ?? '').toString()));
}
if (rows.length !== total) throw new Error(`expected ${total} rows, got ${rows.length}`);

let version = new Date().toISOString().slice(0, 10);
try {
  const meta = await json(META);
  const updated = meta?.data?.lastUpdatedAt ?? meta?.data?.metadata?.lastUpdatedAt;
  if (updated) version = String(updated).slice(0, 10);
} catch {
  /* the fetch date stands in for the dataset's own */
}

const out = {
  source: `https://data.gov.sg/datasets/${DATASET}/view`,
  licence: 'Singapore Open Data Licence · Health Sciences Authority',
  version,
  fetched: new Date().toISOString().slice(0, 10),
  header: COLUMNS,
  rows,
};
writeFileSync(new URL('../src/data/hsa.json', import.meta.url), JSON.stringify(out));
console.log(`hsa.json: ${rows.length} products, version ${version}`);
