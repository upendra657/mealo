/**
 * The household key, and the envelope everything travels in.
 *
 * Sync puts the food library on a relay that is not this device. The relay is
 * a Cloudflare Worker on your own account, but "your own account" is not the
 * promise this app makes — P1 says the database never leaves the device, and
 * the only honest way to keep that while still syncing is for what leaves to
 * be ciphertext. So the relay stores opaque blobs, keyed by a household id,
 * and cannot read a single dish name.
 *
 * Two values make a household:
 *
 *   id   16 random bytes, public. Names the shared inbox on the relay. It is
 *        generated independently of the key, not derived from it — a relay
 *        that could derive one from the other would be one step from the
 *        other direction.
 *   key  32 random bytes, secret, AES-GCM. Never sent anywhere. Lives in
 *        IndexedDB beside the provider keys, not in SQLite, so wiping the
 *        database does not silently break pairing.
 *
 * Both are carried between phones as one base32 string. That string is the
 * household: anyone holding it can read everything either of you logs to the
 * library, so it travels the way you would hand someone a door key, not the
 * way you would post an address.
 *
 * What this does NOT do: key rotation, forward secrecy, or per-device
 * identity. Two people, one library, one key. When the health tables join in
 * Phase 5 that bar goes up and the passphrase story starts — this is
 * deliberately the small version, and it is written so the envelope is the
 * only thing that has to change.
 */

import { kvGet, kvSet } from './kv';

const KEY_KV = 'household.key';
const ID_KV = 'household.id';

export type Household = { id: string; key: CryptoKey };

/** Base32 (RFC 4648, no padding). Case-insensitive to read aloud. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  // 0/1 are not in the alphabet and are the two characters people most often
  // type for O and I, so they are folded rather than rejected.
  const clean = s.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" is not part of a pairing code.`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const ID_BYTES = 16;
const KEY_BYTES = 32;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * A copy backed by a plain ArrayBuffer.
 *
 * WebCrypto's types insist on ArrayBuffer rather than ArrayBufferLike, since
 * a SharedArrayBuffer could be written to mid-operation. Nothing here is
 * shared, but the copy is cheap and it is a real hazard in general — so take
 * the copy rather than casting the type away.
 */
function bytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(raw), { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** A brand-new household. Called once, on whichever phone goes first. */
export async function createHousehold(): Promise<{ household: Household; code: string }> {
  const id = randomBytes(ID_BYTES);
  const key = randomBytes(KEY_BYTES);
  const code = pairingCode(id, key);
  const household = { id: toBase32(id), key: await importKey(key) };
  await save(household.id, key);
  return { household, code };
}

/** id ++ key, base32, grouped in fives so it can be read off a screen. */
export function pairingCode(id: Uint8Array, key: Uint8Array): string {
  const both = new Uint8Array(id.length + key.length);
  both.set(id, 0);
  both.set(key, id.length);
  return (toBase32(both).match(/.{1,5}/g) ?? []).join('-');
}

/** Join an existing household from the code the other phone showed. */
export async function joinHousehold(code: string): Promise<Household> {
  const bytes = fromBase32(code);
  if (bytes.length < ID_BYTES + KEY_BYTES) {
    throw new Error('That code is too short to be a pairing code.');
  }
  const id = bytes.slice(0, ID_BYTES);
  const key = bytes.slice(ID_BYTES, ID_BYTES + KEY_BYTES);
  const household = { id: toBase32(id), key: await importKey(key) };
  await save(household.id, key);
  return household;
}

async function save(id: string, rawKey: Uint8Array) {
  await kvSet(ID_KV, id);
  await kvSet(KEY_KV, toBase32(rawKey));
}

/** The household this device belongs to, or null if it has not paired. */
export async function loadHousehold(): Promise<Household | null> {
  const id = await kvGet<string>(ID_KV);
  const raw = await kvGet<string>(KEY_KV);
  if (!id || !raw) return null;
  return { id, key: await importKey(fromBase32(raw)) };
}

export async function leaveHousehold(): Promise<void> {
  await kvSet(ID_KV, null);
  await kvSet(KEY_KV, null);
}

/**
 * Seal a batch. A fresh 12-byte nonce per call, prefixed to the ciphertext.
 *
 * Reusing a nonce with the same key is the one way to break AES-GCM
 * catastrophically, so it is generated here and never derived from anything
 * about the batch — not the cursor, not the row count, not the clock.
 */
export async function seal(key: CryptoKey, plain: string): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(iv) },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + body.length);
  out.set(iv, 0);
  out.set(body, iv.length);
  return out;
}

export async function open(key: CryptoKey, sealed: Uint8Array): Promise<string> {
  const iv = bytes(sealed.slice(0, 12));
  const body = bytes(sealed.slice(12));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  return new TextDecoder().decode(plain);
}
