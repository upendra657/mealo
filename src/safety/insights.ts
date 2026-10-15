/**
 * AI insights on the report, and "Questions to ask your doctor".
 *
 * The one place in the app where a model's words sit beside the app's own
 * figures on a page that may be printed and handed to someone. So the model
 * is given less room here than anywhere else:
 *
 *   - It is sent only what the report already shows: the figures the app
 *     worked out for the period. No name, no free-form history, no chat.
 *   - It is asked for short separate points, so that one bad point can be
 *     removed without the rest.
 *   - Every point then has to pass four checks, in code, or it is dropped:
 *     no dose (R2), no figure that is not in the data (the numbers check),
 *     no naming of a condition the person did not record themselves, and no
 *     setting of a target or goal.
 *   - What survives is tagged "AI" one point at a time, on screen and on
 *     paper, and the page says how many points were removed.
 *
 * The questions exist to send people towards a professional. They are
 * about what was recorded ("headaches on 6 days"), never about what it
 * might be.
 *
 * Pure: the caller makes the one request and hands the reply here.
 */

import type { ExportInput } from '../domain/export';
import { dawaAdherence, pairsOf, symptomLog, thaliSummary, weightTrend } from '../domain/tools';
import { DATA_HEADER } from '../llm/toolloop';
import type { ChatMessage } from '../llm/types';
import { filterDoses } from './dosefilter';
import { CONDITION_WORDS } from './gates';
import { checkNumbers, numbersOf } from './numbers';

export const MAX_INSIGHTS = 5;
export const MAX_QUESTIONS = 4;

export const INSIGHT_PROMPT = [
  'You are writing a few short observations for a personal health report that',
  'an app has already worked out. You are not a clinician and the reader is',
  'not your patient.',
  '',
  'You are given DATA: figures the app calculated from what the person logged.',
  'Use only that. Do not add a figure that is not in it.',
  '',
  'Never:',
  '- state or suggest a diagnosis, or name a disease, deficiency or condition;',
  '- mention a dose, or whether to take, skip or change any medicine;',
  '- set or suggest a target, goal, calorie number or weight to reach;',
  '- say that one thing causes another. Say that things turn up together.',
  '',
  'If only a few days are logged, say that the figures describe those days',
  'and not the whole period. A low figure usually means meals were not',
  'logged, not that they were not eaten.',
  '',
  'Answer in exactly this shape, plain text, nothing before or after:',
  '',
  'INSIGHTS',
  `- up to ${MAX_INSIGHTS} points, one sentence each, about what stands out in the data`,
  'QUESTIONS',
  `- up to ${MAX_QUESTIONS} questions the person could ask their own doctor or dietitian,`,
  '  each about something in the data, each ending with a question mark',
].join('\n');

/** The figures the report shows, as the model is given them. */
export function insightData(x: ExportInput): Record<string, unknown> {
  return {
    ...(x.scope !== 'meds' ? { meals: thaliSummary(x) } : {}),
    ...(x.scope !== 'meals' ? { medicines: dawaAdherence(x) } : {}),
    ...(x.scope === 'full' ? { weight: weightTrend(x), symptoms: symptomLog(x) } : {}),
  };
}

export function insightMessages(x: ExportInput): ChatMessage[] {
  return [
    { role: 'system', content: INSIGHT_PROMPT },
    { role: 'user', content: `${DATA_HEADER}\n${JSON.stringify(insightData(x))}` },
  ];
}

/**
 * Setting a target is a decision about the body, and not the model's.
 * Naming the target the person already set ("against a target of 1,900") is
 * not setting one, and is what a report is for; an invented target number is
 * the numbers check's to catch.
 */
const SETS_A_TARGET =
  /\b(?:aim (?:for|to)|you should (?:eat|have|target|aim|reduce|increase|cut|lose|gain|consume|limit|try)|try (?:to )?(?:eat|hit|reach|get|keep|limit|cut|lose|gain|reduc|increas)\w*|set (?:a|your|the) (?:target|goal)|(?:target|goal) should be|should be (?:eating|having|getting|aiming)|need to (?:eat|lose|gain|cut|reduce|increase)|recommend(?:ed)? (?:intake|amount|eating|that you)|cut (?:down|back|out)|eat (?:more|less|fewer)\b)/i;

