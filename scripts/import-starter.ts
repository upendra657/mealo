/**
 * The starter food list: vegetarian Indian dishes for someone's first day,
 * built from two published sources and nothing typed by hand but names.
 *
 *   npx esbuild scripts/import-starter.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/import-starter.mjs && \
 *   node node_modules/.cache/import-starter.mjs <sources dir> <out.json>
 *
 * <sources dir> holds the original files, kept outside the repo
 * (../Mealo-Resources/data/sources, with a README naming each):
 *
 *   CoFID-2021.xlsx   UK, McCance and Widdowson's Composition of Foods
 *                     Integrated Dataset 2021. Open Government Licence v3.0.
 *   INDB*.xlsx        Indian Nutrient Databank (Vijayakumar et al., Curr Dev
 *                     Nutr 2024). No licence stated; Upendra's call, 15 Oct
 *                     2026: acceptable "as long as the data is clear and
 *                     accurate".
 *
 * Why two, and which for what (decided 15 Oct 2026 after a search of what
 * exists; Approved Ideas.md has the comparison):
 *
 *   CoFID for North Indian and everyday dishes, per 100 g of the dish as
 *   eaten, so a weighed katori works as the app is built to. Some are
 *   measured in a laboratory (University of Leeds, 2007); the rest are
 *   recipes the UK's databank calculated with cooking losses.
 *
 *   INDB for the South Indian dishes CoFID lacks, by the piece or serving
 *   only. Its "per 100 g" is per 100 g of the raw ingredients, water
 *   included (INDB.do, lines 235-265), so a weighed cooked dish would read
 *   low; a serving is the recipe divided by its servings, which no cooking
 *   loss changes.
 *
 * Carbohydrate is converted to Mealo's convention, fibre included (his "Yes",
 * 15 Oct): 59 of his 63 dishes fit 4P + 9F + 4C with fibre inside C, and the
 * USDA rows use "carbohydrate by difference". CoFID and IFCT both leave fibre
 * out. CoFID also counts starch as monosaccharide equivalents (x1.1; its
 * carbohydrate column is exactly starch + sugars), so starch is divided back.
 * Calories are kept as each source published them and never recalculated.
 *
 * Fibre: CoFID's AOAC figure where it has one; else its older NSP figure,
 * which reads lower, marked so (his choice "a"); else none, marked "not
 * known" (his choice: keep and show). INDB's is IFCT total dietary fibre.
 *
 * Two kinds of INDB recipe are refused, with the reason, because their
 * figures are wrong in the source: deep- or shallow-frying oil entered as
 * 240-480 ml and counted as eaten (masala vada at 2,228 kcal a vada), and
 * coconut grated for its milk and counted whole (appam). A chosen code that
 * breaks either rule, or that holds meat, fish, egg, gelatine or meat stock,
 * or an ingredient from outside IFCT, stops the build.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readXlsx } from '../src/lib/xlsx';

type Style = string | null;
type Row = {
  id: string;
  name: string;
  source_db: 'CoFID 2021' | 'INDB 2024';
  /** '100g' for CoFID; one serving unit for INDB ("1 idli"). */
  per_unit: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  /** Fibre included, Mealo's convention. */
  carbs_g: number | null;
  fibre_g: number | null;
  /** What the person can check the figure against. */
  source_name: string;
  source_code: string;
  method: string;
  fibre_method: 'total dietary fibre' | 'NSP, older method, reads low' | 'not known';
  weighable: boolean;
  style: Style;
  note: string | null;
};

