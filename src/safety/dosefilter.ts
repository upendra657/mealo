/**
 * Requirement R2: no agent ever suggests, calculates or confirms a dose.
 *
 * The domain layer cannot produce one — there is no code path that computes a
 * dose. This covers the other direction: text coming back from a model, which
 * can say anything.
 *
 * The distinction that matters, and the reason this is not simply "block every
 * number followed by mg":
 *
 *   allowed   quoting the user's own record        "you have creatine at 5g"
 *   allowed   quoting label text with a citation   "the label states 500 mg"
 *   blocked   instructing                          "take 500 mg twice daily"
 *   blocked   recommending                         "you should increase to 10g"
 *
 * So it looks for a dose adjacent to *instructional* language, not for doses.
 * A citation-bearing sentence is left alone, because R3 already requires those
 * to come from a fetched label rather than from the model's memory.
 */

const DOSE = String.raw`\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|iu|units?|tablets?|capsules?|pills?|scoops?)`;

const INSTRUCTIONAL = [
  // "take 500mg", "you should take 2 tablets"
  new RegExp(String.raw`\b(take|taking|have|use|swallow)\b[^.]{0,40}${DOSE}`, 'i'),
  // "500mg twice daily", "5 g per day"
  new RegExp(
    String.raw`${DOSE}[^.]{0,25}\b(twice|once|thrice|\d+\s*times|daily|per day|a day|every \d+ hours|before bed|with meals)\b`,
    'i',
  ),
  // "increase to 10g", "reduce your dose to"
  new RegExp(
    String.raw`\b(increase|decrease|reduce|raise|lower|adjust|titrate|up to|start (?:with|at)|begin (?:with|at))\b[^.]{0,30}${DOSE}`,
    'i',
  ),
  // "the recommended dose is"
  new RegExp(
    String.raw`\b(recommended|typical|usual|standard|suggested|optimal)\b[^.]{0,20}\b(dose|dosage|amount|intake)\b`,
    'i',
  ),
  // "I'd suggest 5g"
  new RegExp(
    String.raw`\b(i'?d (?:suggest|recommend)|you should|you could|try)\b[^.]{0,30}${DOSE}`,
    'i',
  ),
];

export const REFUSAL =
  'I have removed a dosing suggestion from that answer. Working out how much of ' +
  'something to take depends on things this app cannot see, and it is a question ' +
  'for a pharmacist or prescriber. I can tell you what your own record says you ' +
  'are taking, and what a product label states, with a link to it.';

export type FilterResult = {
  text: string;
  /** Sentences that were removed, for debugging and for the R2 test. */
  removed: string[];
  blocked: boolean;
};

/**
 * A figure from the food record, not a dose: "Protein averages 24 g a day."
 *
 * The frequency pattern above ("5 g per day") cannot tell grams of creatine
 * from grams of protein, and it removed every sentence that reported a
 * day's protein, carbs, fat or fibre, which is most of what a nutrition
 * answer says. Found on 11 Oct 2026, when a report question naming the
 * person's own protein figure was dropped as a dose.
 *
 * Narrow on purpose. The sentence must name one of the food figures, give
 * its amount in grams or calories only, and contain nothing that instructs:
 * "Try 5 g of creatine per day" has "try", and "take 30 g of protein powder"
 * has "take", and both are still removed.
 */
function reportsFood(sentence: string): boolean {
  return (
    /\b(?:protein|carbs?|carbohydrates?|fats?|fibre|fiber|calories|kcal)\b/i.test(sentence) &&
    !/\d\s*(?:mg|mcg|µg|ml|iu|units?|tablets?|capsules?|pills?|scoops?)\b/i.test(sentence) &&
    !/\b(?:take|taking|swallow|try|should|could|increase|decrease|reduce|raise|lower|adjust|titrate|start|begin|suggest|recommend\w*|dose|dosage|supplement\w*|powder)\b/i.test(sentence)
  );
}

/** True when a sentence appears to cite a source, which R3 requires. */
function hasCitation(sentence: string): boolean {
  return /https?:\/\/|\bper the label\b|\bthe label (states|says)\b|\baccording to the (label|leaflet)\b/i.test(
    sentence,
  );
}

/**
 * Strips instructional dosing from model output.
 *
 * Sentence-level rather than whole-message: a useful answer that contains one
 * bad sentence should lose the sentence, not the answer.
 */
export function filterDoses(text: string): FilterResult {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const s of sentences) {
    const instructional = INSTRUCTIONAL.some((re) => re.test(s));
    if (instructional && !hasCitation(s) && !reportsFood(s)) {
      removed.push(s.trim());
    } else {
      kept.push(s);
    }
  }

  if (removed.length === 0) return { text, removed, blocked: false };

  const remaining = kept.join(' ').trim();
  return {
    text: remaining ? `${remaining}\n\n${REFUSAL}` : REFUSAL,
    removed,
    blocked: true,
  };
}

/** Phrases that must be stripped. Used by the R2 test. */
export const R2_MUST_BLOCK = [
  'You should take 500 mg twice daily with food.',
  'Try 5g of creatine per day for saturation.',
  'The recommended dose is 1000 mg.',
  "I'd suggest 2 tablets before bed.",
  'You could increase to 10 g if tolerated.',
  'Start with 250mg and titrate up.',
];

/** Phrases that must survive. Used by the R2 test. */
export const R2_MUST_KEEP = [
  'Your record shows creatine at 5g, taken every morning.',
  'The label states 500 mg per tablet — https://api.fda.gov/drug/label.json',
  'Creatine is generally studied at loading and maintenance phases.',
  'Ask your pharmacist how much is appropriate for you.',
  'You logged 5 doses this week and skipped 2.',
];
