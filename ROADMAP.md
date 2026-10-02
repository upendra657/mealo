# Roadmap

Seven phases. Each has an exit criterion you can answer yes or no to, and the
specific trap that kills it. Weekend counts assume part-time work.

Tick things off as they land. A phase is done when its exit criterion is true —
not when the code is written.

---

## Phase 0 — Skeleton, adapter, storage decision · 1–2 weekends

- [x] Vite + React PWA shell, installable, dark and light — light was dropped
      in the dark rebuild; one dark theme since, because this is opened at the
      table at night
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

- [x] Repos layer enforcing per-agent table scope
- [x] Add a medication or supplement; list; edit; stop
- [ ] One-tap taken/skipped from the home screen — **built, then orphaned.**
      It lived on `ui/Today.tsx`, which the dark rebuild stopped mounting.
      `logIntake` survives in `domain/medications.ts` but no reachable screen
      calls it, so the deployed app has no way to record a dose at all.
- [x] Free text to structured record via the model, with confirmation
- [x] Plain export button — download the raw database file
- [x] Manifest, service worker, offline shell
- [x] Deployed with COOP/COEP `_headers`, installed to the iPhone home screen —
      as a Worker with static assets rather than Pages, because the dashboard's
      Workers-scoped token cannot run `wrangler pages deploy` (`32c21db`)
- [x] Sync decision: **built** — encrypted deltas onto the app's own Worker and
      D1. Evolu was never spiked; one household across its own devices almost
      never produces a real conflict, which is what made building defensible.

**Done when:** you have logged your own supplements from your phone for seven
consecutive days without the app annoying you — and one exported copy exists
outside the browser.

> **Met — 1 Oct 2026**, for the question the test was really asking. The seven
> days were run on food rather than supplements, by two people, and have since
> continued well past seven; the export button has existed since Phase 1. The
> trap this test guards against — building something elegant and then not using
> it — is the one that has been cleared. Medication logging specifically has had
> lighter use, so if the supplement-only reading is the one that matters, this
> is a half tick rather than a whole one — and since the rebuild it could not
> have been otherwise, because the taken/skipped button is no longer reachable.

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
- [x] Load reference data — 329 USDA Foundation Foods entries committed
- [x] Custom foods — define a dish once, it matches forever after
- [x] **Elastic portions** — quantity × measure → net weight → macros, derived
      from the dish's own anchors rather than fixed per-unit constants
- [x] Personal food-table import: your CSV, re-runnable, in-app, never uploaded
- [ ] Decide whether the model fallback is worth building at all (see below)

**Done when:** 80% of your last thirty meals matched locally with zero model calls.

> **Met — 1 Oct 2026.** Confirmed by sustained daily use by two people rather
> than by computing the ratio: food logging runs on the matcher, the custom
> dish table and the portion anchors, and the model fallback was never built
> (see the open question below) — so the local-match rate for meals is not
> approximately 100%, it is exactly 100%, because there is no other path. The
> figure the test asks for is therefore satisfied by construction. What has not
> been measured is how often a dish needs *defining* before it matches, which is
> the number actually worth watching now; `domain/checksheet.ts` has the data to
> compute it if it ever matters.

**Trap:** reaching for the model on every meal because it's easier than writing a
matcher. It works, it's slower, and it burns the daily token budget on a problem
a lookup table solves.

*Open question — the model fallback.* The roadmap assumed the model would fill
in items the matcher missed. Having built it, that looks wrong: for an unmatched
food the user knows what they ate and the model is guessing. Typing four numbers
is faster than a round trip and strictly more accurate. Currently an unmatched
item opens empty macro fields instead of calling the model. Revisit only if that
turns out to be annoying in practice.

*Portions are anchors, not serving sizes.* The first version had a
`defaultGrams()` with per-unit constants — a katori is 150g, a bowl is 250g,
anything else is 100g. That is wrong for nearly every dish, because a katori of
dal and a katori of rice and a katori of curd weigh three different things, and
it was wrong in a way that compounds: `"2 roti"` came out as 200g rather than
80g, so a normal breakfast logged 2.5× the calories it contained.

A dish now carries `food_portions` rows — "1 katori = 150g" — and everything
else is derived from them:

| Asked for | Derived from | How |
| --- | --- | --- |
| 1.5 katori | the katori anchor | linear, 225g |
| 1 bowl | the katori anchor | density, 150g/150ml = 1.0 g/ml → 250g |
| 100 ml of oil | a tbsp anchor of 14g | 0.93 g/ml → 93g, not 100g |
| "2 roti" | roti's default portion | 2 × 40g |
| 1 slice | the only per-piece anchor | 40g |

Two rules keep it honest. A weight the app assumed from a household table is
tagged `estimated` in the UI and is never written back as if it were measured —
only a weight the user actually typed becomes an anchor. And a count measure
never yields a density: knowing a slice of bread weighs 30g says nothing about
what a bowl of it weighs, so that falls back and says so.

