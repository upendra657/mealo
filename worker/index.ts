/**
 * The relay.
 *
 * Two phones cannot reach each other, so something in the middle holds what
 * one wrote until the other asks for it. That is all this is: an append-only
 * log of opaque blobs, one log per household, handed back in order.
 *
 * It cannot read them. The household key never leaves either device (see
 * lib/household.ts), so every `body` here is AES-GCM ciphertext and this
 * Worker has no idea whether it is holding dal tadka or an empty batch. That
 * is what lets the app keep saying the database never leaves the device
 * without an asterisk: what leaves is ciphertext, and the relay is storage,
 * not a party to the conversation.
 *
 * ---------------------------------------------------------------------------
 * What the household id is and is not
 * ---------------------------------------------------------------------------
 *
 * The id names an inbox and is the only thing gating writes. Someone who
 * guessed 16 random bytes could append rubbish to a household's log — and
 * that rubbish would fail to decrypt on both phones and be skipped, because
 * AES-GCM authenticates as well as encrypts. They could not read anything,
 * and they could not forge a row. The realistic damage is wasted bandwidth,
 * which the size and rate caps below bound.
 *
 * It is deliberately not a bearer token, because it travels in a URL on pull
 * and would end up in request logs. Nothing about secrecy rests on it.
 *
 * ---------------------------------------------------------------------------
 * Why this lives in the app's Worker
 * ---------------------------------------------------------------------------
 *
 * Same origin, so no CORS preflight on every sync, one deploy command, and
 * one thing to keep alive. Asset serving normally wins over the script, so
 * `run_worker_first` in wrangler.jsonc lists /sync/* — without it the SPA
 * fallback would answer these routes with index.html and the client would be
 * parsing HTML as JSON.
 */

/**
 * The two bindings, declared here rather than pulled from
 * @cloudflare/workers-types.
 *
 * This file is outside tsconfig.app.json's `include` — it is not browser code
 * and the app build never compiles it; wrangler bundles it at deploy. Four
 * type names did not seem worth a dependency everyone has to install before
 * they can deploy, so they are written out. If this grows past a handful of
 * calls, take the dependency.
 */
interface D1Result<T> {
  results?: T[];
  meta: { last_row_id: number };
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<D1Result<unknown>>;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
}
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Web push. All three are Worker secrets that the person running this
   * deployment sets themselves (`scripts/vapid-keys.mjs` prints the first
   * two on their own machine). Until all three exist, /push/key answers
   * with no key, the app says reminders are not set up here, and the cron
   * finds nothing to do.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** "mailto:someone@example.com" or an https URL: who a push service may contact. */
  VAPID_SUBJECT?: string;
  /**
   * The relay test's stand-in for a push service, e.g. "http://127.0.0.1:8123".
   * Never set in production: it is the one origin outside the list below
   * that a ring may be sent to.
   */
  PUSH_TEST_ORIGIN?: string;
}

