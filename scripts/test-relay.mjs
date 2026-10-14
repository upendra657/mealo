/**
 * The relay, against a real D1.
 *
 *   npm run test:relay
 *
 * Starts `wrangler dev --local`, which is miniflare with a real SQLite behind
 * the D1 binding, runs the round trips, and tears it down. Nothing here talks
 * to Cloudflare or needs credentials.
 *
 * Worth the orchestration because the cursor rules are where sync breaks
 * quietly: a device that is handed its own batches back applies them
 * needlessly, and one whose cursor does not advance past them re-reads the
 * same rows forever. Neither shows up as an error — just as sync that seems
 * to work and slowly stops.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';

/**
 * A free-ish port per run, so a wrangler left over from an interrupted run
 * does not make the next one fail to bind — which surfaces as the unhelpful
 * "wrangler did not start" rather than as a port clash.
 */
const PORT = 8800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * A fresh household per run.
 *
 * `wrangler dev --local` keeps its D1 on disk between runs, so a fixed id
 * would carry every previous run's batches into this one and "the other
 * device sees it" would count four. Generating the household is also closer
 * to the truth: that is what the app does.
 */
const b32 = () => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return Array.from({ length: 26 }, () => A[Math.floor(Math.random() * 32)]).join('');
};
const H = b32();
const H2 = b32();

let pass = 0;
let fail = 0;
const ok = (n, c, d = '') => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : ` — ${d}`}`);
};

const push = (household, device, body) =>
  fetch(`${BASE}/sync/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ household, device, body }),
  }).then((r) => r.json().then((j) => ({ s: r.status, j })));

const pull = (household, device, since) =>
  fetch(`${BASE}/sync/pull?household=${household}&device=${device}&since=${since}`)
    .then((r) => r.json().then((j) => ({ s: r.status, j })));

// Schema first. Idempotent, so re-running the suite is free.
//
// Bounded, and its output kept. On 6 Oct 2026 this step hung three times —
// no output, no CPU, for minutes — and afterwards could not be made to hang
// again, with its output piped or discarded, so the cause is not known. What
// is fixable is that it hung silently: the suite sat there looking like it was
// working. Now it gets two minutes and, failing that, the run stops and shows
// what wrangler last said.
//
// `--no` rather than `--yes wrangler@4`: the latter fetched whichever 4.x was
// newest on every run, so the relay was tested on one wrangler and deployed
// by another. Now it runs the one pinned in package.json, or stops and says
// so if `npm install` has not been run.
try {
  for (const file of ['migrations/0001_batches.sql', 'migrations/0002_push.sql']) {
    execFileSync('npx', ['--no', 'wrangler', 'd1', 'execute', 'mealo-sync', '--local',
      `--file=${file}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  }
} catch (e) {
  const said = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || '(nothing)';
  console.error(
    `wrangler d1 execute did not finish${e.signal ? ` — stopped after 2 minutes (${e.signal})` : ''}.\n` +
      `It last said:\n${said}`,
  );
  process.exit(1);
}

// ---- reminders: a key pair for this run, and a stand-in push service ------
//
// A throwaway pair, made here and gone when the run ends. The real one is a
// Worker secret that only whoever runs the deployment ever sees.
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PUBLIC = b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)));
const VAPID_PRIVATE = (await webcrypto.subtle.exportKey('jwk', pair.privateKey)).d;

/**
 * What Apple, Google and Mozilla are to the relay: a URL it POSTs to. This
 * one writes down what it was sent and answers as told, so the run can see
 * the exact request a real push service would have received.
 */
const PUSH_PORT = PORT + 500;
const PUSH_ORIGIN = `http://127.0.0.1:${PUSH_PORT}`;
const received = [];
const answers = new Map();
const pushService = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url, method: req.method, headers: req.headers, body });
    const queue = answers.get(req.url) ?? [];
    res.statusCode = queue.length ? queue.shift() : 201;
    res.end();
  });
});
await new Promise((r) => pushService.listen(PUSH_PORT, '127.0.0.1', r));

const dev = spawn('npx', ['--no', 'wrangler', 'dev', '--local', '--port', String(PORT),
  '--ip', '127.0.0.1', '--test-scheduled',
  '--var', `VAPID_PUBLIC_KEY:${VAPID_PUBLIC}`, '--var', `VAPID_PRIVATE_KEY:${VAPID_PRIVATE}`,
  '--var', 'VAPID_SUBJECT:mailto:relay-test@example.com', '--var', `PUSH_TEST_ORIGIN:${PUSH_ORIGIN}`],
  { stdio: ['ignore', 'pipe', 'pipe'] });

const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => ({ s: r.status, j })));
/**
 * One turn of the cron, as wrangler runs it for a test.
 *
 * Not `/__scheduled`, the path most guides give: this Worker serves a
 * single-page app, so that path is answered by the asset fallback with
 * index.html and a 200, and the handler never runs. Seventeen checks failed
 * that way before the path was looked at. `/cdn-cgi/` is the runtime's own
 * and is never handed to the assets.
 */
