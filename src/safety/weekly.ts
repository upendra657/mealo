/**
 * The weekly summary's few lines from Ask Mealo, and the checks they pass.
 *
 * The model writes; it does not judge. What counts as better and what as
 * something to work on is decided by the app (`observations` in
 * domain/week.ts) and handed over as two lists, and the model is told to
 * write about those and nothing else. Left to choose, a model calls a lost
 * kilo progress and a low-calorie day discipline.
 *
 * Every sentence then passes the report insights' four checks (no dose, no
 * figure that is not in the data, no condition named, no target set, no
 * instruction), and what fails is removed and counted, as on the report.
 * Under "To work on" that matters most: "Protein was short of your target on
 * 4 of 6 days" is a fact the person can act on as they choose; "Eat more
 * paneer" is the app telling someone what to eat, and is taken out.
 *
 * Pure: the screen makes the one request and hands the reply here.
 */

import { weekData } from '../domain/week';
import { DATA_HEADER } from '../llm/toolloop';
import type { ChatMessage } from '../llm/types';
import { pointChecker, sectionOf } from './insights';
import { numbersIn, numbersOf } from './numbers';

/** Two of each: past that the summary turns back into a report. */
export const MAX_POINTS = 2;

export const WEEK_PROMPT = [
  'You are writing a short weekly summary for a personal health app. You are',
  'not a clinician and the reader is not your patient.',
  '',
  'You are given DATA: one week of figures the app worked out from what the',
  'person logged, the week before for comparison, and two lists the app has',
  'already decided: "better" and "to_work_on". Use only DATA. Do not add a',
  'figure that is not in it, and do not work out new ones such as percentages.',
  '',
  'Write about the items in "better" under BETTER, and about the items in',
  '"to_work_on" under WORK ON, nothing else under either. Do not decide for',
  'yourself what is better or worse. If a list is empty, leave its heading',
  'with nothing under it. Each point gives the figures of the item it is about.',
  '',
  'Never:',
  '- state or suggest a diagnosis, or name a disease, deficiency or condition;',
  '- mention a dose, or whether to take, skip or change any medicine;',
  '- set or suggest a target, goal or amount, or tell the person what to eat',
  '  or do. State what happened; what to do about it is theirs to decide;',
  '- say that one thing causes another;',
  '- praise or blame. No "great job", no "you failed".',
  '',
  'A day with nothing logged is missing data, not a day without food.',
  '',
  'Answer in exactly this shape, plain text, nothing before or after:',
  '',
  'LEAD',
  '- one sentence about the week as a whole',
  'BETTER',
  `- up to ${MAX_POINTS} points, one sentence each`,
  'WORK ON',
  `- up to ${MAX_POINTS} points, one sentence each`,
].join('\n');

export function weekMessages(data: ReturnType<typeof weekData>): ChatMessage[] {
  return [
    { role: 'system', content: WEEK_PROMPT },
    { role: 'user', content: `${DATA_HEADER}\n${JSON.stringify(data)}` },
  ];
}

export type WeekText = {
  lead: string | null;
  better: string[];
  workOn: string[];
  /** Sentences the model wrote that the app took out. */
  removed: number;
};

/**
 * The reply, read and checked. A reply in the wrong shape gives nothing and
 * counts nothing as removed, as with the report's insights: the screen says
 * it could not be read, which is true, and not that it was unsafe.
 *
 * A point under a heading whose list was empty is removed: the model was
 * told to write nothing there, so whatever it wrote is its own judgement.
 * So is a point that carries none of its own list's figures. Seen on the
 * first render, 16 Oct 2026: "Meals were logged on 6 of 7 days, against 6
 * the week before" under BETTER, every figure true, the week no better. A
 * target or a count of logged days is shared by both lists and anchors
 * nothing; what anchors a point is the figure that moved.
 */
export function readWeekText(reply: string, data: ReturnType<typeof weekData>): WeekText {
  const { keep, removed } = pointChecker(data);
  let dropped = 0;
  const SHARED = new Set(['what', 'target', 'rule', 'logged_days', 'of_due']);
  const anchorsOf = (items: Record<string, unknown>[]) =>
    new Set(items.flatMap((o) => Object.entries(o).filter(([k]) => !SHARED.has(k)).flatMap(([, v]) => numbersOf(v))));
  const anchored = (line: string, anchors: Set<number>) => {
    if (numbersIn(line).some((n) => anchors.has(n))) return true;
    dropped++;
    return false;
  };
  // Past the limit a point is left out unread, as the report's are; it was
  // not unsafe, only one too many. Under an empty list every point counts.
  const points = (name: string, until: string | undefined, allowed: number, anchors?: Set<number>) => {
    const lines = sectionOf(reply, name, until);
    if (allowed === 0) dropped += lines.length;
    return lines
      .slice(0, allowed)
      .map((l) => keep(l, false))
      .filter((l): l is string => l !== null && (!anchors || anchored(l, anchors)));
  };
  const lead = points('LEAD', 'BETTER', 1)[0] ?? null;
  const better = points('BETTER', 'WORK ON', data.better.length ? MAX_POINTS : 0, anchorsOf(data.better));
  const workOn = points('WORK ON', undefined, data.to_work_on.length ? MAX_POINTS : 0, anchorsOf(data.to_work_on));
  return { lead, better, workOn, removed: removed() + dropped };
}