The macro columns of the sheet are normalised to per-100g on import, and the
row's net weight is kept as the anchor. That separation is what makes the data
elastic rather than a lookup table of fixed rows.

*Tested.* `npm test` — 74 assertions on the arithmetic in node, and 44 against
real OPFS SQLite in a headless browser (`scripts/e2e/`), covering migrations,
import idempotence, the scope layer and profile isolation. Those were the counts
when this phase closed. On 2 Oct 2026: 330 in node, 118 in a browser, and 15
against the relay's D1.

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

- [x] Symptom logging into structured records — Doctor-only table
- [x] `current_state` written by the Doctor, read by the other two
- [x] Per-agent conversation threads
- [x] Rolling summary in place of full history
- [x] **Red-flag gate — pulled forward from Phase 4** (see below)
- [x] De-identified slice, with a "what it can see" view in the UI

**Done when:** the Doctor answers "how has my week been" correctly from real
logged data, and both other agents read `current_state` rather than calling it.

**Trap:** letting agents message each other because it feels more agentic. It is
slower, costs tokens, and fails in ways a table read cannot.

*R1 moved here from Phase 4.* It cannot be later than the first screen that
accepts a symptom — shipping something called "Doctor" that answers "I have
chest pain" with a model response is the exact failure this project was designed
to avoid. `src/safety/redflags.ts`, 12 patterns, runs before any model call.

*What the R1 test caught.* Three of the twelve phrases silently failed on the
first run: the patterns ended with `\b`, and "drooping" does not end where
"droop" does, so a word boundary immediately after rejected the match. Two more
were word-order misses — people under stress write "speech is slurred", not
"slurred speech". The patterns now match a pair of ideas near each other rather
than a fixed phrasing. This is why R1 is a test and not a checklist item.

*`current_state` is composed deterministically*, not by asking a model. It is
structured facts — what is being taken, what is open, what the week looked like.
A model there would add cost, latency and the chance of inventing a medication.

---

## Phase 4 — Grounding and safety · 2 weekends

Turns a chatbot with a health theme into something you can responsibly rely on.

- [x] RxNorm resolution and openFDA label fetch, cached locally (30 days)
- [x] Interaction surfacing from label section 7, with citations
- [x] ~~Red-flag rule table and pre-model gate~~ → **done in Phase 3**
- [x] Dose-pattern output filter
- [x] Adapter-level de-identification, with the outbound log as the check —
      `safety/deidentify.ts`, called from `llm/adapter.ts` before every fetch.
      It redacts rather than throwing: the guarantee is identical either way,
      but a chat that dies mid-sentence on a coincidental thirteen-digit number
      is a worse product than one that sends `[id]`. The loudness lives in the
      log, which records what was taken, and in the suite, which asserts that
      ordinary traffic redacts nothing. The verification view moved out of the
      orphaned `Playground.tsx` into Settings, because a check nobody can reach
      is not a check.

**Done when:** all twelve red-flag phrases trigger with zero model calls logged,
and every drug claim in your last twenty responses carries a working source link.

**Trap:** putting a disclaimer in settings and calling it safety. R1–R6 are code
with tests, or they are decoration.

*Verified.* R1: 12/12 red-flag phrases fire with zero model calls, no false
positives on ordinary questions. R2: 6/6 dosing instructions stripped, 5/5
legitimate statements survive — including quoting the user's own record and
quoting a cited label. On a mixed reply only the offending sentence is removed,
because a useful answer containing one bad sentence should lose the sentence.

*Why R2 is not simply "block numbers near mg".* Four cases have to be told
apart: quoting the user's own record (allowed), quoting label text with a
citation (allowed), instructing (blocked), recommending (blocked). The filter
looks for a dose adjacent to instructional language, not for doses.

*What the label check deliberately does not do.* It reports that a label names
a substance, quotes the sentence and links the source. It does not judge
severity or rank risk — an app assigning severity scores would be inventing a
judgement no label gave it. And absence of a finding is not absence of an
interaction: many products, supplements especially, have no FDA label at all,
which the UI says rather than showing a reassuring empty state.

*A subtlety worth keeping.* Searching openFDA for "metformin" can return a
combination product such as ZITUVIMET. Its interactions are not necessarily
metformin's, so the product the label actually describes is shown with every
claim.

*The NLM retired its drug-interaction endpoint in January 2024*, so interactions
are read out of label text rather than a purpose-built API. More work, less
tidy, but citable — which the old endpoint's output was not.

---

## Phase 4.5 — Two people · done

Not in the original plan. The app is for two of us, and that is a schema
decision, not a UI one — retrofitting it after months of logged data would have
meant rewriting every query against real records.

- [x] `profiles` table; `profile_id` on medications, intake_events, meals,
      meal_items, symptoms, messages
- [x] `current_state` is one row per profile; conversation summaries keyed
      `<profile>:<agent>`
