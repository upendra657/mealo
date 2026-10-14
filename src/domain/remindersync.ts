/**
 * Reminders: the browser side. Turning them on, and keeping the phone's
 * next fortnight of rings in step with the record.
 *
 * Three parties, and what each knows:
 *
 *   The phone knows everything, and writes the words. Each time the record
 *   changes it works out the next fourteen days of rings and keeps the list,
 *   with its titles and text, in its own IndexedDB.
 *
 *   The relay is sent the times and nothing else: a list of minutes for this
 *   browser. No medicine, no meal, no name. At each minute it sends an empty
 *   push.
 *
 *   The service worker wakes on the push, reads the phone's own list, and
 *   shows what falls on that minute (public/push-sw.js).
 *
 * The whole list is sent each time and replaces the last, so a dose ticked
 * at 8:50 is simply not in the list sent at 8:50 and its 9:00 ring is gone.
 * There is no cancel message to lose.
 *
 * The list runs out. If the app is not opened for fourteen days, the rings
 * stop. That is chosen over a standing daily ring the relay repeats for
 * ever: a medicine stopped on the phone must not keep ringing because the
 * phone never said so.
 */

import { activeProfile } from '../lib/active-profile';
import { onChange } from '../lib/changes';
import { kvDelete, kvGet, kvSet } from '../lib/kv';
import { medDay } from './doses';
import { readMedsDay } from './medications';
import { itemsFor, mealsOn, startOfToday } from './meals';
import { counts } from './plan';
import {
  calendarDay,
  doseRings,
  inOrder,
  mealRings,
  readSettings,
  scheduleDays,
  testRingAt,
  testRingTime,
  type ReminderSettings,
  type Ring,
} from './reminders';

const SETTINGS_KEY = 'reminders.settings';
/** The same key public/push-sw.js reads. */
const NOTE_KEY = 'reminders.note';
/** What happened the last time the list was handed to the relay. */
const STATE_KEY = 'reminders.state';
/** A test ring asked for and not yet due, kept so a rebuild before it rings keeps it. */
const TEST_KEY = 'reminders.test';

/**
 * The last hand-over, for the card to say. Before 15 Oct 2026 a refused list
 * went to the console and the card still read "on"; this is what lets it say
 * "Working, next at 07:00" or "the relay did not take it, at 07:12".
 */
export type RelayState = {
  /** When the list was sent. */
  at: number;
  ok: boolean;
  /** The relay's HTTP status; 0 when it could not be reached at all. */
  status: number;
  /** Rings in the list sent. */
  count: number;
  /** The first ring in it, and the last. */
  next: { at: number; title: string } | null;
  until: number | null;
};

export async function loadRelayState(): Promise<RelayState | null> {
  return (await kvGet<RelayState>(STATE_KEY)) ?? null;
}

export async function loadReminders(): Promise<ReminderSettings> {
  return readSettings(await kvGet(SETTINGS_KEY));
}

/**
 * Where reminders stand on this phone, for the settings card to say.
 *
 * 'needs-install' is the iPhone case: web push exists there only for an app
 * added to the Home Screen (iOS 16.4 on), and in a Safari tab the push
 * manager is simply absent, which would otherwise read as "not supported".
 */
