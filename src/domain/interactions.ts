/**
 * Interaction surfacing — requirement R3.
 *
 * What this does: for every ingredient of every medicine you take, fetch the
 * FDA label and check whether any ingredient of any *other* medicine you take
 * is named in its interactions section. Also, plainly, whether two of your
 * medicines contain the same ingredient.
 *
 * By ingredient, not by name, since the app began to be used outside the US.
 * "Dolo 650" means nothing to the FDA; "Paracetamol" does once RxNorm has
 * turned it into acetaminophen, which is the word US labels use. The old check
 * looked up the first word of each medicine's name and matched it with
 * String.includes, so "Calcium + D3" was checked as "Calcium" and "iron" was
 * found inside "environment".
 *
 * What it deliberately does not do: judge severity, rank risk, or tell you what
 * to do about it. It reports that a label names a substance, quotes the
 * sentence, and links the source. Interpreting that is a pharmacist's job, and
 * an app that assigned severity scores would be inventing a judgement no label
 * gave it. A shared ingredient is reported as a fact about your own list and
 * nothing more — how much of it is too much is not this app's to say (R2).
 *
 * Absence of a finding is not absence of an interaction — many products have no
 * FDA label at all, supplements especially, and a label often names a class
 * ("anticoagulants") rather than each member. The UI says so rather than
 * showing a reassuring empty state.
 */

import { scopedDb } from '../db/scope';
import {
  fetchLabel,
  SourceUnreachable,
  usIngredients,
  type DrugLabel,
  type UsIngredient,
} from '../data/drugs';
import { ingredientsOf, type Medication } from './medications';

const db = scopedDb('pharmacist');

const CACHE_TTL = 30 * 86_400_000; // 30 days; labels and names change slowly

/** One thing a medicine contains: as written, and as US labels name it. */
export type Substance = {
  /** As entered: an ingredient from the library, or the medicine's own name. */
  written: string;
  /** RxNorm's US ingredient names. Empty when the name did not resolve. */
  us: string[];
  /**
   * Resolved from the medicine's own name because it lists no ingredients.
   * Said on screen, because a name can resolve to the wrong thing: "Crocin"
   * is an Indian paracetamol and, to RxNorm, exactly crocin — a saffron
   * pigment.
   */
  byName?: boolean;
  /** RxNorm did not answer, so nothing is known — not "not recognised". */
  unreachable?: boolean;
};

export type MedSubstances = { med: Pick<Medication, 'id' | 'name'>; substances: Substance[] };

export type Finding =
  | {
      kind: 'label';
      /** The medicine whose label speaks, and the ingredient it was fetched for. */
      sourceMed: string;
      sourceIngredient: string;
      /** The product the label actually describes — may be a combination. */
      productName: string;
      /** The other medicine, and the word in the label that names it. */
      mentions: string;
      mentionsIngredient: string;
      /** The sentence it appeared in. */
      excerpt: string;
      sourceUrl: string;
      retrievedAt: number;
    }
  | {
      kind: 'shared';
      /** The US ingredient name both contain. */
      ingredient: string;
      /** How each medicine wrote it, e.g. "Paracetamol". */
      written: string[];
      meds: string[];
    };

export type LabelStatus = {
  ingredient: string;
  meds: string[];
  label: DrugLabel | null;
  /** openFDA did not answer for this one; it was not checked. */
  unreachable?: boolean;
};

// ------------------------------------------------------------ the matching

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The sentence naming a term, as a whole word or words. Whole words because a
 * label saying "environment" does not mention iron, and "warfarin" inside
 * "warfarin-like" still does.
 */
export function sentenceNaming(text: string, term: string): string | null {
  const t = term.trim();
  if (t.length < 4) return null; // "iron" is the shortest worth matching
  const word = new RegExp(`(^|[^a-z0-9])${escape(t.toLowerCase())}(?=$|[^a-z0-9])`);
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (word.test(s.toLowerCase())) return s.trim().replace(/\s+/g, ' ');
  }
  return null;
}

/**
 * Every finding in a list of medicines, given the labels already fetched.
 *
 * Pure — no network, no database — so it is tested directly. `labels` is keyed
 * by US ingredient name. For each medicine's label text, every other medicine
 * is looked for by its US ingredient names and also by how it was written,
 * since a label occasionally uses the international name too. One finding per
 * pair of medicines and word, however many sentences repeat it.
 */
