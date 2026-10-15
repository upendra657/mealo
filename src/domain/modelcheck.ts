/**
 * The model check (Dev → Ask Mealo): does this model do the job Ask Mealo
 * gives it, on this key, before anyone relies on it.
 *
 * Asked for on 15 Oct 2026 after his Groq default (openai/gpt-oss-20b)
 * answered "Meals logged" with nothing logged, having ignored the lookups.
 * Two questions, his number, a minute apart so the pair stays under a free
 * tier's tokens a minute (Groq: 8,000; a question that looks something up
 * costs 5,000 to 6,000). Each goes out exactly as a real one would: Ask
 * Mealo's own instructions and list of lookups, through the same adapter,
 * so the same de-identification and the same outbound log apply. What is
 * different is the record: made up, here, so nothing of anyone's leaves the
 * phone for a check.
 *
 * Three things are judged, each as the chat already judges them:
 *
 *   it looks things up    it asked for the lookup that answers the
 *                         question, before answering;
 *   it answers            words came back after the lookup (a thinking
 *                         model has been seen to spend its allowance and
 *                         return nothing);
 *   it keeps to figures   every number in the answer is in what it was
 *                         given, by safety/numbers.ts, the check that
 *                         removes such sentences from a real answer.
 *
 * Only on a tap: it spends the person's allowance (his call: not on its own
 * when the model changes).
 */

import { kvGet, kvSet } from '../lib/kv';
import { chat } from '../llm/adapter';
import { chatWithTools } from '../llm/toolloop';
import type { ChatOptions, ChatResult, ProviderConfig, RateLimits } from '../llm/types';
import { checkNumbers, numbersIn, numbersOf } from '../safety/numbers';
import { SYSTEM_PROMPT } from '../llm/askprompt';
import { TOOLS, type ToolName } from './tools';

/** Between the two questions, so the pair stays under a per-minute token limit. */
export const SPACING_MS = 60_000;

export type CheckQuestion = {
  id: 'meals' | 'meds';
  ask: string;
  /** The lookup that answers it, and what its arguments must say. */
  expect: ToolName;
  argsOk: (args: Record<string, unknown>) => boolean;
  /** What that lookup returns here: a made-up record. */
  record: unknown;
};

/**
 * Made up, every figure: no one's record goes out for a check. Shaped field
 * for field like what thali_day and dawa_adherence really return (a test
 * holds them to it), so a model is judged on the data it will really get:
 * "13 of 14 doses" is fair because the real lookup gives `scheduled`.
 */
export const QUESTIONS: readonly CheckQuestion[] = [
  {
    id: 'meals',
    ask: 'What did I eat yesterday?',
    expect: 'thali_day',
    argsOk: (a) => Number(a.days_ago) === 1,
    record: {
      day: 'Wed 14 Oct',
      meals: [
        { slot: 'breakfast', time: '8:30 am', dishes: [
          { dish: 'Poha', amount: '1 katori (150 ml)', grams: 150, calories: 270, protein_g: 6, carbs_g: 45, fat_g: 7, fibre_g: 3 },
        ] },
        { slot: 'dinner', time: '8:45 pm', dishes: [
          { dish: 'Dal', amount: '1 katori (150 ml)', grams: 150, calories: 180, protein_g: 9, carbs_g: 24, fat_g: 5, fibre_g: 6 },
          { dish: 'Rice', amount: '1 katori (150 ml)', grams: 150, calories: 200, protein_g: 4, carbs_g: 44, fat_g: 0.5, fibre_g: 0.6 },
        ] },
      ],
      totals_eaten: { calories: 650, protein_g: 19, carbs_g: 113, fat_g: 12.5, fibre_g: 9.6 },
      targets: { calories: null, protein_g: null, carbs_g: null, fat_g: null, fibre_g: null },
      note: 'A dish marked not_eaten was planned and is counted in no total.',
    },
  },
  {
    id: 'meds',
    ask: 'Have I been taking my medicines this week?',
    expect: 'dawa_adherence',
    argsOk: (a) => Number(a.days) >= 7,
    record: {
      period: 'Thu 8 Oct to Wed 14 Oct',
      doses: { scheduled: 14, taken: 13, skipped: 0, missed: 1, still_due_today: 0 },
      not_taken: [{ medicine: 'Iron', time_of_day: 'morning', skipped: 0, missed: 1 }],
      medicines: [
        { name: 'Iron 100 mg', as_entered_by_the_person: ['1 tablet, morning, after food'], schedule: 'Every day' },
        { name: 'Vitamin D3 1000 IU', as_entered_by_the_person: ['1 tablet, night, after food'], schedule: 'Every day' },
      ],
      sick_periods: [],
      note: 'Missed means a dose was due, was never answered, and its day is over. Whether to take, skip or change any medicine is for the prescriber, never for you.',
    },
  },
];

/** The slice a question goes out with: honest that nothing else is known. */
const SLICE = 'Record for this check (made up): nothing logged today. Use the tools for anything else.';

export type QuestionResult = {
  id: CheckQuestion['id'];
  ask: string;
  /** Asked for any lookup at all. */
  lookedUp: boolean;
  /** Asked for the one that answers this question, with sensible arguments. */
  rightLookup: boolean;
  answered: boolean;
  answer: string;
  /** Sentences whose figures were in nothing it was given. */
  invented: string[];
  requests: number;
  tokens: number;
  ms: number;
  error?: string;
  limits?: RateLimits;
};

export type Verdict = 'good' | 'partly' | 'poor' | 'failed';

