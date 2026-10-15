/*
 * Reminders, in the service worker.
 *
 * Pulled into the generated worker by `importScripts` (vite.config.ts). Plain
 * JavaScript with no imports, because the generated worker is not a module.
 *
 * The push that arrives is empty: the relay knows when to ring this phone
 * and nothing else. What to say was written here, on the phone, by the app
 * the last time it was used: a list of rings in IndexedDB, each with its
 * minute, a title and a line of text. This reads the list, shows whatever
 * falls on this minute, and remembers that it did.
 *
 * Every push shows a notification. iOS withdraws a subscription after three
 * pushes that show nothing, so when the list has nothing for this minute (a
 * phone restored from a backup, a list that was cleared) there is still a
 * plain line to show, and it is shown.
 */

const KV_DB = 'mealo-kv';
const KV_STORE = 'kv';
const NOTE_KEY = 'reminders.note';

/** A push may come a minute early, or up to an hour late from a phone that was off. */
const EARLY_MS = 90 * 1000;
const LATE_MS = 65 * 60 * 1000;

/**
 * The rings to show for a push arriving at `now`.
 *
 * Its own function, with nothing but its arguments, so the test can load
 * this file and call it (scripts/test-portions.ts).
 */
function pickRings(note, now) {
  if (!Array.isArray(note)) return [];
  return note.filter((r) => r && !r.shown && typeof r.at === 'number' && r.at <= now + EARLY_MS && r.at > now - LATE_MS);
}

/** What is shown when the list has nothing for this minute. */
const FALLBACK = { kind: 'open', title: 'Mealo', body: 'A reminder. Open Mealo to see what is due.' };

function kv() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KV_DB, 1);
    // The app made this database long before any push could arrive. Should
    // the worker ever get there first, it makes the same one.
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV_STORE)) req.result.createObjectStore(KV_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function kvRead(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function kvWrite(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function onPush() {
  let rings = [];
  try {
    const db = await kv();
    const note = await kvRead(db, NOTE_KEY);
    const now = Date.now();
    rings = pickRings(note, now);
    if (rings.length) {
      await kvWrite(db, NOTE_KEY, note.map((r) => (rings.includes(r) ? { ...r, shown: true } : r)));
    }
  } catch {
    // Reading the list failed. The fallback below still shows.
  }
  if (rings.length === 0) rings = [FALLBACK];
  await Promise.all(
    rings.map((r) =>
      self.registration.showNotification(r.title, {
        body: r.body,
        // One of each kind on screen: this morning's line replaces
        // yesterday's if that was never opened, and does not stack on it.
        tag: `mealo-${r.kind}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { kind: r.kind },
      }),
    ),
  );
}

if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('push', (event) => {
    event.waitUntil(onPush());
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // The Sunday ring opens on the week, in Ask Mealo. A window already open
    // is told so; a closed app is opened with it in the address, which the
    // app reads once and takes out again.
    const week = event.notification.data && event.notification.data.kind === 'week';
    event.waitUntil(
      (async () => {
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (open.length) {
          if (week) open[0].postMessage({ open: 'week' });
          return open[0].focus();
        }
        return self.clients.openWindow(week ? '/?open=week' : '/');
      })(),
    );
  });
}
