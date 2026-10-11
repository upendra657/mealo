/**
 * The demo's AI relay, run for real.
 *
 *   npm run test:demo
 *
 * The relay is the one place a key the owner pays attention to sits behind a
 * public address, so what it lets through is checked here request by request.
 * Nothing is faked: the relay's own code is called with real requests, and
 * "the provider" is a small HTTP server on this machine that writes down
 * exactly what it was sent, key included, and answers as told.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import relay from '../worker/demo-ai.js';

let pass = 0;
let fail = 0;
const ok = (n, c, d = '') => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : ` — ${d}`}`);
};

// Not a key. A string no provider issued, long and odd enough to be searched for.
const KEY = 'test-only-not-a-real-key-7f3a9c2e1b';
const got = [];
let next = { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Your week looked steady.' } }] }, headers: {} };
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    got.push({ path: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.writeHead(next.status, { 'content-type': 'application/json', 'x-provider-internal': 'do-not-pass-on', ...next.headers });
    res.end(JSON.stringify(next.body));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${provider.address().port}/openai/v1`;

const DEMO = 'https://mealo-demo.example';
const assets = { fetch: async () => new Response('<!doctype html>the app', { headers: { 'content-type': 'text/html' } }) };
const env = (over = {}) => ({ AI_KEY: KEY, AI_BASE_URL: BASE, AI_MODEL: 'the-relays-model', ASSETS: assets, ...over });
const messages = [{ role: 'system', content: 'P' }, { role: 'user', content: 'how was my week' }];
const post = (body, { origin = DEMO, e = env(), path = '/ai/chat/completions', method = 'POST' } = {}) =>
  relay.fetch(new Request(`${DEMO}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), e);
const said = [];
const read = async (res) => {
  const text = await res.text();
  said.push(text, JSON.stringify([...res.headers]));
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: res.headers };
};

try {
  console.log('\nThe relay: an ordinary question');
  let r = await read(await post({ model: 'whatever', messages, temperature: 0.2, max_tokens: 1500, tools: [{ type: 'function', function: { name: 'thali_summary' } }] }));
  ok('the answer comes back', r.status === 200 && r.json?.choices?.[0]?.message?.content === 'Your week looked steady.', r.text);
  ok('the provider was asked once, at its chat route', got.length === 1 && got[0].path === '/openai/v1/chat/completions' && got[0].method === 'POST');
  ok('with the key, as a bearer token', got[0].headers.authorization === `Bearer ${KEY}`);
  ok('the model is the relay\'s, not the one asked for', got[0].body.model === 'the-relays-model', got[0].body.model);
  ok('the messages, tools and temperature are passed on', JSON.stringify(got[0].body.messages) === JSON.stringify(messages) && got[0].body.tools.length === 1 && got[0].body.temperature === 0.2);
  ok('never as a stream', got[0].body.stream === false);
  ok('the provider\'s own headers are not passed back', r.headers.get('x-provider-internal') === null);
  ok('and the answer is not cached anywhere', r.headers.get('cache-control') === 'no-store');

  console.log('\nThe relay: what it will not pass on');
  got.length = 0;
  await read(await post({ messages, max_tokens: 999999, stream: true, n: 50, model: 'the-most-expensive', logprobs: true, user: 'x', response_format: { type: 'json' }, seed: 1 }));
  ok('an answer is capped at the longest the app asks for', got[0].body.max_tokens === 2500, String(got[0].body.max_tokens));
  ok('only the app\'s own fields reach the provider', Object.keys(got[0].body).sort().join() === 'max_tokens,messages,model,stream', Object.keys(got[0].body).sort().join());
  ok('asked to stream, it still does not', got[0].body.stream === false);
  got.length = 0;
  await read(await post({ messages }));
  ok('no length asked for is still a capped length', got[0].body.max_tokens === 2500);
  await read(await post({ messages, max_tokens: 700 }));
  ok('a shorter one is left as asked', got[1].body.max_tokens === 700);
  await read(await post({ messages, max_tokens: -5 }));
  await read(await post({ messages, max_tokens: 'lots' }));
  ok('a nonsense length is capped, not trusted', got[2].body.max_tokens === 2500 && got[3].body.max_tokens === 2500);

  console.log('\nThe relay: who it answers');
  got.length = 0;
  for (const [what, origin] of [['another site', 'https://evil.example'], ['no origin at all', null], ['a look-alike', `${DEMO}.evil.example`], ['plain http', DEMO.replace('https', 'http')]]) {
    const x = await read(await post({ messages }, { origin }));
    ok(`${what} is turned away`, x.status === 403, String(x.status));
  }
  ok('and none of those reached the provider', got.length === 0, String(got.length));
  r = await read(await post({ messages }, { e: env({ AI_KEY: undefined }) }));
  ok('with no key set it says so, and how to carry on', r.status === 503 && /no shared key/.test(r.text) && /your own key/.test(r.text), r.text);
  ok('and does not call the provider', got.length === 0);
  r = await read(await post(null, { method: 'GET' }));
  ok('a GET at the chat route is refused', r.status === 405);
  r = await read(await post({ messages }, { path: '/ai/embeddings' }));
  ok('there is no other route to the provider', r.status === 404 && got.length === 0);
  r = await read(await post({ messages }, { path: '/ai/../ai/chat/completions/extra' }));
  ok('nor a longer one', r.status === 404 && got.length === 0, String(r.status));
  r = await read(await post(null, { path: '/ai/models', method: 'GET', origin: null }));
  ok('"Test connection" is told the model without the provider being asked', r.status === 200 && r.json.data[0].id === 'the-relays-model' && got.length === 0, r.text);
  r = await read(await post(null, { path: '/some/page', method: 'GET', origin: null }));
  ok('anything outside /ai is the demo\'s own pages', r.text.includes('the app'));

  console.log('\nThe relay: bad requests');
  r = await read(await post('{not json'));
  ok('not JSON', r.status === 400);
  r = await read(await post({ messages: [] }));
  ok('no messages', r.status === 400);
  r = await read(await post({ prompt: 'hello' }));
  ok('no messages field at all', r.status === 400);
  r = await read(await post({ messages: [{ role: 'user', content: 'x'.repeat(200_000) }] }));
  ok('a body built to burn tokens is refused', r.status === 413);
  ok('and none of these reached the provider', got.length === 0, String(got.length));

  console.log('\nThe relay: when the provider says no');
  next = { status: 429, body: { error: { message: 'Rate limit reached for model in organization org_abc on tokens per day' } }, headers: { 'retry-after': '120' } };
  r = await read(await post({ messages }));
  ok('an allowance used up is a 429 in plain words', r.status === 429 && /shared allowance is used up/.test(r.text) && /your own key/.test(r.text), r.text);
  ok('with when to try again', r.headers.get('retry-after') === '120');
  ok('and nothing of the account it came from', !/org_abc/.test(r.text));
  next = { status: 401, body: { error: { message: `Invalid API Key ${KEY.slice(0, 12)}` } }, headers: {} };
  r = await read(await post({ messages }));
  ok('a refused key is "not working", with none of what the provider said', r.status === 502 && /shared key is not working/.test(r.text) && !/Invalid API Key/.test(r.text), r.text);
  next = { status: 500, body: { error: { message: 'internal: shard 7 on host 10.0.0.3' } }, headers: {} };
  r = await read(await post({ messages }));
  ok('a provider fault is reported without its insides', r.status === 502 && !/shard|10\.0\.0\.3/.test(r.text), r.text);
  next = { status: 400, body: { error: { message: 'tool call validation failed' } }, headers: {} };
  r = await read(await post({ messages }));
  ok('a 400 is passed on: it is about the request, and the app shows it', r.status === 400 && /tool call validation failed/.test(r.text));
  r = await read(await post({ messages }, { e: env({ AI_BASE_URL: 'http://127.0.0.1:9/v1' }) }));
  ok('a provider that cannot be reached is said plainly', r.status === 502 && /could not be reached/.test(r.text), r.text);

  console.log('\nThe relay: the key');
  // Everything the relay sent back in this whole run, bodies and headers.
  ok('the key is in nothing the relay ever answered', !said.join('\n').includes(KEY) && !said.join('\n').includes(KEY.slice(0, 12)));
  const src = readFileSync(new URL('../worker/demo-ai.js', import.meta.url), 'utf8');
  ok('nothing in the relay logs', !/console\.(log|info|warn|error|debug)/.test(src));
  ok('the routes file sends it /ai and nothing else', JSON.stringify(JSON.parse(readFileSync(new URL('../worker/demo-routes.json', import.meta.url), 'utf8'))) === '{"version":1,"include":["/ai/*"],"exclude":[]}');
  ok('with no settings it points at the provider the app already knows', /DEFAULT_BASE = 'https:\/\/api\.groq\.com\/openai\/v1'/.test(src));
} catch (e) {
  fail++;
  console.log('  FAIL threw —', e.stack ?? e.message);
} finally {
  provider.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
