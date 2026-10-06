/**
 * Reading a medicine list out of a spreadsheet: CSV or Excel in, medicines out.
 *
 * Importing has to be clean above everything else — a list that half-loads,
 * or loads with every third composition mangled, is worse than no list — so
 * every step here is a pure function with its own tests, and nothing in this
 * file touches the database or the screen.
 *
 * Three shapes of composition are understood, because the lists actually in
 * use write it three ways:
 *
 *   HSA Singapore    "ORPHENADRINE CITRATE&&PARACETAMOL" with a separate
 *                    strength column "25 mg&&500 mg", lined up by position
 *   A-Z India        one ingredient per column, "Paracetamol (650mg)"
 *   one column       "Amoxycillin (500mg) + Clavulanic Acid (125mg)"
 */

import { normalise } from '../domain/foods';
import type { Form } from '../domain/doses';

// ------------------------------------------------------------------- CSV

/**
 * A CSV reader fed in slices, so a 45 MB file never has to be parsed in one
 * blocking pass. A quoted field may run across slices, and across lines; a
 * leading byte-order mark is dropped; \r\n, \n and \r all end a row.
 */
export class CsvReader {
  private row: string[] = [];
  private field = '';
  private quoted = false;
  /** The previous slice ended on a quote inside a quoted field. */
  private pendingQuote = false;
  /** The previous slice ended on \r, which may be half of \r\n. */
  private pendingCr = false;
  private started = false;

  feed(text: string): string[][] {
    let src = text;
    if (!this.started) {
      src = src.replace(/^﻿/, '');
      this.started = true;
    }
    const out: string[][] = [];
    let i = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (src[0] === '\n') i = 1;
    }
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (src[0] === '"') {
        this.field += '"';
        i = Math.max(i, 1);
      } else {
        this.quoted = false;
      }
    }
    for (; i < src.length; i++) {
      const c = src[i];
      if (this.quoted) {
        if (c === '"') {
          if (i + 1 === src.length) {
            this.pendingQuote = true;
          } else if (src[i + 1] === '"') {
            this.field += '"';
            i++;
          } else {
            this.quoted = false;
          }
        } else {
          this.field += c;
        }
        continue;
      }
      if (c === '"' && this.field === '') this.quoted = true;
      else if (c === ',') {
        this.row.push(this.field);
        this.field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') {
          if (i + 1 === src.length) this.pendingCr = true;
          else if (src[i + 1] === '\n') i++;
        }
        this.endRow(out);
      } else {
        this.field += c;
      }
    }
    return out;
  }

  /** The last row, if the file did not end with a newline. */
  end(): string[][] {
    const out: string[][] = [];
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.quoted = false;
    }
    if (this.field !== '' || this.row.length > 0) this.endRow(out);
    return out;
  }

  private endRow(out: string[][]) {
    this.row.push(this.field);
    this.field = '';
    if (this.row.some((f) => f.trim() !== '')) out.push(this.row);
    this.row = [];
  }
}

// ---------------------------------------------------------- composition

export type RefIngredient = { name: string; strength: string | null };

/**
 * "Paracetamol (650mg)" → Paracetamol, 650mg. The LAST bracket is the
 * strength, so a name with its own brackets survives: "Progesterone (Natural
 * Micronized) (25mg)", "Thiamine(Vitamin B1) (100mg)". A part with no
 * trailing bracket is all name.
 */
export function splitIngredient(part: string): RefIngredient | null {
  const p = part.replace(/\s+/g, ' ').trim();
  if (!p) return null;
  const m = /^(.*\S)\s*\(([^()]*)\)\s*$/.exec(p);
  if (m && m[1].replace(/[()\s]/g, '')) {
    return { name: m[1].trim(), strength: m[2].trim() || null };
  }
  return { name: p, strength: null };
}

/** The separator a composition uses, if any: HSA's "&&", "+", or ";". */
function separatorOf(text: string): RegExp | null {
  if (text.includes('&&')) return /\s*&&\s*/;
  if (/\s\+\s|\)\s*\+/.test(text)) return /\s*\+\s*/;
  if (text.includes(';')) return /\s*;\s*/;
  return null;
}

/**
 * Every ingredient in one composition cell, with the strengths from a
 * separate column lined up by position when there is one. A strength column
 * that does not line up — a different count — is not guessed at: the
 * ingredients keep whatever their own cell said.
 */
export function parseComposition(text: string, strengthText?: string | null): RefIngredient[] {
  const t = (text ?? '').trim();
  if (!t) return [];
  const sep = separatorOf(t);
  const parts = (sep ? t.split(sep) : [t]).map(splitIngredient).filter((x): x is RefIngredient => !!x);
  const s = (strengthText ?? '').trim();
  if (s) {
    const ssep = separatorOf(s) ?? sep;
    const strengths = ssep ? s.split(ssep) : [s];
    if (strengths.length === parts.length) {
      parts.forEach((p, i) => {
        if (!p.strength && strengths[i].trim()) p.strength = strengths[i].trim();
      });
    }
  }
  return parts;
}

