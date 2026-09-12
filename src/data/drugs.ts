/**
 * Drug facts from primary sources — requirement R3.
 *
 * The model never supplies a drug fact from memory. It gets text fetched from
 * an FDA label, and every claim carries the URL it came from. That is what lets
 * an 8B open-weight model be adequate here: it is doing language, not medicine.
 *
 * Both APIs are public, keyless, and verified to work from a browser origin:
 *   RxNav   https://rxnav.nlm.nih.gov  — name → RxCUI, including fuzzy matching
 *   openFDA https://api.fda.gov        — structured label text, section 7
 *
 * Note the NLM retired its own drug-interaction endpoint in January 2024, so
 * interactions are read out of label text rather than a purpose-built API.
 * That is more work and less tidy, but it is citable, which the old endpoint's
 * output was not.
 */

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const OPENFDA = 'https://api.fda.gov/drug/label.json';

export type DrugConcept = {
  rxcui: string;
  name: string;
  /** How confident the resolution is — 'exact' or 'approximate'. */
  via: 'exact' | 'approximate';
};

export type LabelSection = {
  /** Section of the label this came from. */
  section: 'drug_interactions' | 'warnings' | 'contraindications';
  text: string;
};

export type DrugLabel = {
  /**
   * The product the label actually describes.
   *
   * Searching "metformin" can return a combination product such as ZITUVIMET.
   * Its interactions are not necessarily metformin's, so this name is shown
   * with every claim rather than quietly dropped.
   */
  productName: string;
  genericNames: string[];
  sections: LabelSection[];
  sourceUrl: string;
  retrievedAt: number;
};

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`${res.status} from ${new URL(url).host}`);
  }
  return res.json();
}

/** Resolve a written name to an RxNorm concept. Exact first, then fuzzy. */
export async function resolveDrug(
  name: string,
  signal?: AbortSignal,
): Promise<DrugConcept | null> {
  const term = name.trim();
  if (!term) return null;

  try {
    const exact = (await getJson(
      `${RXNAV}/rxcui.json?name=${encodeURIComponent(term)}`,
      signal,
    )) as { idGroup?: { rxnormId?: string[] } };
    const id = exact.idGroup?.rxnormId?.[0];
    if (id) return { rxcui: id, name: term, via: 'exact' };
  } catch {
    /* fall through to approximate */
  }

  try {
    const approx = (await getJson(
      `${RXNAV}/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=1`,
      signal,
    )) as {
      approximateGroup?: { candidate?: { rxcui: string; name?: string }[] };
    };
    const c = approx.approximateGroup?.candidate?.[0];
    if (c?.rxcui) {
      return { rxcui: c.rxcui, name: c.name ?? term, via: 'approximate' };
    }
  } catch {
    /* no match */
  }

  return null;
}

type OpenFdaResult = {
  drug_interactions?: string[];
  warnings?: string[];
  contraindications?: string[];
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    rxcui?: string[];
  };
};

/** Trim label prose to something that fits a prompt without losing the point. */
function clip(text: string, max = 1800): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Cut at a sentence boundary so the excerpt does not end mid-claim.
  const cut = clean.slice(0, max);
  const lastStop = cut.lastIndexOf('. ');
  return (lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut) + ' […]';
}

/**
 * Fetch a label. Tries the RxCUI first — it is the precise handle — then falls
 * back to the generic name.
 */
export async function fetchLabel(
  opts: { rxcui?: string; name?: string },
  signal?: AbortSignal,
): Promise<DrugLabel | null> {
  const queries: string[] = [];
  if (opts.rxcui) queries.push(`openfda.rxcui:"${opts.rxcui}"`);
  if (opts.name) {
    queries.push(`openfda.generic_name:"${opts.name}"`);
    queries.push(`openfda.brand_name:"${opts.name}"`);
  }

  for (const q of queries) {
    try {
      const url = `${OPENFDA}?search=${encodeURIComponent(q)}&limit=1`;
      const data = (await getJson(url, signal)) as { results?: OpenFdaResult[] };
      const r = data.results?.[0];
      if (!r) continue;

      const sections: LabelSection[] = [];
      if (r.drug_interactions?.length) {
        sections.push({
          section: 'drug_interactions',
          text: clip(r.drug_interactions.join(' ')),
        });
      }
      if (r.contraindications?.length) {
        sections.push({
          section: 'contraindications',
          text: clip(r.contraindications.join(' '), 900),
        });
      }
      if (r.warnings?.length) {
        sections.push({
          section: 'warnings',
          text: clip(r.warnings.join(' '), 900),
        });
      }
      if (sections.length === 0) continue;

      return {
        productName:
          r.openfda?.brand_name?.[0] ??
          r.openfda?.generic_name?.[0] ??
          opts.name ??
          'unknown product',
        genericNames: r.openfda?.generic_name ?? [],
        sections,
        sourceUrl: `${OPENFDA}?search=${encodeURIComponent(q)}&limit=1`,
        retrievedAt: Date.now(),
      };
    } catch {
      /* try the next query shape */
    }
  }
  return null;
}

/**
 * Everything known about one substance, from sources.
 * Returns nulls rather than guesses — an absent label is a fact worth showing.
 */
export async function lookupDrug(
  name: string,
  signal?: AbortSignal,
): Promise<{ concept: DrugConcept | null; label: DrugLabel | null }> {
  const concept = await resolveDrug(name, signal);
  const label = await fetchLabel(
    { rxcui: concept?.rxcui, name: concept?.name ?? name },
    signal,
  );
  return { concept, label };
}