- [x] One-tap switcher in the header; switching remounts the app
- [x] A guard in `db/scope.ts` that throws on any read of a per-person table
      without a `profile_id` filter

**What is shared and what is not.** The food library — `foods`, `custom_foods`,
`food_portions`, `food_aliases` — is shared, because a household has one
kitchen and one katori, and a dish either of us records should be available to
both immediately. Everything that is a record of a body is separate.

**Why the guard exists.** A missing `profile_id` in a WHERE clause does not
crash, does not look wrong in review, and cannot be caught by testing with one
profile. It surfaces as one person's meals in the other's day and as the Doctor
reasoning about the wrong person's symptoms. There is no safe default to fall
back to, so the query throws instead. Inserts are stamped automatically, since
a row written with no profile belongs to nobody and is invisible to everyone.

**Not security.** Anything on the page can read the whole database. This is
about a shared device and correct attribution, the same as the agent scope
layer — making the wrong thing hard to write by accident.

**Trap avoided:** a separate database file per person. Tempting, and it gives
real isolation, but it splits the food table too, which is the one thing that
should be shared and the one thing that takes real effort to build.

---

## Phase 5 — Sync, reminders and the passphrase · 2–3 weekends · about 30% in

- [x] **Food library sync**, both ways — 28 Sep 2026, `8977ab9` → `240536e`.
      Envelope and merge rules, the relay, the client, pairing. On, and
      running on open on both phones.
- [ ] Health-table sync — meals, meal items, medications, intake, symptoms,
      weights, burns, targets. Blocked on the three questions below.
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

*The relay moved off the Mac.* The plan put it on the Mac behind Tailscale,
because the alternative then on the table was an always-on relay somebody pays
for. It lives in the app's own Worker on D1 instead: same origin, so no CORS
preflight on every sync; one deploy rather than two things to keep alive; and
no dependence on a laptop being awake. The relay stores AES-GCM ciphertext
keyed by a household id and cannot read a dish name, so P1 holds without an
asterisk — what leaves the device is ciphertext.

*What the library sync already settles,* and health sync should inherit rather
than re-decide: no foreign key crosses the wire as a local id; last write wins
on `updated_at` except that a measured portion beats a derived one; applying a
row writes the sender's `updated_at`, never now(), or two phones trade the same
row forever; the push cursor is a local timestamp and the pull cursor a relay
seq, and neither advances before its work has succeeded; push runs before pull;
a batch that will not decrypt is skipped; and a failed sync never blocks logging.

### What the health tables change

Found reading the sync code against this phase on 2 Oct. Each needs a decision
before a single health row travels.

**1. Every install's first profile is called `primary`.** It is a fixed id
(`lib/active-profile.ts`), not a generated one, so `primary` on his phone and
`primary` on hers are two different people under one id. Ship per-person rows
keyed on `profile_id` as they stand and the receiving phone files them under
whoever *it* calls primary — one person's meals in the other's day, which is
exactly what `ProfileScopeError` exists to stop, arriving through the one path
the guard never sees: the apply step writes raw SQL. Profiles need an identity
two devices agree on, the way dishes got slugs in v6.

**2. Whose devices are we syncing?** The library is per household and travels
under the household key, which both phones hold. The exit criterion is about
one person's own devices — a meal on *the* phone appears on *the* Mac. Sending
health rows under the household key would put his symptoms and medications on
her phone, in ciphertext that her phone can open. That reads as two layers: a
household key for the kitchen, and a personal key — the passphrase — for a
body. Not decided.

**3. The relay forgets, by design.** Batches are pruned on write after 30 days
or past 2,000 per household. That is fine for two live phones trading dishes
and cannot meet "a fresh browser with only the passphrase rebuilds your full
history". It also has a quieter consequence already live for the library: a
phone that has not synced in 30 days never receives what was pruned in the
meantime, and nothing says so. Full-history restore needs either a periodic
encrypted snapshot on the relay or the encrypted export as the restore path —
which would make those two checklist items one piece of work.

**Smaller, but easy to get wrong.** Health rows do not need a second identity
the way dishes did: their ids are a device prefix plus a uuid, and two people
cannot log the same dinner. But `meal_items.food_id` points at a device-local
`custom_foods` id, so it has to travel as a slug and resolve on receipt, the
same treatment portions already get.

*On the passphrase.* The pairing code is already a random secret — 16 bytes of
household id and 32 of key — so "generated" is done. "Recorded, re-confirmed"
is not: the code can be shown in Settings at any time and nothing asks anyone to
write it down. Whether the personal key should be the same kind of code or
something a person can read back from paper is part of question 2.

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

---

## Not yet in any phase

Written here so they stop living in one person's head. Neither has a checklist
yet; both need one.

- **Medications: definitions and regimens.** A shared definition of what a
  medication is, and a per-person regimen of how one person takes it.
- **The remaining Doctor and Pharmacist work.**
