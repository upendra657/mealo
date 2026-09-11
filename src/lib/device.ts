/**
 * Device identity and row ids.
 *
 * Every row in the database carries an id that is unique across devices without
 * coordination, and an `updated_at` timestamp. Both exist from the very first
 * migration because whichever sync path we choose later will require them, and
 * retrofitting them once real logged data exists is genuinely painful.
 */

import { kvGet, kvSet } from './kv';

const DEVICE_ID_KEY = 'device.id';

let cachedDeviceId: string | null = null;

function randomId(): string {
  const c: Crypto | undefined =
    typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    // Fallback for engines without randomUUID: 16 random bytes, hex encoded.
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('no secure random source available');
}

/** Stable per-device identifier. Created once, then reused forever. */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id = await kvGet<string>(DEVICE_ID_KEY);
  if (!id) {
    id = randomId();
    await kvSet(DEVICE_ID_KEY, id);
  }
  cachedDeviceId = id;
  return id;
}

/**
 * Device-scoped row id: `<8 chars of device id>-<uuid>`.
 *
 * The device prefix means two devices editing while offline cannot collide, and
 * it makes it obvious at a glance where a row originated when debugging sync.
 */
export async function newId(): Promise<string> {
  const device = await getDeviceId();
  return `${device.replace(/-/g, '').slice(0, 8)}-${randomId()}`;
}

/** Milliseconds since epoch. Used for every `updated_at`. */
export function now(): number {
  return Date.now();
}
