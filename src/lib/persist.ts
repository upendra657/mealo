/**
 * Storage durability.
 *
 * On iOS a home-screen web app gets the same storage quota as a browser tab and
 * is subject to the same eviction. The documented exemption is persistent mode,
 * requested through navigator.storage.persist().
 *
 * Asking is free and the answer is worth surfacing: if the browser refuses,
 * the user needs to know that their only copy is evictable, which is the whole
 * argument for shipping an export button in Phase 1.
 */

export type PersistState = {
  supported: boolean;
  persisted: boolean;
  /** Bytes currently used, when the browser will tell us. */
  usage?: number;
  /** Bytes available to this origin, when the browser will tell us. */
  quota?: number;
};

export async function checkPersisted(): Promise<PersistState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return { supported: false, persisted: false };
  }
  try {
    const persisted = await navigator.storage.persisted();
    const estimate = navigator.storage.estimate
      ? await navigator.storage.estimate()
      : undefined;
    return {
      supported: true,
      persisted,
      usage: estimate?.usage,
      quota: estimate?.quota,
    };
  } catch {
    return { supported: false, persisted: false };
  }
}

/**
 * Request persistent storage. Safe to call on every start — browsers that have
 * already granted it return true immediately, and ones that refuse keep
 * refusing without prompting repeatedly.
 */
export async function requestPersist(): Promise<PersistState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return { supported: false, persisted: false };
  }
  try {
    await navigator.storage.persist();
  } catch {
    /* fall through to reporting whatever the current state is */
  }
  return checkPersisted();
}

export function formatBytes(n?: number): string {
  if (n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