export type Standing = 'unsupported' | 'needs-install' | 'not-set-up' | 'blocked' | 'off' | 'on';

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** The relay's public key, or null when this deployment has no push set up. */
async function relayKey(): Promise<string | null> {
  try {
    const res = await fetch('/push/key', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { key?: unknown };
    return typeof body.key === 'string' && body.key.length > 40 ? body.key : null;
  } catch {
    // Offline, or the dev server, which has no relay and answers with HTML.
    return null;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  // Not `serviceWorker.ready`: with no worker registered, as on the dev
  // server, that promise never settles and the card would wait for ever.
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function standing(): Promise<Standing> {
  if (isIos() && !isInstalled()) return 'needs-install';
  if (!('Notification' in window) || !('PushManager' in window)) return 'unsupported';
  const reg = await registration();
  if (!reg) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if ((await relayKey()) === null) return 'not-set-up';
  const s = await loadReminders();
  return s.on && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

const keyBytes = (b64url: string) => {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/**
 * Turn reminders on. Call it from a tap and nowhere else: a browser shows
 * the permission prompt only in answer to one, and iOS shows it once.
 *
 * They are turned on for the person selected at that moment, and stay that
 * person's on this phone.
 */
export async function turnOn(): Promise<Standing> {
  if (!('Notification' in window)) return 'unsupported';
  const reg = await registration();
  if (!reg || !('PushManager' in window)) return 'unsupported';
  const key = await relayKey();
  if (key === null) return 'not-set-up';
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked';

  const want = keyBytes(key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a key the relay no longer uses can never be
  // rung: the push service checks the signature against the key it was
  // made with. Start again.
  if (sub && !sameKey(sub.options.applicationServerKey, want)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });

  const s = await loadReminders();
  await kvSet(SETTINGS_KEY, { ...s, on: true, profileId: activeProfile() });
  await refreshReminders();
  return 'on';
}

/** Turn them off: the relay forgets this browser, and the phone its list. */
export async function turnOff(): Promise<void> {
  const s = await loadReminders();
  await kvSet(SETTINGS_KEY, { ...s, on: false });
  await kvDelete(NOTE_KEY);
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/push/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function saveReminders(patch: Partial<ReminderSettings>): Promise<ReminderSettings> {
  const next = readSettings({ ...(await loadReminders()), ...patch });
  await kvSet(SETTINGS_KEY, next);
  await refreshReminders();
  return next;
}

/**
 * The next fortnight of rings, from the record as it stands.
 *
 * A dose rings only while it is unanswered: today's taken and skipped doses
 * are left out, which is the whole of how a tick cancels a reminder.
 */
export async function buildRings(s: ReminderSettings, now = new Date()): Promise<Ring[]> {
  const days: Parameters<typeof doseRings>[0] = [];
  if (s.doses) {
    for (const day of scheduleDays(medDay(now))) {
      const plan = await readMedsDay(day, now);
      days.push({
        day,
        groups: plan.groups.map((g) => ({
          time: g.time,
          names: g.doses.filter((p) => p.state === 'due' || p.state === 'later').map((p) => p.med.name),
        })),
      });
    }
  }
  const logged = new Set<string>();
  if (s.meals) {
    const today = await mealsOn(startOfToday(now));
    if ((await itemsFor(today.map((m) => m.id))).some((i) => counts(i.plan_state))) logged.add(calendarDay(now));
  }
  const test = await kvGet<number>(TEST_KEY);
  return inOrder([
    ...doseRings(days, s, now.getTime()),
    ...mealRings(scheduleDays(calendarDay(now)), logged, s, now.getTime()),
    ...(test && test > now.getTime() ? [testRingAt(test)] : []),
  ]);
}

/**
 * Work out the list, keep it, and tell the relay the times.
 *
 * Does nothing unless reminders are on, permission still stands, the browser
 * is still subscribed, and the person selected is the one they were turned
 * on for. With someone else selected the list is left exactly as it was:
 * the phone still rings for its owner while the other person looks at their
 * own day.
 *
 * The list is kept before the times are sent, so there is never a ring on
 * its way with no words waiting for it.
 */
export async function refreshReminders(now = new Date()): Promise<number | null> {
  const s = await loadReminders();
  if (!s.on || s.profileId !== activeProfile()) return null;
  if (!('Notification' in window) || Notification.permission !== 'granted') return null;
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return null;

  const rings = await buildRings(s, now);
  await kvSet(NOTE_KEY, rings);
  let status = 0;
  try {
    const res = await fetch('/push/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, times: rings.map((r) => r.at) }),
    });
    status = res.status;
  } catch {
    // Offline. Recorded as status 0 and tried again on the next change or
    // the next time the app comes to the front.
  }
  const ok = status >= 200 && status < 300;
  await kvSet<RelayState>(STATE_KEY, {
    at: now.getTime(),
    ok,
    status,
    count: rings.length,
    next: rings[0] ? { at: rings[0].at, title: rings[0].title } : null,
    until: rings.length ? rings[rings.length - 1].at : null,
  });
  return ok ? rings.length : null;
}

/**
 * "Send a test reminder": one ring a minute or so from now, through the same
 * list, relay and service worker as every other. Returns when it should ring,
 * or null when reminders are not on for the person selected.
 */
export async function sendTest(now = new Date()): Promise<number | null> {
  const at = testRingTime(now.getTime());
  await kvSet(TEST_KEY, at);
  const sent = await refreshReminders(now);
  return sent === null ? null : at;
}

/**
 * Start-up, once per page: rebuild now, and again shortly after anything in
 * the record changes or the app comes back to the front.
 *
 * Waits a moment after a change because changes come in bursts. A medicine
 * saved with four doses is five writes, and one rebuild is enough.
 */
let started = false;
export function startReminders(): void {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshReminders().catch((e) => console.warn('[reminders]', e));
    }, 1500);
  };
  onChange(soon);
  // Left open overnight, the app comes back to a new day with yesterday's
  // list. Coming to the front is when that is noticed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') soon();
  });
  soon();
}