export type CheckResult = {
  model: string;
  provider: string;
  at: number;
  verdict: Verdict;
  questions: QuestionResult[];
  requests: number;
  tokens: number;
  ms: number;
  limits?: RateLimits;
};

/**
 * Good: every question looked up the right thing, answered, and kept to its
 * figures. Poor: it never looked anything up, so Ask Mealo would be working
 * from the day's summary alone. Partly: anything between. Failed: the
 * provider refused or could not be reached, which says nothing of the model.
 */
export function verdictOf(qs: readonly QuestionResult[]): Verdict {
  if (qs.some((q) => q.error)) return 'failed';
  if (qs.every((q) => !q.lookedUp)) return 'poor';
  if (qs.every((q) => q.rightLookup && q.answered && q.invented.length === 0)) return 'good';
  return 'partly';
}

/** One question, as Ask Mealo would ask it, against the made-up record. */
export async function runQuestion(
  settings: ProviderConfig,
  q: CheckQuestion,
  ask: (cfg: ProviderConfig, o: ChatOptions) => Promise<ChatResult> = chat,
): Promise<QuestionResult> {
  let tokens = 0;
  let requests = 0;
  let limits: RateLimits | undefined;
  const started = performance.now();
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'system' as const, content: SLICE },
    { role: 'user' as const, content: q.ask },
  ];
  const base = { id: q.id, ask: q.ask, lookedUp: false, rightLookup: false, answered: false, answer: '', invented: [] as string[] };
  try {
    const loop = await chatWithTools(
      async (o) => {
        const r = await ask(settings, o);
        requests++;
        tokens += r.usage.totalTokens ?? 0;
        if (r.limits && (r.limits.tokensPerMinute !== null || r.limits.requestsPerDay !== null)) limits = r.limits;
        return r;
      },
      {
        messages,
        tools: TOOLS,
        // The made-up record for the lookup this question needs; for any
        // other, what a lookup with nothing logged would say.
        run: async (name) => (name === q.expect ? q.record : name.startsWith('propose_') || name === 'prepare_report' ? { shown: true } : { note: 'Nothing logged for this.' }),
        temperature: 0.3,
        maxTokens: 1500,
      },
    );
    const answer = loop.text.trim();
    const allowed = {
      numbers: [...messages.flatMap((m) => numbersIn(m.content)), ...loop.runs.flatMap((r) => [...numbersOf(r.result), ...numbersOf(r.args)])],
      pairs: [],
    };
    return {
      ...base,
      lookedUp: loop.runs.length > 0,
      rightLookup: loop.runs.some((r) => r.name === q.expect && q.argsOk(r.args)),
      answered: answer.length > 0,
      answer,
      invented: answer ? checkNumbers(answer, allowed).removed : [],
      requests,
      tokens,
      ms: Math.round(performance.now() - started),
      limits,
    };
  } catch (e) {
    return { ...base, requests, tokens, ms: Math.round(performance.now() - started), error: e instanceof Error ? e.message : String(e), limits };
  }
}

/**
 * Both questions, a minute apart. `onStep` says what is happening, for the
 * screen; `wait` is there so the tests need not sit through the minute.
 */
export async function runCheck(
  settings: ProviderConfig & { provider: string },
  onStep: (s: { question: number; waitingMs?: number }) => void = () => {},
  ask: (cfg: ProviderConfig, o: ChatOptions) => Promise<ChatResult> = chat,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<CheckResult> {
  const questions: QuestionResult[] = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const started = Date.now();
    onStep({ question: i + 1 });
    const r = await runQuestion(settings, q, ask);
    questions.push(r);
    // A refusal (a wrong key, a limit already hit) is the answer; asking
    // again a minute later would only spend more.
    if (r.error) break;
    if (i < QUESTIONS.length - 1) {
      for (let left = SPACING_MS - (Date.now() - started); left > 0; left -= 1000) {
        onStep({ question: i + 2, waitingMs: left });
        await wait(Math.min(1000, left));
      }
    }
  }
  const result: CheckResult = {
    model: settings.model,
    provider: settings.provider,
    at: Date.now(),
    verdict: verdictOf(questions),
    questions,
    requests: questions.reduce((a, q) => a + q.requests, 0),
    tokens: questions.reduce((a, q) => a + q.tokens, 0),
    ms: questions.reduce((a, q) => a + q.ms, 0),
    limits: [...questions].reverse().find((q) => q.limits)?.limits,
  };
  return result;
}

// ------------------------------------------------- remembered, per model

const CHECKS_KV = 'modelcheck.results';

/** The last check of each model on this phone, newest first. */
export async function checksSoFar(): Promise<CheckResult[]> {
  const all = (await kvGet<Record<string, CheckResult>>(CHECKS_KV)) ?? {};
  return Object.values(all).sort((a, b) => b.at - a.at);
}

/** Kept by the screen after a check, so the list can compare models. */
export async function rememberCheck(r: CheckResult): Promise<void> {
  const all = (await kvGet<Record<string, CheckResult>>(CHECKS_KV)) ?? {};
  all[`${r.provider}|${r.model}`] = r;
  await kvSet(CHECKS_KV, all);
}

/** One line for a check, in the list of checks on this phone. */
export function summaryOf(r: CheckResult): string {
  if (r.verdict === 'failed') return 'could not be checked';
  if (r.verdict === 'poor') return 'does not look things up';
  if (r.verdict === 'partly') return 'partly reliable';
  return `good · ${r.tokens.toLocaleString('en-US')} tokens`;
}