/** One batch is a sync's worth of rows. Generous, but not a file upload. */
const MAX_BODY = 512 * 1024;
/** How long the relay keeps a batch after writing it. */
const KEEP_DAYS = 30;
/** Most batches one household may hold. A runaway client cannot fill D1. */
const MAX_BATCHES = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Household ids are base32 of 16 bytes. Anything else is not one. */
const HOUSEHOLD = /^[A-Z2-7]{26}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/push/')) {
      try {
        if (url.pathname === '/push/key' && request.method === 'GET') {
          return json({ key: pushReady(env) ? env.VAPID_PUBLIC_KEY : null });
        }
        if (url.pathname === '/push/schedule' && request.method === 'POST') {
          return await schedule(request, env);
        }
        if (url.pathname === '/push/forget' && request.method === 'POST') {
          return await forget(request, env);
        }
        return json({ error: 'no such route' }, 404);
      } catch (e) {
        console.error('push', e);
        return json({ error: 'relay failed' }, 500);
      }
    }
    if (!url.pathname.startsWith('/sync/')) return env.ASSETS.fetch(request);

    try {
      if (url.pathname === '/sync/push' && request.method === 'POST') {
        return await push(request, env);
      }
      if (url.pathname === '/sync/pull' && request.method === 'GET') {
        return await pull(url, env);
      }
      return json({ error: 'no such route' }, 404);
    } catch (e) {
      // Never echo the message back: it can carry SQL, and the client has
      // nothing useful to do with it beyond retrying later.
      console.error('sync', e);
      return json({ error: 'relay failed' }, 500);
    }
  },

  /**
   * Once a minute: ring whoever is due.
   *
   * A browser cannot wake itself to show a reminder while the app is closed
   * (Chrome's Notification Triggers never shipped, and iOS has nothing of
   * the kind), so something outside the phone has to send a push at the
   * right minute. This is that, and it is all it does.
   */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    try {
      await ring(env);
    } catch (e) {
      // A table that does not exist yet is the ordinary state of a
      // deployment where nobody has turned reminders on.
      if (!/no such table/i.test(String(e))) console.error('push cron', e);
    }
  },
};

/* ------------------------------------------------------------------------
 * Reminders
 * ------------------------------------------------------------------------
 *
 * What the relay holds is (endpoint, minute) pairs and nothing else: see
 * migrations/0002_push.sql. The push it sends has no body. The words on the
 * lock screen are written on the phone by the service worker, from a note
 * the app left in its own IndexedDB, so the relay has nothing to encrypt
 * and nothing to leak. That is also why this needs no RFC 8291 payload
 * encryption, only the VAPID signature that says who is sending.
 *
 * Every push shows a notification on the phone, always. iOS withdraws a
 * subscription after three pushes that show nothing, so there is no silent
 * "wake up and check" here and there must never be one.
 */

/** Rings one browser may have waiting. Fourteen days of five a day is 70. */
const MAX_RINGS = 100;
/** How far ahead a ring may be set. The app sets fourteen days. */
const MAX_AHEAD_MS = 15 * 86_400_000;
/** A ring this late is not sent. A reminder for the morning is noise at noon. */
const LATE_MS = 60 * 60_000;
/** Most rows the table may hold. A runaway client cannot fill D1. */
const MAX_ROWS = 20_000;
/**
 * Most browsers rung per run. The free plan allows a Worker 50 subrequests
 * per invocation; whoever does not fit is first in line a minute later.
 */
const PER_RUN = 40;

/**
 * The push services a ring may be sent to.
 *
 * Without this the relay would POST, signed, to any URL a stranger handed
 * it, once a minute. These are the hosts browsers actually give out: Chrome
 * and Android (FCM), Safari and iOS (Apple), Firefox (Mozilla), Edge
 * (Windows). A browser whose service is not here cannot get reminders until
 * its host is added, which is the right way round.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

function pushReady(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function goodEndpoint(endpoint: unknown, env: Env): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (env.PUSH_TEST_ORIGIN && u.origin === env.PUSH_TEST_ORIGIN) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((h) => h.test(u.hostname));
}

/**
 * Created on first use rather than by a migration someone has to remember to
 * run, and then not asked again by this isolate: two statements on every
 * request were two of the 50 queries an invocation is allowed.
 */