/** An instruction. The points are observations; "Eat less rice." is not one. */
const TELLS =
  /^(?:please )?(?:eat|have|consume|drink|limit|restrict|avoid|stop|start|increase|reduce|cut|add|skip|take|replace|swap|switch|keep|make sure|ensure|consider|focus on|prioriti[sz]e)\b/i;

/** A condition asserted, or a cause. */
const ASSERTS =
  /\b(?:you (?:have|may have|might have|could have|probably have|likely have|are (?:likely |probably )?(?:suffering|deficient|diabetic|an(?:a)?emic|intolerant|allergic))|(?:is|are|may be|might be|could be) (?:a |an )?(?:sign|symptom|indicator|marker)s? of|suggests? (?:a|an|that you have)|indicat(?:es|ing|ive of)|consistent with|diagnos\w*|(?:is|are|was|were) (?:caused|triggered) by|causes? (?:your|the|you)|because of (?:the|your) (?:rajma|dal|food|diet|medicine)|leads? to (?:your|the))\b/i;

export type Insights = {
  insights: string[];
  questions: string[];
  /** Points the model wrote that the app took out. */
  removed: number;
};

/**
 * The four checks, for any data a model was given. `keep` returns the point
 * as it may be shown, or null; `removed` counts the nulls. The weekly
 * summary (weekly.ts) holds its sentences to these same checks.
 */
export function pointChecker(data: unknown): { keep: (line: string, question: boolean) => string | null; removed: () => number } {
  const allowed = { numbers: numbersOf(data), pairs: pairsOf(data) };
  // A word the person recorded themselves ("Viral fever" as a sick period)
  // may be repeated back. Anything else that names a condition goes.
  const own = JSON.stringify(data).toLowerCase();
  const namesACondition = (line: string) =>
    [...line.toLowerCase().matchAll(new RegExp(`\\b${CONDITION_WORDS}\\b`, 'g'))].some((m) => !own.includes(m[0].replace(/^(?:a|an) /, '').trim()));

  let removed = 0;
  const keep = (line: string, question: boolean): string | null => {
    const text = line.replace(/\*\*/g, '').trim();
    if (!text) return null;
    const ok =
      !filterDoses(text).blocked &&
      checkNumbers(text, allowed).removed.length === 0 &&
      !namesACondition(text) &&
      !ASSERTS.test(text) &&
      !SETS_A_TARGET.test(text) &&
      !(!question && TELLS.test(text)) &&
      (!question || text.endsWith('?'));
    if (!ok) removed++;
    return ok ? text : null;
  };
  return { keep, removed: () => removed };
}

/**
 * The points under each heading of a reply: "- a point" or "1. a point"
 * lines between `name` and `until`, or to the end.
 */
export function sectionOf(reply: string, name: string, until?: string): string[] {
  const start = reply.search(new RegExp(`^\\s*#*\\s*\\**${name}\\**:?\\s*$`, 'im'));
  if (start === -1) return [];
  const rest = reply.slice(start).split('\n').slice(1);
  const end = until ? rest.findIndex((l) => new RegExp(`^\\s*#*\\s*\\**${until}\\**:?\\s*$`, 'i').test(l)) : -1;
  return (end === -1 ? rest : rest.slice(0, end))
    .map((l) => /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(l)?.[1] ?? '')
    .filter(Boolean);
}

/**
 * The model's reply, read into points and held to the four checks.
 *
 * A reply in the wrong shape gives no points and counts nothing as removed:
 * the page then says the insights could not be read, which is true, and not
 * that they were unsafe, which is not known.
 */
export function readInsights(reply: string, x: ExportInput): Insights {
  const { keep, removed } = pointChecker(insightData(x));
  const insights = sectionOf(reply, 'INSIGHTS', 'QUESTIONS').map((l) => keep(l, false)).filter((l): l is string => l !== null).slice(0, MAX_INSIGHTS);
  const questions = sectionOf(reply, 'QUESTIONS').map((l) => keep(l, true)).filter((l): l is string => l !== null).slice(0, MAX_QUESTIONS);
  return { insights, questions, removed: removed() };
}