export function matchLabels(items: MedSubstances[], labels: Map<string, DrugLabel | null>): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const a of items) {
    for (const s of a.substances) {
      for (const ing of s.us) {
        const label = labels.get(ing);
        if (!label) continue;
        const text =
          label.interactionsFull ??
          label.sections.find((x) => x.section === 'drug_interactions')?.text;
        if (!text) continue;

        for (const b of items) {
          if (b.med.id === a.med.id) continue;
          for (const t of b.substances) {
            // Never an ingredient both medicines share: a label naming its own
            // substance is not an interaction, and the shared finding says it.
            const terms = [...t.us, t.written.toLowerCase()].filter(
              (w, i, all) => all.indexOf(w) === i && !s.us.includes(w),
            );
            for (const term of terms) {
              const key = `${a.med.id}|${b.med.id}|${term}`;
              if (seen.has(key)) continue;
              const excerpt = sentenceNaming(text, term);
              if (!excerpt) continue;
              seen.add(key);
              out.push({
                kind: 'label',
                sourceMed: a.med.name,
                sourceIngredient: ing,
                productName: label.productName,
                mentions: b.med.name,
                mentionsIngredient: term,
                excerpt,
                sourceUrl: label.sourceUrl,
                retrievedAt: label.retrievedAt,
              });
            }
          }
        }
      }
    }
  }

  // The same ingredient in two medicines. Facts from the person's own list:
  // Dolo 650 and a cold tablet that both say paracetamol on the strip.
  const byIngredient = new Map<string, { meds: Set<string>; written: Set<string> }>();
  for (const item of items) {
    for (const s of item.substances) {
      for (const ing of s.us) {
        const e = byIngredient.get(ing) ?? { meds: new Set(), written: new Set() };
        e.meds.add(item.med.name);
        e.written.add(s.written);
        byIngredient.set(ing, e);
      }
    }
  }
  for (const [ingredient, e] of byIngredient) {
    if (e.meds.size < 2) continue;
    out.push({ kind: 'shared', ingredient, written: [...e.written], meds: [...e.meds] });
  }

  return out;
}

// ---------------------------------------------------------------- caching

/**
 * Only answers that found something are kept. "Not recognised" and "no
 * label" are asked again on every check: they cost a request each, and a
 * cached no once outlived the cause of it by a month (see SourceUnreachable).
 * Read back through the same test, so a no cached before this rule is ignored.
 */
