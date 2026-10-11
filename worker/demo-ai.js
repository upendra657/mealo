/**
 * The demo's one server-side piece: a relay between Ask Mealo and a model
 * provider, so a visitor can try the chat without bringing a key.
 *
 * It is copied into the demo's build as `_worker.js` (`npm run build:demo`)
 * and runs only for /ai/* (`demo-routes.json`). Everything else in the demo
 * is still static files that never touch it. The real app has nothing like
 * this and must never get one: there, a key lives in the person's browser
 * and goes from the browser to the provider, with nobody in between.
 *
 * Why it exists at all. A key built into a public site is a key published:
 * anyone can read it out of the page and use it anywhere. So the key is a
 * secret on Cloudflare (`AI_KEY`), set by whoever runs the demo, and the
 * browser is only ever given answers.
 *
 * What it will and will not do, each for the same reason, that this is an
 * open door to somebody's quota:
 *
 *   - One route that reaches the provider, POST /ai/chat/completions.
 *   - Only from the demo's own pages. A browser on another site is turned
 *     away by the Origin check. A script can forge that header; what stops a
 *     script is the quota, below.
 *   - The model is the relay's, whatever the request says.
 *   - Only the fields Ask Mealo sends are passed on. Nothing else a provider
 *     might accept, and never `stream`.
 *   - An answer is capped at the longest one Ask Mealo asks for.
 *   - The body is capped in size.
 *
 * What it does not do is count visitors or limit any one of them. Cloudflare's
 * free plan gives a pages.dev site nothing to do that with that does not need
 * a database of its own. The limit that actually holds is the provider's: a
 * free-tier key has a daily allowance and no payment method behind it, so
 * when the allowance is gone the provider answers 429 and nothing is billed.
 * The relay passes that on in words a visitor can act on. One determined
 * person can therefore use up the day for everyone; that is the price of
 * costing nothing, and the demo says how to carry on with your own key.
 *
 * Nothing is logged here: not a question, not an answer, not an address.
 */

/** Groq's OpenAI-compatible endpoint, unless AI_BASE_URL says otherwise. */
const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
/** The app's own default for Groq (src/llm/providers.ts), unless AI_MODEL says otherwise. */
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
/**
 * The longest answer Ask Mealo asks for is 2,500 tokens, for "Elaborate"
 * (src/ui/Doctor.tsx). A request for more did not come from the app.
 */
const MAX_TOKENS = 2500;
/**
 * A question with its record slice, eleven tool definitions and three rounds
 * of lookups is some tens of kilobytes. This is several times that, and far
 * short of a body built to burn tokens.
 */
const MAX_BODY = 160 * 1024;
/** The fields Ask Mealo sends (src/llm/adapter.ts), and nothing more. */
const PASSED_ON = ['messages', 'tools', 'tool_choice', 'temperature'];

/** Errors in the shape the app already reads from every provider. */
const fail = (status, message, extra = {}) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

const OWN_KEY = 'Choose another provider in Dev and use your own key to carry on.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Reached only if the routes file is missing or wrong. The demo's pages
    // must still be served.
    if (!url.pathname.startsWith('/ai/')) return env.ASSETS.fetch(request);

    // What "Test connection" asks for. It says which model answers and does
    // not reach the provider, so it costs nothing however often it is asked.
    if (url.pathname === '/ai/models' && request.method === 'GET') {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: env.AI_MODEL || DEFAULT_MODEL, object: 'model' }] }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname !== '/ai/chat/completions') return fail(404, 'There is nothing at this address.');
    if (request.method !== 'POST') return fail(405, 'Only POST is answered here.');
    if (request.headers.get('origin') !== url.origin) return fail(403, 'This relay answers the demo\'s own pages only.');
    if (!env.AI_KEY) return fail(503, `The demo has no shared key set up. ${OWN_KEY}`);

    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, 'That request is larger than the demo allows.');
    let asked;
    try {
      asked = JSON.parse(text);
    } catch {
      return fail(400, 'The request was not JSON.');
    }
    if (!asked || typeof asked !== 'object' || !Array.isArray(asked.messages) || asked.messages.length === 0) {
      return fail(400, 'The request had no messages.');
    }

    const body = { model: env.AI_MODEL || DEFAULT_MODEL, stream: false };
    for (const field of PASSED_ON) if (asked[field] !== undefined) body[field] = asked[field];
    const wanted = Number(asked.max_tokens);
    body.max_tokens = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), MAX_TOKENS) : MAX_TOKENS;

    let res;
    try {
      res = await fetch(`${(env.AI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_KEY}` },
        body: JSON.stringify(body),
      });
    } catch {
      return fail(502, `The model provider could not be reached. ${OWN_KEY}`);
    }

    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      return fail(429, `The demo's shared allowance is used up for now. Try again later. ${OWN_KEY}`, wait ? { 'retry-after': wait } : {});
    }
    // The key was refused or the account is in trouble. Whatever the provider
    // said about it is the owner's business, not a visitor's.
    if (res.status === 401 || res.status === 403) return fail(502, `The demo's shared key is not working. ${OWN_KEY}`);
    if (!res.ok && res.status !== 400) return fail(502, `The model provider answered with an error (${res.status}). ${OWN_KEY}`);

    // The answer, or a 400 saying what was wrong with the request. The body
    // is passed through as it came; the provider's headers are not.
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
};