// ------------------------------------------------------------------ CoFID
// [code, name shown, style]. Names put the Indian word first and keep what
// CoFID says it is; nothing is renamed into a dish CoFID does not describe.
const COFID: [string, string, Style][] = [
  // Dals and legume curries
  ['13-484', 'Mixed dal', null],
  ['12-468', 'Urad dal', null],
  ['12-467', 'Sambar', 'South Indian'],
  ['15-762', 'Masoor dal, thick', 'Punjabi'],
  ['15-758', 'Masoor dal with tomato, thick', 'Punjabi'],
  ['15-759', 'Masoor dal with tomato, thin, with butter', null],
  ['15-760', 'Masoor dal with tomato, thin, with vegetable oil', null],
  ['15-763', 'Masoor dal, thin, with butter', 'Bangladeshi'],
  ['15-764', 'Masoor dal, thin, with vegetable oil', 'Bangladeshi'],
  ['15-757', 'Masoor and moong dal, thin', null],
  ['15-125', 'Masoor and moong dal with tomato', 'Punjabi'],
  ['15-765', 'Whole masoor curry', 'Gujarati'],
  ['15-766', 'Whole masoor curry', 'Punjabi'],
  ['15-768', 'Moong dal, thin', 'Bengali'],
  ['15-132', 'Moong dal with tomato', 'Punjabi'],
  ['15-767', 'Moong dal with spinach', 'Gujarati'],
  ['15-771', 'Whole moong curry', 'Gujarati'],
  ['15-490', 'Whole moong curry', 'Punjabi'],
  ['15-769', 'Whole moong with turnip greens', null],
  ['15-777', 'Toor dal with tomato, thin', null],
  ['15-778', 'Toor dal with tomato and peanuts', 'Gujarati'],
  ['15-779', 'Toor dal, with butter', null],
  ['15-780', 'Toor dal, with vegetable oil', null],
  ['15-641', 'Chana dal with tomato', 'Punjabi'],
  ['15-742', 'Chana dal with spinach, with butter', null],
  ['15-743', 'Chana dal with spinach, with vegetable oil', null],
  ['15-735', 'Whole urad and rajma curry', null],
  ['15-736', 'Whole urad curry', 'Bengali'],
  ['15-737', 'Whole urad curry', 'Gujarati'],
  ['15-146', 'Rajma', 'Punjabi'],
  ['15-785', 'Rajma', 'Gujarati'],
  ['15-784', 'Rajma and whole moong curry', null],
  ['15-108', 'Chole (chickpeas with tomato), with vegetable oil', 'Punjabi'],
  ['15-107', 'Chole (chickpeas with tomato), with butter', 'Punjabi'],
  ['15-747', 'Chole (chickpeas with tomato), with vegetable oil', 'Gujarati'],
  ['15-746', 'Chole (chickpeas with tomato), with ghee', 'Gujarati'],
  ['15-744', 'Whole chickpea curry', 'Gujarati'],
  ['15-745', 'Chickpea and potato curry', null],
  ['15-738', 'Lobia (black-eyed bean) curry', null],
  ['15-095', 'Lobia (black-eyed bean) curry', 'Punjabi'],
  ['15-511', 'Dal dhokli', 'Gujarati'],
  // Vegetable dishes. CoFID's "bhaji" is a dry sabzi, not a fritter.
  ['15-628', 'Methi aloo', null],
  ['15-629', 'Saag (spinach curry)', null],
  ['15-627', 'Bhindi sabzi', null],
  ['15-626', 'Tinda sabzi', null],
  ['15-625', 'Tori ki sabzi', null],
  ['15-621', 'Mixed vegetable sabzi with onion and tomato', null],
  ['15-669', 'Aloo baingan sabzi', null],
  ['15-670', 'Baingan, matar, aloo and gobi sabzi', 'Gujarati'],
  ['15-671', 'Patta gobhi sabzi', null],
  ['15-672', 'Patta gobhi matar sabzi, with ghee', 'Bangladeshi'],
  ['15-673', 'Patta gobhi matar sabzi, with rapeseed oil', 'Bangladeshi'],
  ['15-674', 'Patta gobhi aloo sabzi, with butter', 'Punjabi'],
  ['15-397', 'Patta gobhi aloo sabzi, with rapeseed oil', 'Punjabi'],
  ['15-675', 'Patta gobhi aloo sabzi, with vegetable oil', 'Punjabi'],
  ['15-016', 'Patta gobhi and palak sabzi with besan', 'Punjabi'],
  ['15-740', 'Patta gobhi masala', null],
  ['15-676', 'Gajar aloo matar sabzi, with butter', 'Punjabi'],
  ['15-677', 'Gajar aloo matar sabzi, with vegetable oil', 'Punjabi'],
  ['15-678', 'Gobi sabzi', null],
  ['15-680', 'Gobi with onion and tomato', null],
  ['15-679', 'Aloo gobi sabzi', 'Bangladeshi'],
  ['15-741', 'Aloo gobi curry', 'Gujarati'],
  ['15-021', 'Aloo gobi matar sabzi, with butter', 'Punjabi'],
  ['15-022', 'Aloo gobi matar sabzi, with vegetable oil', 'Punjabi'],
  ['15-024', 'Green beans sabzi', 'Punjabi'],
  ['15-755', 'Green beans masala', 'Gujarati'],
  ['15-025', 'Karela sabzi, with ghee', null],
  ['15-026', 'Karela sabzi, with vegetable oil', null],
  ['15-756', 'Karela curry', null],
  ['15-681', 'Mushroom sabzi', null],
  ['15-682', 'Sarson saag (mustard greens)', null],
  ['15-683', 'Sarson and palak saag', null],
  ['15-694', 'Palak sabzi', null],
  ['15-695', 'Palak aloo sabzi', null],
  ['15-787', 'Palak aloo masala (frozen spinach)', null],
  ['15-040', 'Aloo, palak and gobi sabzi', null],
  ['15-684', 'Bhindi sabzi, with ghee', 'Bangladeshi'],
  ['15-685', 'Bhindi sabzi, with vegetable oil', 'Bangladeshi'],
  ['15-686', 'Bhindi sabzi, very dry', 'Ismaili'],
  ['15-687', 'Matar sabzi', 'Pakistani'],
  ['15-688', 'Aloo methi sabzi', 'Gujarati'],
  ['15-689', 'Aloo shimla mirch sabzi', 'Punjabi'],
  ['15-690', 'Aloo pyaz sabzi', 'Bangladeshi'],
  ['15-691', 'Aloo, pyaz and mushroom sabzi', null],
  ['15-692', 'Aloo sabzi, with ghee', null],
  ['15-693', 'Aloo sabzi, with vegetable oil', null],
  ['15-782', 'Aloo curry', 'Gujarati'],
  ['15-783', 'Aloo curry', 'Punjabi'],
  ['15-739', 'Bombay aloo', null],
  ['15-776', 'Matar aloo curry (canned peas)', null],
  ['15-781', 'Aloo matar curry', 'Bangladeshi'],
  ['15-749', 'Courgette aloo curry', 'Punjabi'],
  ['15-788', 'Tinda aloo curry', 'Punjabi'],
  ['15-774', 'Lauki kofta curry', 'Gujarati'],
  ['15-696', 'Shalgam (turnip) sabzi', null],
  ['15-697', 'Shalgam pyaz (turnip and onion) sabzi', 'Punjabi'],
  ['15-047', 'Mixed vegetable sabzi, with butter', 'Punjabi'],
  ['15-048', 'Mixed vegetable sabzi, with vegetable oil', 'Punjabi'],
  ['15-698', 'Mixed vegetable sabzi, with butter', null],
  ['15-699', 'Mixed vegetable sabzi, with rapeseed oil', null],
  ['15-791', 'Mixed vegetable curry', 'Ismaili'],
  ['15-792', 'Mixed vegetable curry with coconut', 'Pakistani'],
  ['15-731', 'Almond curry', null],
  ['15-513', 'Dosa filling, vegetable', 'South Indian'],
  // Breads and rice
  ['11-459', 'Chapati, made without fat', null],
  ['11-1104', 'Paratha', null],
  ['11-912', 'Mooli paratha', null],
  ['11-911', 'Puri', null],
  ['11-910', 'Peshwari naan (UK takeaway and shop)', null],
  ['11-968', 'Plain pulao', null],
  ['12-472', 'Vegetable pulao', null],
  ['15-846', 'Mushroom pulao', null],
  // Snacks
  ['11-1101', 'Pakoras', null],
  ['15-828', 'Onion pakora', null],
  ['15-831', 'Aloo pakora', null],
  ['15-827', 'Gobi pakora', null],
  ['15-826', 'Baingan pakora', null],
  ['15-832', 'Palak pakora', null],
  ['15-829', 'Aloo gobi pakora', null],
  ['15-830', 'Aloo, gajar and matar pakora', null],
  ['15-620', 'Vegetable pakora (UK takeaway)', null],
  ['15-305', 'Vegetable samosa (UK shop-bought)', null],
  ['11-998', 'Papad, fried (UK takeaway)', null],
  ['17-782', 'Chevda', null],
  // With the meal
  ['17-832', 'Raita', null],
  ['12-595', 'Besan raita (yogurt and gram flour)', null],
  ['17-785', 'Tomato chutney', null],
  ['12-495', 'Paneer', null],
  ['17-640', 'Ghee', null],
  ['12-373', 'Sweet lassi', null],
  // Sweets
  ['11-913', 'Gajar halwa', null],
  ['11-915', 'Seviyan kheer', null],
  ['12-606', 'Kulfi', null],
  ['11-1105', 'Pinni', 'Punjabi'],
  ['11-1081', 'Gulab jamun', null],
  ['11-916', 'Cake rusk', null],
];

