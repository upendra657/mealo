/**
 * The numbers check: a figure a model writes must be one the app gave it.
 *
 * "Code works out the numbers, the AI explains them" is the rule every AI
 * feature here follows, and a rule about a model is only worth what enforces
 * it. So after a model has answered, every number in the answer is looked
 * for among the numbers it was actually handed: the slice, the results of
 * the tools it called, the table on screen, and the person's own question.
 * A sentence carrying a number found in none of them is removed, and the
 * screen says that it was.
 *
 * The whole sentence goes, not the number. "You averaged 2,150 Cal" with the
 * figure cut out is still a claim, now with a hole in it.
 *
 * What counts as found:
 *
 *   - the number itself, give or take rounding. A model writing "about 640"
 *     for 642, or "about 600", has not invented anything;
 *   - something worked out from a figure and its own target: the gap, or the
 *     percentage. "19 g short" of a 90 g target at 71 g is arithmetic on two
 *     numbers it was given, and saying how a figure sits against its target
 *     is exactly what it is asked to do. Only those pairs: letting any two
 *     numbers in a payload combine would make nearly every small number
 *     "found";
 *   - dates and clock times, list numbering, and "100%".
 *
 * The cost, accepted on purpose: a true general figure the model knows
 * ("adults need about 25 g of fibre") is removed with the invented ones,
 * because the check cannot tell them apart and the app cannot vouch for
 * either. Ask Mealo talks about the record. It is the price of never
 * showing a number nobody can trace.
 */

export type Allowed = {
  /** Every number the model was given. */
  numbers: readonly number[];
  /** A figure and its target, whose gap and ratio may also be quoted. */
  pairs: readonly (readonly [number, number])[];
};

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

/** Every number in a piece of text, commas and all. Used to build `Allowed`. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/** Every number inside a tool's result, wherever it sits. */
export function numbersOf(value: unknown): number[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : [];
  if (typeof value === 'string') return numbersIn(value);
  if (Array.isArray(value)) return value.flatMap(numbersOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersOf);
  return [];
}

function near(n: number, a: number): boolean {
  if (Math.abs(n - a) <= 0.5) return true;
  // Two per cent: "1,900" for 1,912.
  if (a !== 0 && Math.abs(n - a) / Math.abs(a) <= 0.02) return true;
  // "About 600" for 642, "about 30" for 28: rounded to a step no coarser
  // than a quarter of the figure, which is how people round and not how
  // they invent.
  for (const step of [5, 10, 50, 100, 500]) {
    if (step <= Math.abs(a) / 4 && Math.round(a / step) * step === n) return true;
  }
  return false;
}

function found(n: number, allowed: Allowed): boolean {
  if (n === 100) return true;
  if (allowed.numbers.some((a) => near(n, a))) return true;
  for (const [a, b] of allowed.pairs) {
    if (near(n, Math.abs(a - b))) return true;
    if (b !== 0 && (near(n, (a / b) * 100) || near(n, Math.abs(1 - a / b) * 100))) return true;
    if (a !== 0 && near(n, (b / a) * 100)) return true;
  }
  return false;
}

/** The numbers in one sentence that have to be accounted for. */
function claims(sentence: string): number[] {
  const s = sentence
    // "1." or "2)" opening a list item.
    .replace(/^\s*\d{1,2}[.)]\s+/, '')
    // Clock times and dates are not figures about the body. The whole
    // "2026-10-05" goes first, or the year is taken out of it and the month
    // and day are left behind looking like two figures.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}(?:\s?(?:am|pm))\b/gi, ' ')
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:\\s+\\d{4})?`, 'gi'), ' ')
    .replace(new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, 'gi'), ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  return numbersIn(s);
}

export type NumbersResult = { text: string; removed: string[] };

/**
 * The answer with every sentence that quotes an unfound number taken out.
 *
 * Works line by line and, within a line, sentence by sentence, so one bad
 * point in a list loses that point and not the list.
 */
export function checkNumbers(answer: string, allowed: Allowed): NumbersResult {
  const removed: string[] = [];
  const lines = answer.split('\n').map((line) => {
    const lead = /^(\s*(?:[-*•]|\d{1,2}[.)])\s+)/.exec(line)?.[1] ?? '';
    const body = line.slice(lead.length);
    // Split after a full stop that ends a sentence, not after "1.5" or "kg.".
    const parts = body.split(/(?<=[.!?])\s+(?=[A-Z*_"'(“])/);
    const kept = parts.filter((part) => {
      const bad = claims(lead ? part : part).some((n) => !found(n, allowed));
      if (bad && part.trim()) removed.push(part.trim());
      return !bad;
    });
    if (kept.length === 0) return body.trim() ? null : line;
    return lead + kept.join(' ');
  });
  const text = lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, removed };
}

/** What the screen says under an answer that lost something. */
export function removedNote(n: number): string {
  return n === 1
    ? 'The app removed 1 sentence: it gave a figure that is not in your records.'
    : `The app removed ${n} sentences: they gave figures that are not in your records.`;
}
