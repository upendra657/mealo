/**
 * The claims check: a model may not say something was saved.
 *
 * On 11 Oct 2026 Upendra typed "I just had 2 roti and dal" into Ask Mealo.
 * The model had a tool for putting a meal card on screen and did not use
 * it. It answered "Meals logged: 2 roti and dal." Nothing had been logged.
 * Asked to elaborate, it said the meal was "not recorded in the app".
 *
 * A model in this app cannot save anything: there is no tool that writes.
 * So a sentence in which it says it logged, saved, recorded or ticked
 * something is false by construction, and is removed. That part needs no
 * judgement.
 *
 * The harder case is the label. "Meals logged: Dinner, Boss Burrito" is a
 * true description of the record when the record holds that dinner, and
 * the same words are a false claim when it does not. So a line of that
 * shape is checked the way he said to check it, against what is actually
 * in Track meals: it stays only if it names a dish the model was shown
 * from the record. A line about a meal the record does not hold goes.
 *
 * The screen says what was removed and why, because the person has just
 * been told something untrue by omission otherwise: they think it is saved.
 */

/** The model saying it did the saving. Never true here. */
const I_SAVED: readonly RegExp[] = [
  /\b(?:i|we)(?:'ve| have)? (?:just |now |already |successfully |gone ahead and )*(?:logged|saved|recorded|added|noted down|stored|ticked|marked|updated|entered)\b/i,
  /\b(?:i|we)(?:'ll| will| am going to|'m going to) (?:log|save|record|add|store|tick|mark|update|enter)\b/i,
  /\b(?:has|have|had) been (?:successfully )?(?:logged|saved|recorded|added|stored|ticked|marked|updated|entered)\b/i,
  /\b(?:is|are|was|were) (?:now|successfully|already) (?:logged|saved|recorded|added|stored|ticked|marked)\b/i,
  /\b(?:successfully|now) (?:logged|saved|recorded|added|ticked)\b/i,
  /\b(?:logged|saved|recorded|added) (?:it|that|this|them|those) (?:for you|to your|in your|as)\b/i,
  /\byour (?:meal|food|dose|symptom|entry|log) (?:has been|is|was) (?:logged|saved|recorded|added|updated)\b/i,
];

/** "Meals logged: …", "Dose recorded: …": true or false depending on the record. */
const LABEL = /^\s*(?:[-*•]\s+)?(?:\*\*)?(?:meals?|food|dish(?:es)?|doses?|medicines?|symptoms?|entry|entries|items?) (?:logged|recorded|saved|added|noted|ticked)(?:\*\*)?\s*[:–-]/i;

/** A sentence that says nothing was saved is the truth, and stays. */
const DENIES = /\b(?:not|n't|no|never|nothing|cannot|unable|could not|couldn't|hasn't|haven't|isn't|wasn't)\b/i;

export type ClaimsResult = { text: string; removed: string[] };

/**
 * The answer with every false claim of saving taken out.
 *
 * `known` is every dish name the model was shown from the record, in the
 * summary or in a tool's result. Names of three letters or fewer are not
 * used: "dal" would then vouch for any sentence with "dal" in it, and the
 * sentence that started this was about dal.
 */
export function checkClaims(answer: string, known: readonly string[]): ClaimsResult {
  const names = known.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 3);
  const removed: string[] = [];
  const lines = answer.split('\n').map((line) => {
    if (!line.trim()) return line;
    const lower = line.toLowerCase();
    const said = I_SAVED.some((p) => p.test(line)) && !DENIES.test(line);
    const labelled = LABEL.test(line) && !DENIES.test(line) && !names.some((n) => lower.includes(n));
    if (said || labelled) {
      removed.push(line.trim());
      return null;
    }
    return line;
  });
  const text = lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, removed };
}

/** What the screen says when it has taken such a sentence out. */
export const NOT_SAVED =
  'The app removed a line that said something was saved. Nothing was. Ask Mealo cannot save: a meal, a dose or a symptom is saved only by the button on a card.';

/** Every dish name in a tool's result, wherever it sits. */
export function dishesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dishesIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (k === 'dish' && typeof v === 'string' ? [v] : dishesIn(v)));
  }
  return [];
}