// ------------------------------------------------------------------- INDB
// [code, name shown, the unit a serving is counted in]. South Indian only;
// CoFID's measured sambar stands for sambar.
const INDB: [string, string, string][] = [
  ['ASC144', 'Idli', 'idli'],
  ['BFP579', 'Rava idli', 'idli'],
  ['BFP147', 'Instant rava idli', 'idli'],
  ['BFP148', 'Plain dosa', 'dosa'],
  ['ASC146', 'Masala dosa', 'dosa'],
  ['BFP150', 'Masala dosa, mixed vegetable filling', 'dosa'],
  ['BFP151', 'Masala dosa, paneer filling', 'dosa'],
  ['ASC147', 'Rava dosa', 'dosa'],
  ['OSR151', 'Jowar dosa', 'dosa'],
  ['OSR103', 'Pesarattu (moong dosa)', 'pesarattu'],
  ['BFP152', 'Uttapam', 'uttapam'],
  ['BFP039', 'Rava upma', 'bowl'],
  ['BFP040', 'Semiya upma', 'bowl'],
  ['BFP041', 'Rice upma', 'bowl'],
  ['BFP043', 'Vegetable upma', 'plate'],
  ['BFP578', 'Sprouts upma', 'plate'],
  ['ASC124', 'Lemon rice (chitranna)', 'plate'],
  ['ASC126', 'Curd rice (thayir sadam)', 'plate'],
  ['ASC127', 'Tamarind rice (puliyodharai)', 'plate'],
  ['BFP132', 'Vangi bath (brinjal rice)', 'plate'],
  ['BFP176', 'Rasam with tamarind', 'curry bowl'],
  ['BFP177', 'Rasam with lemon', 'curry bowl'],
  ['ASC179', 'Beans thoran', 'bowl'],
  ['ASC180', 'Cauliflower with coconut', 'bowl'],
  ['ASC181', 'Cabbage and carrot with coconut', 'bowl'],
  ['ASC183', 'Raw papaya thoran', 'bowl'],
  ['BFP241', 'Vegetable curry with coconut', 'bowl'],
  ['ASC386', 'Coconut chutney', 'tablespoon'],
  ['ASC385', 'Peanut chutney', 'tablespoon'],
  ['BFP448', 'Gunpowder (podi)', 'tablespoon'],
  ['OSR014', 'Kesari bath', 'bowl'],
  ['OSR013', 'Apple sago payasam', 'bowl'],
];