const tick = async () => {
  const said = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`).then((r) => r.text());
  if (said.trim() !== 'ok') throw new Error(`the cron did not run: ${said.slice(0, 80)}`);
};
/** Rows the relay holds for one browser, read straight from its database. */
const ringsHeld = (endpoint) => {
  const out = execFileSync('npx', ['--no', 'wrangler', 'd1', 'execute', 'mealo-sync', '--local', '--json',
    `--command=SELECT COUNT(*) AS n FROM push_rings WHERE endpoint = '${endpoint}'`],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).toString();
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0].n;
};

const ready = new Promise((res, rej) => {
  let log = '';
  const t = setTimeout(
    () => rej(new Error(`wrangler did not start on ${PORT}:\n${log.slice(-600)}`)),
    120_000,
  );
  const on = (b) => {
    log += b.toString();
    if (/Ready on http/.test(b.toString())) { clearTimeout(t); res(); }
  };
  dev.stdout.on('data', on);
  dev.stderr.on('data', on);
});

try {
  await ready;

  console.log('\nRelay: what it refuses');
  ok('a bad household', (await push('nope', 'a', 'x')).s === 400);
  ok('an empty body', (await push(H, 'a', '')).s === 400);
  ok('an oversized body', (await push(H, 'a', 'x'.repeat(600_000))).s === 400);
  ok('an unknown route', (await fetch(`${BASE}/sync/nope`)).status === 404);

  console.log('\nRelay: a round trip');
  const p1 = await push(H, 'phone-a', 'AAAA');
  ok('push returns a seq', typeof p1.j.seq === 'number', JSON.stringify(p1.j));
  const b = await pull(H, 'phone-b', 0);
  ok('the other device sees it', b.j.batches.length === 1);
  ok('ciphertext comes back verbatim', b.j.batches[0].body === 'AAAA');
  ok('with a cursor to carry forward', b.j.cursor === p1.j.seq);

  console.log('\nRelay: a device and its own batches');
  const a = await pull(H, 'phone-a', 0);
  ok('it is not handed them back', a.j.batches.length === 0);
  // The one that bites: skip them but leave the cursor behind and every pull
  // re-reads the same rows for the life of the household.
  ok('but its cursor still advances', a.j.cursor === p1.j.seq, `${a.j.cursor} vs ${p1.j.seq}`);

  console.log('\nRelay: order and isolation');
  await push(H, 'phone-a', 'BBBB');
  await push(H, 'phone-a', 'CCCC');
  const b2 = await pull(H, 'phone-b', p1.j.seq);
  ok('only what is new comes back', b2.j.batches.map((x) => x.body).join() === 'BBBB,CCCC');
  ok('in seq order', b2.j.batches[0].seq < b2.j.batches[1].seq);

  await push(H2, 'other', 'SECRET');
  const leak = await pull(H, 'phone-b', 0);
  ok('another household is invisible', !JSON.stringify(leak.j).includes('SECRET'));

  const quiet = await pull(H, 'phone-b', b2.j.cursor);
  ok('an empty pull returns nothing', quiet.j.batches.length === 0);
  ok('and never rewinds the cursor', quiet.j.cursor >= b2.j.cursor);

  // ---- reminders ---------------------------------------------------------
  const MIN = 60_000;
  const now = Date.now();
  const mine = `${PUSH_ORIGIN}/send/${b32()}`;

  console.log('\nReminders: what the relay will and will not take');
  ok('the public key is handed out', (await fetch(`${BASE}/push/key`).then((r) => r.json())).key === VAPID_PUBLIC);
  ok('the private key is not in that answer', !(await fetch(`${BASE}/push/key`).then((r) => r.text())).includes(VAPID_PRIVATE));
  ok('an endpoint that is no push service is refused', (await post('/push/schedule', { endpoint: 'https://example.com/hook', times: [now] })).s === 400);
  ok('plain http at a real push host is refused', (await post('/push/schedule', { endpoint: 'http://fcm.googleapis.com/fcm/send/x', times: [now] })).s === 400);
  ok('a real push host is accepted', (await post('/push/schedule', { endpoint: `https://fcm.googleapis.com/fcm/send/${b32()}`, times: [] })).s === 200);
  ok('so is Apple\'s', (await post('/push/schedule', { endpoint: `https://web.push.apple.com/${b32()}`, times: [] })).s === 200);
  ok('a host that only ends like one is refused', (await post('/push/schedule', { endpoint: 'https://evil-push.apple.com.example.org/x', times: [] })).s === 400);
  ok('times must be a list', (await post('/push/schedule', { endpoint: mine, times: 'soon' })).s === 400);
  ok('of numbers', (await post('/push/schedule', { endpoint: mine, times: ['08:00'] })).s === 400);
  // A fortnight of medicines in four parts of the day and a meal nudge: 70
  // rings. One INSERT each ran past D1's 50 queries per invocation on the
  // free plan (15 Oct 2026). The local simulator may not hold to that limit,
  // so this checks the other half: every ring of a long list is kept.
  const busy = `https://fcm.googleapis.com/fcm/send/${b32()}`;
  const seventy = Array.from({ length: 70 }, (_, i) => now + (i + 1) * 60 * MIN);
  ok('a fortnight of seventy rings is taken whole', (await post('/push/schedule', { endpoint: busy, times: seventy })).j.rings === 70);
  ok('and all seventy are held', ringsHeld(busy) === 70);
  ok('a hundred, the most allowed, are held too', (await post('/push/schedule', { endpoint: busy, times: Array.from({ length: 100 }, (_, i) => now + (i + 1) * 60 * MIN) })).j.rings === 100 && ringsHeld(busy) === 100);
  await post('/push/forget', { endpoint: busy });
  ok('no more than a hundred', (await post('/push/schedule', { endpoint: mine, times: Array.from({ length: 101 }, (_, i) => now + i * MIN) })).s === 400);
  ok('and none more than fifteen days ahead', (await post('/push/schedule', { endpoint: mine, times: [now + 16 * 86_400_000] })).s === 400);
  ok('an unknown push route', (await fetch(`${BASE}/push/nope`)).status === 404);

  console.log('\nReminders: a ring');
  const set = await post('/push/schedule', { endpoint: mine, times: [now, now + 3 * 86_400_000, now - 10 * MIN] });
  ok('due now and in three days are kept, one already past is dropped', set.j.rings === 2, JSON.stringify(set.j));
  await tick();
  const got = received.filter((r) => r.path === new URL(mine).pathname);
  ok('the push service is sent one request', got.length === 1, String(got.length));
  ok('a POST with no body at all', got[0]?.method === 'POST' && got[0]?.body === '' && got[0]?.headers['content-length'] === '0', JSON.stringify(got[0]?.headers));
  ok('kept for an hour if the phone is off', got[0]?.headers.ttl === '3600');
  ok('marked urgent, so a sleeping phone is woken', got[0]?.headers.urgency === 'high');

  // The signature is the part a real push service checks, and the part that
  // cannot be seen to be wrong until Apple answers 403.
  const auth = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(got[0]?.headers.authorization ?? '');
  ok('signed the VAPID way', !!auth, got[0]?.headers.authorization);
  const [head, claims, sig] = (auth?.[1] ?? '..').split('.');
  const parsed = (part) => JSON.parse(Buffer.from(part, 'base64url').toString() || '{}');
  ok('with the key it hands to phones', auth?.[2] === VAPID_PUBLIC);
  ok('the signature verifies against that key', await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${head}.${claims}`)));
  ok('an ES256 JWT', parsed(head).alg === 'ES256' && parsed(head).typ === 'JWT', JSON.stringify(parsed(head)));
  ok('for this push service and no other', parsed(claims).aud === PUSH_ORIGIN, parsed(claims).aud);
  const life = parsed(claims).exp - now / 1000;
  ok('valid for under a day, as the RFC requires', life > 0 && life <= 24 * 3600, String(life));
  ok('with someone to contact', parsed(claims).sub === 'mailto:relay-test@example.com');
  ok('and nothing else: no name, no medicine, no time', Object.keys(parsed(claims)).sort().join() === 'aud,exp,sub');

  await tick();
  ok('a ring is sent once', received.filter((r) => r.path === new URL(mine).pathname).length === 1);
  ok('the one three days off is still waiting', ringsHeld(mine) === 1);

  console.log('\nReminders: ticked, failed, gone');
  // A new schedule replaces the old one: this is how a ticked dose cancels.
  const again = `${PUSH_ORIGIN}/send/${b32()}`;
  await post('/push/schedule', { endpoint: again, times: [now, now + MIN * 30] });
  await post('/push/schedule', { endpoint: again, times: [now + MIN * 30] });
  await tick();
  ok('a ring left out of the next schedule never sounds', received.filter((r) => r.path === new URL(again).pathname).length === 0);

  const flaky = `${PUSH_ORIGIN}/send/${b32()}`;
  answers.set(new URL(flaky).pathname, [500]);
  await post('/push/schedule', { endpoint: flaky, times: [now] });
  await tick();
  await tick();
  ok('a push service that failed is tried again', received.filter((r) => r.path === new URL(flaky).pathname).length === 2);
  await tick();
  ok('and not a third time once it took it', received.filter((r) => r.path === new URL(flaky).pathname).length === 2);

  const gone = `${PUSH_ORIGIN}/send/${b32()}`;
  answers.set(new URL(gone).pathname, [410]);
  await post('/push/schedule', { endpoint: gone, times: [now, now + 86_400_000, now + 2 * 86_400_000] });
  await tick();
  ok('a browser that unsubscribed is forgotten whole', ringsHeld(gone) === 0);

  ok('turning reminders off forgets the browser', (await post('/push/forget', { endpoint: mine })).j.forgotten === true && ringsHeld(mine) === 0);
  ok('and the sync routes are as they were', (await pull(H, 'phone-b', 0)).s === 200);
} catch (e) {
  fail++;
  console.log('  FAIL threw —', e.message);
} finally {
  pushService.close();
  dev.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
