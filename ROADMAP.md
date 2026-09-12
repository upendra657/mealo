# Roadmap

Seven phases. Each has an exit criterion you can answer yes or no to, and the
specific trap that kills it. Weekend counts assume part-time work.

Tick things off as they land. A phase is done when its exit criterion is true —
not when the code is written.

---

## Phase 0 — Skeleton, adapter, storage decision · 1–2 weekends

- [x] Vite + React PWA shell, installable, dark and light
- [x] SQLite over OPFS in a worker, with migrations
- [x] `updated_at`, `deleted_at` and device-scoped ids on every table from v1
- [x] `navigator.storage.persist()` requested and its result surfaced
- [x] One OpenAI-compatible adapter, Ollama as the first implementation
- [x] Settings screen with provider data policies and a Test connection button
- [x] A message reaches Ollama and renders a reply
- [x] Groq reachable from a browser origin with no CORS error
- [ ] ~~Sync path chosen~~ → **moved to end of Phase 1**

**Exit criterion: met.** Both providers reachable, storage persists across
reloads, schema v1 migrated.

**Why sync moved:** the reason it sat in Phase 0 was that changing storage later
means migrating real data. There is no real data yet, and the columns that make
migration painful to add — `updated_at`, `deleted_at`, device ids — are already
in place. Deciding a sync engine before writing a single real query is deciding
early. Revisit once the Pharmacist's queries exist.

### Findings worth keeping

- Ollama refuses cross-origin browser requests unless `OLLAMA_ORIGINS` is set.
- SQLite's OPFS backend silently falls back to an in-memory database when its
  async proxy worker can't load. Watch the status bar; it is there for this.
- Thinking models inflate output tokens roughly 8×. One sentence of answer cost
  366 output tokens on a reasoning model. Routine turns should run with thinking
  off — Groq's 8,000 tokens/minute ceiling is one reasoning turn otherwise.
- Provider catalogues change without notice. `llama-3.3-70b-versatile` was gone
  from Groq within months. Every `defaultModel` is a hint; Test connection is
  the source of truth.

---

## Phase 1 — Pharmacist, on your phone · 2–3 weekends

The smallest agent, chosen first because it tests the one thing that decides the
project: whether you actually log. That test is only honest on the device where
logging really happens.

- [ ] Repos layer enforcing per-agent table scope
- [ ] Add a medication or supplement; list; edit; stop
- [ ] One-tap taken/skipped from the home screen
- [ ] Free text to structured record via the model, with confirmation
- [x] Plain export button — download the raw database file
- [ ] Manifest, service worker, offline shell
- [ ] Deployed to Cloudflare Pages with COOP/COEP `_headers`, installed to the
      iPhone home screen
- [ ] Sync decision: adopt Evolu, or build encrypted deltas onto a Worker

**Done when:** you have logged your own supplements from your phone for seven
consecutive days without the app annoying you — and one exported copy exists
outside the browser.

**Trap:** designing a beautiful schedule UI before you know whether you'll use it
daily. Ugly and used beats elegant and abandoned, and you cannot tell which
you've built until you've run the seven days on the real device.

---

## Phase 2 — Nutritionist and the food tables · 2–3 weekends

The phase with the most hidden work, almost none of it AI.

- [x] Fuzzy matcher: text to food id, with quantity parsing
- [x] Direct macro entry — protein, fat, carbs, fibre, energy — as a first-class
      path beside text, not a fallback
- [x] `food_aliases` caching so your own vocabulary converges
- [x] Per-meal and per-day macro views
- [ ] Load reference data — `scripts/import-foods.mjs` is written; run it against
      a USDA FoodData Central CSV download
- [x] Custom foods — define a dish once, it matches forever after
- [ ] Decide whether the model fallback is worth building at all (see below)

**Done when:** 80% of your last thirty meals matched locally with zero model calls.

**Trap:** reaching for the model on every meal because it's easier than writing a
matcher. It works, it's slower, and it burns the daily token budget on a problem
a lookup table solves.

*Open question — the model fallback.* The roadmap assumed the model would fill
in items the matcher missed. Having built it, that looks wrong: for an unmatched
food the user knows what they ate and the model is guessing. Typing four numbers
is faster than a round trip and strictly more accurate. Currently an unmatched
item opens empty macro fields instead of calling the model. Revisit only if that
turns out to be annoying in practice.

*Data licensing.* The `ifct2017` npm package is AGPL-3.0 and would relicense the
whole app, so it is not used. USDA FoodData Central is US federal data and
therefore public domain — that is the default source.

There is no public HealthifyMe dataset and there will not be one: their Indian
food database is the product's moat, and scraping it would put unlicensed data
in a public repo. Custom foods are the answer instead — define a dish once with
its macros and it matches for free from then on, which solves Indian dishes
structurally without any licensing question. A personal HealthifyMe data export
(your own records, requestable under the DPDP Act) is a legitimate source of
*alias names*; keep its values local rather than committing them.

*Candidate:* voice logging via `whisper-large-v3-turbo` on Groq's free tier.
Speaking a meal beats typing it, and P6 says logging friction is the product.

---

## Phase 3 — Doctor and shared state · 2 weekends

- [ ] Symptom logging into structured records
- [ ] `current_state` written by the Doctor, read by the other two
- [ ] Persona router and per-agent conversation threads
- [ ] Rolling summary in place of full history

**Done when:** the Doctor answers "how has my week been" correctly from real
logged data, and both other agents read `current_state` rather than calling it.

**Trap:** letting agents message each other because it feels more agentic. It is
slower, costs tokens, and fails in ways a table read cannot.

---

## Phase 4 — Grounding and safety · 2 weekends

Turns a chatbot with a health theme into something you can responsibly rely on.

- [ ] RxNorm resolution and openFDA label fetch, cached locally
- [ ] Interaction surfacing from label section 7, with citations
- [ ] Red-flag rule table and pre-model gate
- [ ] Dose-pattern output filter
- [ ] Adapter-level de-identification, with the outbound log as the check

**Done when:** all twelve red-flag phrases trigger with zero model calls logged,
and every drug claim in your last twenty responses carries a working source link.

**Trap:** putting a disclaimer in settings and calling it safety. R1–R6 are code
with tests, or they are decoration.

---

## Phase 5 — Sync, reminders and the passphrase · 2–3 weekends

- [ ] Sync on: passphrase setup, relay on the Mac behind Tailscale, deltas both ways
- [ ] Passphrase treated like a wallet seed — generated, recorded, re-confirmed.
      There is no reset, by design.
- [ ] Encrypted export and import with its own password
- [ ] Touch polish on the flows you actually use
- [ ] Web push via VAPID, Cloudflare Worker cron as sender

**Done when:** a meal logged on the phone appears on the Mac, a meal logged while
the phone is offline appears once it reconnects, a reminder push arrives, and a
fresh browser with only the passphrase rebuilds your full history.

**Trap:** testing sync only with both devices online. The offline-then-reconnect
case is the one that breaks.

---

## Phase 6 — Open-source release · 1 weekend

- [ ] README that leads with what the app is not
- [ ] Key setup walkthrough with provider data policies stated plainly
- [ ] Licence, contribution notes, safety rules documented as requirements
- [ ] GitHub Actions build and deploy

**Done when:** a stranger clones the repo, adds their own key, and logs a meal
within ten minutes using nothing but the README.

**Trap:** shipping without saying plainly what the app is not. For a health tool
that is the most important paragraph in the repository.