/**
 * Recipes left out, and why, for the review page. Checked by the build like
 * the chosen ones: a refused code that the rules would not refuse is named.
 */
const REFUSED: [string, string][] = [
  ['ASC167', 'Sambar: CoFID\'s is measured in a laboratory and stands instead.'],
  ['BFP153', 'Appam: 500 g of coconut, grated for its milk, counted as eaten.'],
  ['OSR110', 'Banana appam: deep-frying oil counted as eaten.'],
  ['ASC148', 'Onion tomato uttapam: "oil for frying" entered as 240 ml and counted as eaten.'],
  ['BFP436', 'Medu vada: deep-frying oil counted as eaten.'],
  ['BFP437', 'Masala urad dal vada: deep-frying oil counted as eaten.'],
  ['ASC378', 'Masala vada: deep-frying oil counted as eaten.'],
  ['ASC360', 'Aloo bonda: deep-frying oil counted as eaten.'],
  ['OSR113', 'Rice murukku: frying oil ("oil for fryng") counted as eaten.'],
  ['BFP042', 'Bread upma: made with UK bread figures, not Indian ones.'],
  ['ASC219', 'Avial: its grated coconut is figured as dried coconut, about 12 g more fat a bowl than fresh.'],
  ['OSR105', 'Puttu: its coconut is figured as dried; puttu is layered with fresh.'],
  ['BFP450', 'Dry coconut chutney: its desiccated coconut is figured as fresh, so it reads low.'],
];

const FRYING = /fr[yi]i?ng|deep[- ]?fr/i;
/**
 * Frying oil at or past this is a deep-fry's pot, not oil eaten. The
 * refused recipes enter 240 to 480 ml; the most a kept one enters is 2 tbsp.
 */
const FRYING_LIMIT_ML = 100;
const ML: Record<string, number> = { ml: 1, g: 1, tsp: 5, tbsp: 15, C: 240 };
/** An INDB ingredient's coded amount in ml (oil: grams taken as ml), or null when its unit is not one of those. */
function millilitres(r: Record<string, string>): number | null {
  const n = Number(r['amount']);
  const per = ML[r['unit']];
  return Number.isFinite(n) && per ? n * per : null;
}
const NONVEG = /^[M-S]\d/;
const ANIMAL = /^gelatine?$|stock cubes, chicken/i;

