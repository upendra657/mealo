/**
 * Provider registry.
 *
 * Every provider here is selectable. The app does not refuse any of them — it
 * states the data policy at the moment the key is entered and lets the user
 * decide, because it is genuinely their call to make.
 *
 * `trains` is the one field that matters for that decision:
 *   'no'      provider states it does not train on inputs or outputs
 *   'free'    the free tier trains; paid tiers do not
 *   'local'   nothing leaves the machine
 */

export type TrainsPolicy = 'no' | 'free' | 'local';

export type Provider = {
  key: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  trains: TrainsPolicy;
  /** Shown verbatim next to the key field. Keep it factual. */
  policy: string;
  /** Practical free-tier ceiling, where there is one. */
  limits?: string;
  /** Anything that will otherwise cost an hour of debugging. */
  note?: string;
  needsKey: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    key: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    trains: 'no',
    policy:
      'States that customer inputs and outputs are not used to train models, across all tiers. Logs retained around 30 days and can be disabled. Verify against the Groq Services Agreement and DPA before trusting it with medication data.',
    limits: '30 req/min · 8K tokens/min · 200K tokens/day on the free tier',
  },
  {
    key: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    trains: 'no',
    policy:
      'States that customer data is not used to train models without explicit opt-in, on all tiers.',
  },
  {
    key: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1:8b',
    trains: 'local',
    policy:
      'Runs on your own machine. Nothing leaves the device, and no third party sees any part of your health log.',
    note:
      'Ollama refuses cross-origin browser requests by default. Set OLLAMA_ORIGINS to this app\'s origin, or every call will fail as CORS against your own computer.',
    needsKey: false,
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    trains: 'free',
    policy:
      'On the free tier Google uses submitted content to provide, improve and develop its products, and states that human reviewers may read, annotate and process API input and output. The paid tier does not. Free use gets paid-tier data terms only in the EEA, UK and Switzerland.',
    note:
      'Browser calls to the Gemini endpoints have a history of failing CORS. Test the connection before relying on it from a deployed page.',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    trains: 'free',
    policy:
      'Free models require enabling both "free endpoints that may train on request data" and "free endpoints that may publish prompts" in your OpenRouter privacy settings. Paid endpoints do not.',
  },
  {
    key: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    trains: 'no',
    policy:
      'Whatever the operator of this endpoint says it is. If you did not deploy it yourself, find out before sending anything from your health log.',
  },
].map((p) => ({ needsKey: true, ...p })) as Provider[];

export function getProvider(key: string): Provider {
  return PROVIDERS.find((p) => p.key === key) ?? PROVIDERS[0];
}

export function policyTone(t: TrainsPolicy): 'good' | 'warn' {
  return t === 'free' ? 'warn' : 'good';
}

export function policyLabel(t: TrainsPolicy): string {
  switch (t) {
    case 'no':
      return 'does not train on your data';
    case 'local':
      return 'stays on your device';
    case 'free':
      return 'free tier trains on your data';
  }
}
