/**
 * The single provider adapter.
 *
 * Everything speaks the OpenAI chat-completions shape: Groq, Together, Ollama,
 * OpenRouter, and Gemini's compatibility endpoint. That is the whole reason we
 * only write one of these — switching provider is a base URL and a model name,
 * not a new code path.
 */

import {
  deidentify,
  type Identity,
  type Redaction,
} from '../safety/deidentify';
import { getDeviceId } from '../lib/device';
import { loadHousehold } from '../lib/household';
import { listProfiles, PRIMARY_PROFILE } from '../profiles/store';
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
export const OUTBOUND_LOG_LIMIT = 20;

export type OutboundEntry = {
  at: number;
  url: string;
  body: unknown;
  /** What the boundary took out on the way past. Empty is the normal state. */
  redactions: Redaction[];
};

const outboundLog: OutboundEntry[] = [];

export function getOutboundLog(): OutboundEntry[] {
  return [...outboundLog];
}

export function clearOutboundLog() {
  outboundLog.length = 0;
}

function recordOutbound(url: string, body: unknown, redactions: Redaction[]) {
  outboundLog.unshift({ at: Date.now(), url, body, redactions });
  if (outboundLog.length > OUTBOUND_LOG_LIMIT) outboundLog.pop();
}

/**
 * The identifiers this install must never emit.
 *
 * Cached after the first call: the device id and the profile list change
 * roughly never, and a database read in front of every model call would be a
 * silly price for a property that is checked in microseconds.
 *
 * Failing open would defeat the point, so a lookup that throws is treated as
 * "assume everything is secret and scrub what can be recognised by shape" —
 * the shape rules below do not need the identity list at all.
 */
let identityCache: Identity | null = null;

export function clearIdentityCache() {
  identityCache = null;
}

async function identity(): Promise<Identity> {
  if (identityCache) return identityCache;
  try {
    const [device, profiles] = await Promise.all([getDeviceId(), listProfiles()]);
    const household = await loadHousehold().catch(() => null);
    identityCache = {
      // 'primary' is excluded on purpose: it is the fixed id every install
      // shares, so it identifies nobody, and scrubbing a common English word
      // out of every payload would mangle ordinary sentences.
      secrets: [
        device,
        household?.id ?? '',
        ...profiles.map((p) => p.id).filter((id) => id !== PRIMARY_PROFILE),
      ].filter(Boolean),
      names: profiles.map((p) => p.name).filter(Boolean),
    };
  } catch {
    identityCache = { secrets: [], names: [] };
  }
  return identityCache;
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

  // R5. The boundary is here and nowhere else: this is the only function in
  // the app that calls fetch with a model payload, so whatever leaves has
  // passed through it regardless of which caller assembled the messages or
  // how careful that caller was. Upstream composition staying clean is still
  // the intent — see domain/state.ts — but intent is not enforcement.
  const { messages, redactions } = deidentify(opts.messages, await identity());

  const body = {
    model: cfg.model,
    messages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    stream: false,
  };

  // Logged after scrubbing, deliberately. The log exists to show what went
  // over the wire; recording the pre-scrub payload would make it a record of
  // something that never left, and would itself hold the identifiers.
  recordOutbound(url, body, redactions);

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
