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
try {
  execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'mealo-sync', '--local',
    '--file=migrations/0001_batches.sql'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
} catch (e) {
  const said = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(-600) || '(nothing)';
  console.error(
    `wrangler d1 execute did not finish${e.signal ? ` — stopped after 2 minutes (${e.signal})` : ''}.\n` +
      `It last said:\n${said}`,
  );
  process.exit(1);
}

const dev = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--port', String(PORT),
  '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });

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
} catch (e) {
  fail++;
  console.log('  FAIL threw —', e.message);
} finally {
  dev.kill('SIGTERM');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
