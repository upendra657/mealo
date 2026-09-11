export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: Role;
  content: string;
  /** Set on role: 'tool' replies. */
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ProviderConfig = {
  /** Provider key from providers.ts, e.g. 'groq'. */
  provider: string;
  /** Base URL including the version segment, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type ChatOptions = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model?: string;
  /** Wall-clock milliseconds for the request. */
  ms: number;
};

/**
 * Errors carry the raw response body. "Invalid API key" covers a wrong project,
 * a disabled API, a region problem and a CORS failure, and guessing between
 * them costs an evening — so we surface exactly what came back.
 */
export class LlmError extends Error {
  status?: number;
  body?: string;
  kind: 'network' | 'cors' | 'http' | 'parse';

  constructor(
    message: string,
    kind: LlmError['kind'],
    status?: number,
    body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}