// ----------------------------------------------------------------- reading

const dir = process.argv[2];
const out = process.argv[3];
if (!dir || !out) {
  console.error('Usage: node import-starter.mjs <sources dir> <out.json>');
  process.exit(1);
}
const xlsx = (file: string, sheet?: string) => readXlsx(new Uint8Array(readFileSync(join(dir, file))), sheet);
const table = (rows: string[][]) => {
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
};

/** A CoFID cell: "Tr" is a trace, counted as nothing; "N" and blank are not known. */
function cofidNumber(v: string | undefined): number | null {
  if (v === undefined || v === '' || v === 'N') return null;
  if (v === 'Tr') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`CoFID value not a number: "${v}"`);
  return n;
}
const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const tenth = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const whole = (n: number | null) => (n === null ? null : Math.round(n));

const rows: Row[] = [];

// CoFID's proximates sheet has two lines under its header (units, then a
// blank); only lines with a food code are foods.
const cofid = new Map(table(xlsx('CoFID-2021.xlsx', '1.3 Proximates')).filter((r) => /^\d{2}-\d+$/.test(r['Food Code'])).map((r) => [r['Food Code'], r]));
for (const [code, name, style] of COFID) {
  const r = cofid.get(code);
  if (!r) throw new Error(`CoFID has no food ${code} (${name})`);
  const starch = cofidNumber(r['Starch (g)']);
  const sugars = cofidNumber(r['Total sugars (g)']);
  const carbMono = cofidNumber(r['Carbohydrate (g)']);
  const aoac = cofidNumber(r['AOAC fibre (g)']);
  const nsp = cofidNumber(r['NSP (g)']);
  const fibre = aoac ?? nsp;
  const fibreMethod: Row['fibre_method'] = aoac !== null ? 'total dietary fibre' : nsp !== null ? 'NSP, older method, reads low' : 'not known';
  // Starch back from monosaccharide equivalents; sugars stay as published.
  const available = starch !== null && sugars !== null ? starch / 1.1 + sugars : carbMono;
  const carbs = available === null ? null : available + (fibre ?? 0);
  const notes = [
    starch === null || sugars === null ? 'Carbohydrate as CoFID gives it: starch and sugars are not separated for this dish.' : null,
    fibre === null ? 'Carbohydrate without fibre: CoFID has no fibre figure for this dish.' : null,
  ].filter(Boolean);
  const description = r['Description'];
  const measured = /\b(\d+) samples\b/i.exec(description);
  rows.push({
    id: `cofid-${code}`,
    // The style is part of the name: two "Rajma" rows in a search, told
    // apart only on a detail screen, would be logged as the wrong one.
    name: style ? `${name} (${style})` : name,
    source_db: 'CoFID 2021',
    per_unit: '100g',
    energy_kcal: whole(cofidNumber(r['Energy (kcal) (kcal)'])),
    protein_g: tenth(cofidNumber(r['Protein (g)'])),
    fat_g: tenth(cofidNumber(r['Fat (g)'])),
    carbs_g: tenth(carbs),
    fibre_g: tenth(fibre),
    source_name: r['Food Name'],
    source_code: code,
    method: measured ? `Measured in a laboratory, ${measured[1]} samples` : 'Calculated from a recipe',
    fibre_method: fibreMethod,
    weighable: true,
    style,
    note: notes.length ? notes.join(' ') : null,
  });
}

const indb = new Map(table(xlsx('INDB.xlsx')).map((r) => [r['food_code'], r]));
const recipes = table(xlsx('INDB-recipes.xlsx'));
const servings = new Map(table(xlsx('INDB-recipes_servingsize.xlsx')).map((r) => [r['recipe_code'], r]));
const ingredients = (code: string) => recipes.filter((r) => r['recipe_code'] === code);