let pushTableReady = false;
async function ensurePushTable(env: Env): Promise<void> {
  if (pushTableReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS push_rings (endpoint TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (endpoint, at))',
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_push_rings_at ON push_rings(at)').run();
  pushTableReady = true;
}

/**
 * Replace everything one browser is waiting for.
 *
 * Replace, never add: the phone sends its whole next fortnight each time,
 * so a dose that has been ticked, or a medicine that was stopped, is simply
 * absent from the new list and its ring is gone. That is how a ticked dose
 * cancels its reminder, with no cancel message to lose.
 */
async function schedule(request: Request, env: Env): Promise<Response> {
  if (!pushReady(env)) return json({ error: 'push is not set up' }, 503);
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown; times?: unknown } | null;
  if (!goodEndpoint(body?.endpoint, env)) return json({ error: 'bad endpoint' }, 400);
  if (!Array.isArray(body?.times) || body.times.length > MAX_RINGS) return json({ error: 'bad times' }, 400);

  const now = Date.now();
  const minutes = new Set<number>();
  for (const t of body.times) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return json({ error: 'bad times' }, 400);
    // On the minute, because the cron runs on the minute. A time already
    // past is dropped rather than refused: the phone's clock and this one
    // are never quite the same.
    const at = Math.floor(t / 60_000) * 60_000;
    if (at > now + MAX_AHEAD_MS) return json({ error: 'bad times' }, 400);
    if (at > now - 60_000) minutes.add(at);
  }

  await ensurePushTable(env);
  const endpoint = body.endpoint;
  await env.DB.prepare('DELETE FROM push_rings WHERE endpoint = ?').bind(endpoint).run();
  const held = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_rings').first<{ n: number }>();
  if ((held?.n ?? 0) + minutes.size > MAX_ROWS) return json({ error: 'relay is full' }, 507);
  // The whole list in one statement. One INSERT per ring ran past the free
  // plan's 50 D1 queries per invocation once a phone had medicines in three
  // parts of the day (14 days x 4 rings), and failed halfway: the old rows
  // already deleted, only the first few dozen written, and a 500 nobody saw
  // (found 15 Oct 2026). A batch() might count as one query or as many;
  // Cloudflare does not say, so this does not rely on it.
  if (minutes.size > 0) {
    await env.DB.prepare('INSERT OR IGNORE INTO push_rings (endpoint, at) SELECT ?, value FROM json_each(?)')
      .bind(endpoint, JSON.stringify([...minutes]))
      .run();
  }
  return json({ rings: minutes.size });
}

/** Reminders turned off: this browser is forgotten entirely. */
async function forget(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (!goodEndpoint(body?.endpoint, env)) return json({ error: 'bad endpoint' }, 400);
  await ensurePushTable(env);
  await env.DB.prepare('DELETE FROM push_rings WHERE endpoint = ?').bind(body.endpoint).run();
  return json({ forgotten: true });
}

