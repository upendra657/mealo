import { kvGet, kvSet } from '../lib/kv';
import { getProvider, PROVIDERS } from '../llm/providers';
import type { ProviderConfig } from '../llm/types';

const KEY = 'settings.provider';

export type Settings = ProviderConfig & {
  /**
   * Which classes of data may go to a provider whose free tier trains on it.
   * Phase 4 enforces this at the adapter; Phase 0 just records the choice.
   */
  allowTrainingProviderFor: {
    nutrition: boolean;
    medications: boolean;
    symptoms: boolean;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  baseUrl: getProvider('ollama').baseUrl,
  model: getProvider('ollama').defaultModel,
  apiKey: '',
  allowTrainingProviderFor: {
    nutrition: true,
    medications: false,
    symptoms: false,
  },
};

export async function loadSettings(): Promise<Settings> {
  const stored = await kvGet<Partial<Settings>>(KEY);
  if (!stored) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    allowTrainingProviderFor: {
      ...DEFAULT_SETTINGS.allowTrainingProviderFor,
      ...(stored.allowTrainingProviderFor ?? {}),
    },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await kvSet(KEY, s);
}

/** Applies a provider's defaults without clobbering a key the user already typed. */
export function withProvider(s: Settings, providerKey: string): Settings {
  const p = getProvider(providerKey);
  return {
    ...s,
    provider: p.key,
    baseUrl: p.baseUrl || s.baseUrl,
    model: p.defaultModel || s.model,
  };
}

export function isConfigured(s: Settings): boolean {
  const p = getProvider(s.provider);
  if (!s.baseUrl || !s.model) return false;
  if (p.needsKey && !s.apiKey) return false;
  return true;
}

export { PROVIDERS };
