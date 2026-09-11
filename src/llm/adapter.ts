/**
 * The single provider adapter.
 *
 * Everything speaks the OpenAI chat-completions shape: Groq, Together, Ollama,
 * OpenRouter, and Gemini's compatibility endpoint. That is the whole reason we
 * only write one of these — switching provider is a base URL and a model name,
 * not a new code path.
 */

import {
  LlmError,
  type ChatOptions,
  type ChatResult,
  type ProviderConfig,
  type ToolCall,
} from './types';

/**
 * Ring buffer of outbound payloads.
 *
 * This is how R5 gets verified later: the de-identification boundary belongs at
 * the adapter, not in a prompt, and the only way to know it holds is to look at
 * exactly what went over the wire. Kept in memory only — never persisted.
 */
const OUTBOUND_LOG_LIMIT = 20;
const outboundLog: { at: number; url: string; body: unknown }[] = [];

export function getOutboundLog() {
  return [...outboundLog];
}

export function clearOutboundLog() {
  outboundLog.length = 0;
}

function recordOutbound(url: string, body: unknown) {
  outboundLog.unshift({ at: Date.now(), url, body });
  if (outboundLog.length > OUTBOUND_LOG_LIMIT) outboundLog.pop();
}

function headers(cfg: ProviderConfig): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * A failed fetch with no status is almost always CORS or a dead host, and the
 * browser deliberately refuses to tell us which. Say so plainly rather than
 * reporting a generic network error.
 */
function toLlmError(e: unknown, url: string): LlmError {
  if (e instanceof LlmError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new LlmError(
    `Could not reach ${url}. This is usually CORS (the provider did not allow a browser request from this origin) or the host being unreachable. The browser will not say which.`,
    'cors',
    undefined,
    msg,
  );
}

async function readError(res: Response): Promise<LlmError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return new LlmError(
    `${res.status} ${res.statusText || 'request failed'}`,
    'http',
    res.status,
    body.slice(0, 4000),
  );
}

/**
 * Lists models. This is the connection test: it is cheap, it needs no tokens,
 * and it fails in exactly the same way a real call would — which makes it a
 * reliable CORS canary.
 */
export async function listModels(cfg: ProviderConfig): Promise<string[]> {
  const url = joinUrl(cfg.baseUrl, 'models');
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: headers(cfg) });
  } catch (e) {
    throw toLlmError(e, url);
  }
  if (!res.ok) throw await readError(res);
  try {
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id).sort();
  } catch (e) {
    throw new LlmError(
      'The endpoint answered but the body was not the expected JSON.',
      'parse',
      res.status,
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function chat(
  cfg: ProviderConfig,
  opts: ChatOptions,
): Promise<ChatResult> {
  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  const body = {
    model: cfg.model,
    messages: opts.messages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    stream: false,
  };

  recordOutbound(url, body);

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw toLlmError(e, url);
  }
  if (!res.ok) throw await readError(res);

  type Payload = {
    model?: string;
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] };
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  let json: Payload;
  try {
    json = (await res.json()) as Payload;
  } catch (e) {
    throw new LlmError(
      'The provider returned a non-JSON body.',
      'parse',
      res.status,
      e instanceof Error ? e.message : String(e),
    );
  }

  const message = json.choices?.[0]?.message;
  return {
    text: message?.content ?? '',
    toolCalls: message?.tool_calls ?? [],
    model: json.model,
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
    ms: Math.round(performance.now() - started),
  };
}