/**
 * The app's form, from a dosage-form or pack description: "strip of 10
 * tablets", "TABLET, FILM COATED", "bottle of 60 ml Syrup", "SUSPENSION",
 * "Eye Drops". Null when it is none of the four the app has — an injection,
 * a cream — rather than forced into one.
 */
export function formFromText(text: string | null | undefined): Form | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/drop|eye|ear|ophthalmic|otic|gel\b/.test(t)) return 'drops';
  if (/tablet|capsule|caplet|softgel/.test(t)) return 'tablet';
  if (/syrup|suspension|elixir|linctus|oral solution|oral liquid|\bliquid\b|solution, oral|\bmixture\b/.test(t)) return 'syrup';
  if (/powder|granule|sachet/.test(t)) return 'powder';
  return null;
}

// --------------------------------------------------------------- mapping

/** Which column holds what. Column names exactly as the file's header has them. */
export type Mapping = {
  name: string;
  /** One or more composition columns, read left to right. */
  ingredients: string[];
  /** A strength column lined up with the ingredients, HSA style. */
  strength?: string | null;
  form?: string | null;
  /** Rows whose value in this column is one of `values` are left out. */
  discontinued?: { column: string; values: string[] } | null;
};

export type Preset = {
  id: string;
  mapping: Mapping;
  name: string;
  tag: string;
  source_url: string;
  licence: string;
};

/**
 * The lists known by their headers, so they import in one step. A file is
 * recognised only when every column a preset needs is present, so a list
 * that merely shares a "name" column is never mistaken for one.
 */
export const PRESETS: Preset[] = [
  {
    id: 'az-india',
    mapping: {
      name: 'name',
      ingredients: ['short_composition1', 'short_composition2'],
      form: 'pack_size_label',
      discontinued: { column: 'Is_discontinued', values: ['TRUE', 'True', 'true', '1', 'yes', 'Yes'] },
    },
    name: 'A-Z Medicine Dataset of India',
    tag: 'India',
    source_url: 'https://www.kaggle.com/datasets/shudhanshusingh/az-medicine-dataset-of-india',
    licence: 'CC BY-SA 4.0 · Shudhanshu Singh',
  },
  {
    id: 'hsa-singapore',
    mapping: { name: 'Productname', ingredients: ['Activeingredients'], strength: 'Strength', form: 'Dosageform' },
    name: 'HSA Listing of Registered Therapeutic Products',
    tag: 'HSA',
    source_url: 'https://data.gov.sg/datasets/d_767279312753558cbf19d48344577084/view',
    licence: 'Singapore Open Data Licence · Health Sciences Authority',
  },
];

export function presetFor(header: string[]): Preset | null {
  const has = new Set(header.map((h) => h.trim()));
  return (
    PRESETS.find((p) => {
      const m = p.mapping;
      const needed = [m.name, ...m.ingredients, m.strength, m.form, m.discontinued?.column].filter(
        (x): x is string => !!x,
      );
      return needed.every((c) => has.has(c));
    }) ?? null
  );
}

export type RefItem = {
  name: string;
  name_norm: string;
  ingredients: RefIngredient[];
  form: Form | null;
  discontinued: boolean;
};

export type Skips = Record<'no name' | 'no ingredients' | 'discontinued' | 'duplicate', number>;

export function emptySkips(): Skips {
  return { 'no name': 0, 'no ingredients': 0, discontinued: 0, duplicate: 0 };
}

/**
 * Turns rows into medicines under a mapping, counting what it leaves out and
 * why. Stateful across calls only through `seen`, so a file read in slices
 * still drops a duplicate that lands in a later slice.
 */
export function rowsToItems(
  header: string[],
  rows: string[][],
  mapping: Mapping,
  skips: Skips,
  seen: Set<string>,
): RefItem[] {
  const col = (name: string | null | undefined) => (name ? header.indexOf(name) : -1);
  const nameAt = col(mapping.name);
  const ingAt = mapping.ingredients.map(col).filter((i) => i >= 0);
  const strengthAt = col(mapping.strength);
  const formAt = col(mapping.form);
  const discAt = col(mapping.discontinued?.column);
  const discValues = new Set((mapping.discontinued?.values ?? []).map((v) => v.trim()));

  const out: RefItem[] = [];
  for (const r of rows) {
    const name = (r[nameAt] ?? '').replace(/\s+/g, ' ').trim();
    if (!name) {
      skips['no name']++;
      continue;
    }
    if (discAt >= 0 && discValues.has((r[discAt] ?? '').trim())) {
      skips.discontinued++;
      continue;
    }
    const strength = strengthAt >= 0 ? r[strengthAt] : null;
    const ingredients = ingAt.flatMap((i) => parseComposition(r[i] ?? '', ingAt.length === 1 ? strength : null));
    if (ingredients.length === 0) {
      skips['no ingredients']++;
      continue;
    }
    const key = `${name.toLowerCase()}|${ingredients.map((x) => `${x.name}:${x.strength}`).join('+').toLowerCase()}`;
    if (seen.has(key)) {
      skips.duplicate++;
      continue;
    }
    seen.add(key);
    out.push({
      name,
      name_norm: normalise(name),
      ingredients,
      form: formFromText(formAt >= 0 ? r[formAt] : null),
      discontinued: false,
    });
  }
  return out;
}
