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
};

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
