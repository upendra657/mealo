/**
 * Structured extraction: free text in, a typed object out.
 *
 * Used wherever the model's job is to turn something a person typed into a row
 * we can store — "creatine 5g every morning" into a medication record. The model
 * does language here, nothing else: it never decides whether a dose is sensible,
 * only what the words say.
 */

import { chat } from './adapter';
import { LlmError, type ProviderConfig } from './types';

/**
 * Strips everything that isn't JSON.
 *
 * Reasoning models emit their scratchpad before the answer, and several wrap
 * output in markdown fences even when told not to. Both are normal, and both
 * break JSON.parse, so handle them rather than fighting the prompt.
 */
export function extractJsonBlock(raw: string): string {
  let s = raw.trim();

  // <think>…</think>, <reasoning>…</reasoning> and friends.
  s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
  // An unclosed opener means the whole thing was scratchpad.
  s = s.replace(/^<(think|thinking|reasoning)>[\s\S]*$/i, '').trim();

  // ```json … ``` or plain ``` … ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Fall back to the outermost braces.
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }

  return s;
}

export type ExtractOptions = {
  /** Describes the job and the exact shape wanted. */
  system: string;
  /** The user's raw text. */
  user: string;
  /** Keeps output small and predictable. */
  maxTokens?: number;
};

export async function extractJson<T>(
  cfg: ProviderConfig,
  opts: ExtractOptions,
): Promise<T> {
  const result = await chat(cfg, {
    messages: [
      {
        role: 'system',
        content:
          `${opts.system}\n\n` +
          'Reply with JSON and nothing else. No prose, no markdown fences, no ' +
          'explanation. If a field is unknown, use null rather than guessing.',
      },
      { role: 'user', content: opts.user },
    ],
    temperature: 0,
    maxTokens: opts.maxTokens ?? 400,
  });

  const cleaned = extractJsonBlock(result.text);
  if (!cleaned) {
    throw new LlmError(
      'The model returned nothing usable. If it is a reasoning model, it may ' +
        'have spent its whole output budget thinking — try raising max tokens ' +
        'or turning thinking off.',
      'parse',
      undefined,
      result.text.slice(0, 500),
    );
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new LlmError(
      'The model did not return valid JSON.',
      'parse',
      undefined,
      `${e instanceof Error ? e.message : String(e)}\n\n--- got ---\n${cleaned.slice(0, 800)}`,
    );
  }
}
