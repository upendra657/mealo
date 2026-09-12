/**
 * Interaction surfacing — requirement R3.
 *
 * What this does: fetches the FDA label for each thing you take, and checks
 * whether any *other* thing you take is named in its interactions section.
 *
 * What it deliberately does not do: judge severity, rank risk, or tell you what
 * to do about it. It reports that a label names a substance, quotes the
 * sentence, and links the source. Interpreting that is a pharmacist's job, and
 * an app that assigned severity scores would be inventing a judgement no label
 * gave it.
 *
 * Absence of a finding is not absence of an interaction — many products have no
 * FDA label at all, supplements especially. The UI says so rather than showing
 * a reassuring empty state.
 */

import { scopedDb } from '../db/scope';
import { fetchLabel, resolveDrug, type DrugLabel } from '../data/drugs';
import type { Medication } from './medications';

const db = scopedDb('pharmacist');

export type Finding = {
  /** The medication whose label mentions the other. */
  sourceMed: string;
  /** The product the label actually describes — may be a combination. */
  productName: string;
  /** The medication named in that label. */
  mentions: string;
  /** The sentence it appeared in. */
  excerpt: string;
  sourceUrl: string;
  retrievedAt: number;
};

export type LabelStatus = {
  medicationId: string;
  name: string;
  rxcui: string | null;
  resolvedVia: 'exact' | 'approximate' | null;
  label: DrugLabel | null;
  /** True when no FDA label exists — common for supplements. */
  noLabel: boolean;
};

const CACHE_TTL = 30 * 86_400_000; // 30 days; labels change slowly

/** Find the sentence containing a term, so the quote carries its context. */
function sentenceWith(text: string, term: string): string | null {
  const needle = term.toLowerCase();
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (s.toLowerCase().includes(needle)) {
      return s.trim().replace(/\s+/g, ' ');
    }
  }
  return null;
}

async function cachedLabel(name: string): Promise<DrugLabel | null> {
  const rows = await db.query<{
    excerpt: string;
    source_url: string;
    retrieved_at: number;
  }>(
    `SELECT excerpt, source_url, retrieved_at FROM citations
      WHERE deleted_at IS NULL AND source_name = 'openFDA' AND claim = ?
      ORDER BY retrieved_at DESC LIMIT 1`,
    [`label:${name.toLowerCase()}`],
  );
  const row = rows[0];
  if (!row || Date.now() - row.retrieved_at > CACHE_TTL) return null;
  try {
    return JSON.parse(row.excerpt) as DrugLabel;
  } catch {
    return null;
  }
}

async function storeLabel(name: string, label: DrugLabel): Promise<void> {
  await db.insert('citations', {
    claim: `label:${name.toLowerCase()}`,
    source_name: 'openFDA',
    source_url: label.sourceUrl,
    excerpt: JSON.stringify(label),
    retrieved_at: label.retrievedAt,
    deleted_at: null,
  });
}

/** Resolve and fetch a label for one medication, using the local cache first. */
export async function labelFor(med: Medication): Promise<LabelStatus> {
  const cached = await cachedLabel(med.name);
  if (cached) {
    return {
      medicationId: med.id,
      name: med.name,
      rxcui: med.rxcui,
      resolvedVia: med.rxcui ? 'exact' : null,
      label: cached,
      noLabel: false,
    };
  }

  const concept = await resolveDrug(med.name);
  const label = await fetchLabel({
    rxcui: concept?.rxcui,
    name: concept?.name ?? med.name,
  });

  if (label) await storeLabel(med.name, label);
  if (concept && concept.rxcui !== med.rxcui) {
    await db.update('medications', med.id, { rxcui: concept.rxcui });
  }

  return {
    medicationId: med.id,
    name: med.name,
    rxcui: concept?.rxcui ?? null,
    resolvedVia: concept?.via ?? null,
    label,
    noLabel: label === null,
  };
}

/**
 * Cross-check everything currently taken.
 *
 * One label fetch per medication, cached for 30 days — so this costs nothing
 * on repeat visits and never touches a model.
 */
export async function checkInteractions(
  meds: Medication[],
): Promise<{ findings: Finding[]; statuses: LabelStatus[] }> {
  const statuses: LabelStatus[] = [];
  for (const m of meds) {
    statuses.push(await labelFor(m));
  }

  const findings: Finding[] = [];
  for (const status of statuses) {
    const interactions = status.label?.sections.find(
      (s) => s.section === 'drug_interactions',
    );
    if (!interactions) continue;

    for (const other of meds) {
      if (other.id === status.medicationId) continue;
      // Match on the substance word, not the whole written name, so
      // "Metformin HCl 500" still matches a label mentioning metformin.
      const word = other.name.split(/\s+/)[0];
      if (word.length < 4) continue;
      const excerpt = sentenceWith(interactions.text, word);
      if (!excerpt) continue;

      findings.push({
        sourceMed: status.name,
        productName: status.label!.productName,
        mentions: other.name,
        excerpt,
        sourceUrl: status.label!.sourceUrl,
        retrievedAt: status.label!.retrievedAt,
      });
    }
  }

  return { findings, statuses };
}
