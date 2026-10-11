/**
 * Make the key pair that lets this deployment send reminders.
 *
 *   node scripts/vapid-keys.mjs
 *
 * Run it yourself, on your own machine. It prints two values and keeps
 * nothing: no file is written and nothing is sent anywhere. Then give them
 * to the Worker as secrets, one at a time, pasting each when wrangler asks:
 *
 *   npx wrangler secret put VAPID_PUBLIC_KEY
 *   npx wrangler secret put VAPID_PRIVATE_KEY
 *   npx wrangler secret put VAPID_SUBJECT     (mailto:you@example.com, or the app's https URL)
 *
 * The private key is what proves a push comes from your relay. Do not put it
 * in a file in the repo, in a chat, or anywhere but that prompt. If it is
 * ever lost or shown to anyone, run this again and set both keys afresh;
 * each phone then turns reminders off and on once.
 *
 * The public key is not a secret. Phones are handed it by /push/key.
 */

import { webcrypto } from 'node:crypto';

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

console.log('VAPID_PUBLIC_KEY   (not secret)');
console.log(b64url(raw));
console.log('');
console.log('VAPID_PRIVATE_KEY  (secret: paste it only into `wrangler secret put`)');
console.log(jwk.d);