export function worthKeeping(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** A cached JSON value in `citations`, if one is fresh. */
async function cached<T>(source: string, claim: string): Promise<T | undefined> {
  const rows = await db.query<{ excerpt: string; retrieved_at: number }>(
    `SELECT excerpt, retrieved_at FROM citations
      WHERE deleted_at IS NULL AND source_name = ? AND claim = ?
      ORDER BY retrieved_at DESC LIMIT 1`,
    [source, claim],
  );
  const row = rows[0];
  if (!row || Date.now() - row.retrieved_at > CACHE_TTL) return undefined;
  try {
    const v = JSON.parse(row.excerpt) as T;
    return worthKeeping(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function store(source: string, claim: string, url: string, value: unknown): Promise<void> {
  if (!worthKeeping(value)) return;
  await db.insert('citations', {
    claim,
    source_name: source,
    source_url: url,
    excerpt: JSON.stringify(value),
    retrieved_at: Date.now(),
    deleted_at: null,
  });
}

/**
 * The names to ask RxNorm for, in order, for an ingredient as written on a
 * strip.
 *
 * Strips add things RxNorm's exact match will not see past: a pharmacopoeia
 * tag (Indian strips print "Chlorpheniramine Maleate I.P.", British "B.P.",
 * American "USP"), and sometimes the strength. Those are removed first. Then
 * the full salt name, which RxNorm knows — "Dextromethorphan Hydrobromide",
 * "Ambroxol Hydrochloride", "Ferrous Sulphate" all resolve exactly. Only if
 * that fails, the base without its salt word: a typo in the salt
 * ("Hydobromide", as on one real entry) should not cost the whole ingredient.
 * The salt word is recognised by its ending, -ide or -ate, or a named cation,
 * and the base must still be a real word. Every candidate is still an exact
 * match; nothing here guesses.
 */
export function lookupNames(written: string): string[] {
  const cleaned = written
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(^|\s)(i\.?\s?p\.?|b\.?\s?p\.?|u\.?\s?s\.?\s?p\.?|ph\.?\s?eur\.?|n\.?f\.?)(?=\s|$)/gi, ' ')
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|iu|%)(\s*\/\s*\d*\s*(ml|g))?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const last = words[words.length - 1].toLowerCase();
  const isSalt = /(ide|ate)$/.test(last) || ['sodium', 'potassium', 'monohydrate', 'trihydrate'].includes(last);
  const base = words.slice(0, -1).join(' ');
  return isSalt && words.length > 1 && base.replace(/\s/g, '').length >= 4 ? [cleaned, base] : [cleaned];
}

/** US ingredient names for a written name, from RxNorm, cached. */
async function resolveWritten(written: string): Promise<string[]> {
  // A new key, not the old "ingredient:" one: answers cached under it may have
  // come from the fuzzy match, which is no longer trusted (see usIngredients).
  const claim = `ingredient-exact:${written.toLowerCase()}`;
  const hit = await cached<UsIngredient[]>('RxNorm', claim);
  if (hit) return hit.map((i) => i.name);
  let found: UsIngredient[] = [];
  for (const name of lookupNames(written)) {
    found = await usIngredients(name);
    if (found.length) break;
  }
  await store('RxNorm', claim, 'https://rxnav.nlm.nih.gov/REST/rxcui.json', found);
  return found.map((i) => i.name);
}

/** The FDA label for one US ingredient, cached. */
async function labelForIngredient(ingredient: string): Promise<DrugLabel | null> {
  const claim = `label-ingredient:${ingredient}`;
  const hit = await cached<DrugLabel | null>('openFDA', claim);
  if (hit !== undefined) return hit;
  const label = await fetchLabel({ ingredient });
  await store('openFDA', claim, label?.sourceUrl ?? 'https://api.fda.gov/drug/label.json', label);
  return label;
}

// ------------------------------------------------------------- the check

/**
 * What each medicine contains: its ingredients from the library when it has
 * them, otherwise its own name — which RxNorm resolves for "Paracetamol" and
 * not for "Dolo 650", and the screen says which did not.
 */
export async function substancesOf(meds: Medication[]): Promise<MedSubstances[]> {
  const out: MedSubstances[] = [];
  for (const med of meds) {
    const listed = med.product_id ? await ingredientsOf(med.product_id) : [];
    const byName = listed.length === 0;
    const written = byName ? [med.name] : listed.map((i) => i.name);
    const substances: Substance[] = [];
    for (const w of written) {
      try {
        substances.push({ written: w, us: await resolveWritten(w), byName });
      } catch (e) {
        if (!(e instanceof SourceUnreachable)) throw e;
        substances.push({ written: w, us: [], byName, unreachable: true });
      }
    }
    out.push({ med: { id: med.id, name: med.name }, substances });
  }
  return out;
}

/**
 * Cross-check everything being taken. One RxNorm lookup per written name and
 * one label per ingredient, each cached for 30 days, so a repeat visit costs
 * nothing; no model is involved at any point.
 */
export async function checkInteractions(meds: Medication[]): Promise<{
  findings: Finding[];
  statuses: LabelStatus[];
  unresolved: { med: string; written: string }[];
  byName: { med: string; us: string[] }[];
  /** Names the sources did not answer for, this time. */
  unreachable: string[];
}> {
  const items = await substancesOf(meds);

  const users = new Map<string, Set<string>>();
  for (const item of items) {
    for (const s of item.substances) {
      for (const ing of s.us) users.set(ing, (users.get(ing) ?? new Set()).add(item.med.name));
    }
  }

  const labels = new Map<string, DrugLabel | null>();
  const statuses: LabelStatus[] = [];
  for (const [ingredient, who] of users) {
    try {
      const label = await labelForIngredient(ingredient);
      labels.set(ingredient, label);
      statuses.push({ ingredient, meds: [...who], label });
    } catch (e) {
      if (!(e instanceof SourceUnreachable)) throw e;
      labels.set(ingredient, null);
      statuses.push({ ingredient, meds: [...who], label: null, unreachable: true });
    }
  }

  // Once each: two medicines of the same name list the same ingredients, and
  // a list that repeats itself hides the one line worth reading.
  const unresolved = items
    .flatMap((i) =>
      i.substances
        .filter((s) => s.us.length === 0 && !s.unreachable)
        .map((s) => ({ med: i.med.name, written: s.written })),
    )
    .filter((u, n, all) => all.findIndex((x) => x.med === u.med && x.written === u.written) === n);
  const unreachable = [
    ...items.flatMap((i) => i.substances.filter((s) => s.unreachable).map((s) => s.written)),
    ...statuses.filter((s) => s.unreachable).map((s) => s.ingredient),
  ].filter((n, i, all) => all.indexOf(n) === i);

  const byName = items.flatMap((i) =>
    i.substances.filter((s) => s.byName && s.us.length > 0).map((s) => ({ med: i.med.name, us: s.us })),
  );

  return { findings: matchLabels(items, labels), statuses, unresolved, byName, unreachable };
}