/** Why a recipe's figures cannot be used, or null. */
function refusal(code: string): string | null {
  const ing = ingredients(code);
  if (ing.length === 0) return 'no ingredients listed';
  const said = (r: Record<string, string>) => `${r['ingredient_name_org']} ${r['amount_org']} ${r['unit_org']}`;
  // A pan's worth, entered as such (masala dosa: "oil for frying", 2 tbsp),
  // is an assumption and is said on the page; a pot's worth counted as
  // eaten is the error.
  if (ing.some((r) => FRYING.test(said(r)) && (millilitres(r) ?? Infinity) >= FRYING_LIMIT_ML)) return 'frying oil counted as eaten';
  if (ing.some((r) => NONVEG.test(r['food_code']) || ANIMAL.test(r['food_name']))) return 'not vegetarian';
  if (ing.some((r) => r['food_code'] && !/^[A-T]\d/.test(r['food_code']))) return 'an ingredient from outside IFCT';
  // IFCT H006 is dried coconut, H007 fresh. Matched against what the
  // recipe's own words say, the figure is for a different food (avial's
  // "grated coconut" as dried: 29.9 g of fat a bowl, where fresh gives
  // about 18). Words that say neither are taken as fresh: a South Indian
  // kitchen grates coconut fresh, and dried is always named as such.
  for (const r of ing) {
    if (!/coconut/i.test(r['ingredient_name_org']) || /oil|milk|cream/i.test(r['ingredient_name_org'])) continue;
    const saysDry = /dry|dried|desiccated|dessicated|copra/i.test(r['ingredient_name_org']);
    if (r['food_code'] === 'H006' && !saysDry) return 'coconut figured as dried where the recipe uses fresh';
    if (r['food_code'] === 'H007' && saysDry) return 'dried coconut figured as fresh';
  }
  const coconut = ing.find((r) => /coconut/i.test(r['ingredient_name_org']) && /grated|scraped|fresh/i.test(r['ingredient_name_org']));
  if (coconut && Number(coconut['amount']) >= 200) return 'coconut grated for its milk counted as eaten';
  return null;
}

for (const [code, name, unit] of INDB) {
  const r = indb.get(code);
  if (!r) throw new Error(`INDB has no recipe ${code} (${name})`);
  const why = refusal(code);
  if (why) throw new Error(`${code} ${name}: ${why}`);
  const s = servings.get(code);
  if (!s || num(r['unit_serving_energy_kcal']) === null) throw new Error(`${code} ${name}: no serving size`);
  if (s['servings_unit'] !== unit) throw new Error(`${code} ${name}: INDB counts servings in "${s['servings_unit']}", not "${unit}"`);
  const carb = num(r['unit_serving_carb_g']);
  const fibre = num(r['unit_serving_fibre_g']);
  rows.push({
    id: `indb-${code}`,
    name,
    source_db: 'INDB 2024',
    per_unit: `1 ${unit}`,
    energy_kcal: whole(num(r['unit_serving_energy_kcal'])),
    protein_g: tenth(num(r['unit_serving_protein_g'])),
    fat_g: tenth(num(r['unit_serving_fat_g'])),
    carbs_g: tenth(carb === null ? null : carb + (fibre ?? 0)),
    fibre_g: tenth(fibre),
    source_name: r['food_name'],
    source_code: code,
    method: 'Calculated from a recipe',
    fibre_method: fibre === null ? 'not known' : 'total dietary fibre',
    weighable: false,
    style: 'South Indian',
    note: [
      `By the ${unit}, as the recipe makes it. Not for weighing: INDB's figures per 100 g are of the raw ingredients.`,
      ...ingredients(code)
        .filter((i) => FRYING.test(`${i['ingredient_name_org']} ${i['amount_org']} ${i['unit_org']}`))
        .map((i) => `INDB takes "${i['ingredient_name_org'].toLowerCase()} for frying" as ${i['amount']} ${i['unit']} for the whole recipe.`),
    ].join(' '),
  });
}

for (const [code, said] of REFUSED) {
  if (code === 'ASC167') continue; // left out by choice, not by a rule
  if (refusal(code) === null) throw new Error(`${code} is listed as refused (${said}) but passes every rule`);
}

const names = new Set(rows.map((r) => r.name.toLowerCase()));
if (names.size !== rows.length) throw new Error(`two dishes share a name: ${rows.map((r) => r.name).filter((n, i, all) => all.indexOf(n) !== i).join(', ')}`);
const ids = new Set(rows.map((r) => r.id));
if (ids.size !== rows.length) throw new Error('two rows share an id');

// The phone's own date, not UTC's: before 05:30 in India UTC is yesterday.
const now = new Date();
const built = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
writeFileSync(out, JSON.stringify({ built, rows, refused: REFUSED.map(([code, why]) => ({ code, why })) }, null, 1) + '\n');
console.log(`${rows.length} dishes: ${rows.filter((r) => r.source_db === 'CoFID 2021').length} from CoFID, ${rows.filter((r) => r.source_db === 'INDB 2024').length} from INDB → ${out}`);