async function ring(env: Env): Promise<void> {
  if (!pushReady(env)) return;
  const now = Date.now();
  // Too late to be worth sending. Dropped first, so a relay that was down
  // for a morning does not ring a breakfast reminder in the afternoon.
  await env.DB.prepare('DELETE FROM push_rings WHERE at < ?').bind(now - LATE_MS).run();

  // One push per browser however many of its rings fell due together: the
  // phone decides what to show for this minute, and one push is enough to
  // wake it.
  const due = await env.DB.prepare(
    'SELECT endpoint, MIN(at) AS at FROM push_rings WHERE at <= ? GROUP BY endpoint ORDER BY at ASC LIMIT ?',
  )
    .bind(now, PER_RUN)
    .all<{ endpoint: string; at: number }>();

  const tokens = new Map<string, string>();
  for (const row of due.results ?? []) {
    let status = 0;
    try {
      const origin = new URL(row.endpoint).origin;
      if (!tokens.has(origin)) tokens.set(origin, await vapidToken(origin, env));
      const res = await fetch(row.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${tokens.get(origin)}, k=${env.VAPID_PUBLIC_KEY}`,
          // How long the push service keeps it for a phone that is off or
          // out of signal. The same hour after which it would not be sent.
          TTL: String(LATE_MS / 1000),
          Urgency: 'high',
          'Content-Length': '0',
        },
      });
      status = res.status;
    } catch (e) {
      console.error('push send', e);
    }

    if (status === 404 || status === 410) {
      // The browser unsubscribed, or the app was removed. Nothing will ever
      // be delivered there again.
      await env.DB.prepare('DELETE FROM push_rings WHERE endpoint = ?').bind(row.endpoint).run();
    } else if (status >= 200 && status < 300) {
      await env.DB.prepare('DELETE FROM push_rings WHERE endpoint = ? AND at <= ?').bind(row.endpoint, now).run();
    }
    // Anything else — the service is down, or it refused the signature —
    // leaves the row where it is. It is tried again next minute and dropped
    // by the first statement above once it is an hour old.
  }
}

/* --------------------------------------------------------------- VAPID */

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (text: string): Uint8Array => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/**
 * The signed note that says who is sending (RFC 8292).
 *
 * A JWT, ES256, naming the push service it is for, when it stops being
 * valid, and a contact. Twelve hours, where the RFC allows twenty-four, so
 * a clock a little off on either side cannot make it look expired or too
 * long-lived. WebCrypto's ECDSA signature is already the 64 raw bytes a JWS
 * wants, so there is no DER to unpick.
 *
 * The private key is the 32-byte scalar, base64url, and the public key the
 * 65-byte uncompressed point: the forms `web-push` and every guide use, so
 * a pair made by any tool works here.
 */
async function vapidToken(audience: string, env: Env): Promise<string> {
  const pub = unb64url(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY!.replace(/=+$/, ''),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })),
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

async function push(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    household?: string;
    device?: string;
    body?: string;
  } | null;

  const household = body?.household ?? '';
  const device = body?.device ?? '';
  const payload = body?.body ?? '';

  if (!HOUSEHOLD.test(household)) return json({ error: 'bad household' }, 400);
  if (!device || device.length > 64) return json({ error: 'bad device' }, 400);
  if (!payload || payload.length > MAX_BODY) return json({ error: 'bad body' }, 400);

  const at = Date.now();
  const res = await env.DB.prepare(
    'INSERT INTO batches (household, device, body, at) VALUES (?, ?, ?, ?)',
  )
    .bind(household, device, payload, at)
    .run();

  // Prune on write rather than on a schedule: it keeps the household bounded
  // without a cron, and the cost lands on whoever is causing the growth.
  await env.DB.prepare(
    `DELETE FROM batches
      WHERE household = ?
        AND (at < ?
             OR seq <= COALESCE(
               (SELECT seq FROM batches WHERE household = ?
                 ORDER BY seq DESC LIMIT 1 OFFSET ?), -1))`,
  )
    .bind(household, at - KEEP_DAYS * 86_400_000, household, MAX_BATCHES)
    .run();

  return json({ seq: res.meta.last_row_id });
}

async function pull(url: URL, env: Env): Promise<Response> {
  const household = url.searchParams.get('household') ?? '';
  const since = Number(url.searchParams.get('since') ?? 0);
  const device = url.searchParams.get('device') ?? '';

  if (!HOUSEHOLD.test(household)) return json({ error: 'bad household' }, 400);
  if (!Number.isFinite(since) || since < 0) return json({ error: 'bad cursor' }, 400);

  // A device skips its own batches. It already has those rows, and applying
  // them would be a no-op that still costs a decrypt and a write.
  const rows = await env.DB.prepare(
    `SELECT seq, device, body FROM batches
      WHERE household = ? AND seq > ? AND device != ?
      ORDER BY seq ASC LIMIT 200`,
  )
    .bind(household, since, device)
    .all<{ seq: number; device: string; body: string }>();

  // The cursor must advance past batches we skipped as our own, or every pull
  // re-reads them forever. So report the household's true high-water mark,
  // not the last row returned.
  const top = await env.DB.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS hi FROM batches WHERE household = ?',
  )
    .bind(household)
    .first<{ hi: number }>();

  const batches = rows.results ?? [];
  const last = batches.length > 0 ? batches[batches.length - 1].seq : 0;

  return json({
    batches,
    // When a page was returned, stop at its end so nothing is skipped; only
    // when the page was empty is it safe to jump to the top.
    cursor: batches.length > 0 ? last : (top?.hi ?? since),
    more: batches.length === 200,
  });
}
