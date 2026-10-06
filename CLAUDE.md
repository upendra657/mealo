# Mealo

A local-first personal health PWA with three scoped AI agents — Doctor,
Nutritionist, Pharmacist — over one on-device SQLite database. Built by Upendra
for himself and his partner. Public repo. **Hard constraint: zero recurring cost
to anyone, ever.**

`HANDOFF.md` (gitignored, local only) is the deep context — design decisions,
rejected alternatives, how the thinking changed. Read it once before substantial
work, not every session. This file is what you need every time.

---

## Commands

```bash
npm run dev            # vite, COOP/COEP headers already set
npm run build          # tsc -b && vite build
npm run test           # portions + e2e
npm run test:portions  # 548 pure-logic assertions, node, fast
npm run test:e2e       # 257 assertions against real OPFS SQLite, headless browser
npm run test:relay     # 15 assertions against real D1 via wrangler dev --local
npx tsc --noEmit -p tsconfig.app.json
npx oxlint src/ scripts/
```

**`tsc -p tsconfig.json` checks nothing.** That file has no files of its own,
only references, so it reports success having read nothing. `tsconfig.app.json`
covers all of `src/`; `npm run build` (`tsc -b`) follows the references. The
test scripts are under no tsconfig at all — esbuild and vite strip their types
unchecked — so a type error in a test only shows up as a wrong result.

**`test:e2e` needs a Chromium.** If Playwright's own build is missing, point it
at Chrome: `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e`.

**`test:relay`'s schema step** hung three times on 6 Oct 2026 and could not be
made to hang again. It now stops after two minutes and prints what wrangler
said, rather than sitting silent.

**Deploying always builds first.** `wrangler deploy` ships whatever is sitting in
`dist/` — it does not build. This has already caused one silent non-deploy where
the old bundle went up and everything looked fine:

```bash
npm run build && npx wrangler deploy && git push origin main
```

Upendra runs deploys and pushes himself.

---

## Things that will bite

**Git locks.** Something recreates `.git/index.lock` and `.git/HEAD.lock`
constantly. A `git commit` that collides with it leaves **the index showing every
tracked file as deleted**. This looks catastrophic and is not — the working tree
is untouched, and a bare `git reset` (no flags, **never `--hard`**) rebuilds the
index from HEAD. Prevent it by folding the clear into the front of the command,
leaving no window: `rm -f .git/index.lock .git/HEAD.lock && git add -A && git commit …`.
Name the two files rather than globbing `.git/*.lock`: zsh fails a glob that
matches nothing, so with no lock present the chain stops before `git add` and
the commit silently never happens. Never move a lock aside between `add` and
`commit`; that is what corrupted the index twice.

**Git identity.** Name `Upendra Sharma`, email
`89166658+upendra657@users.noreply.github.com` — the same one already on every
commit here. Your environment may surface a different account email and handle;
they are **not his**, so never use them for commits, attribution, or how you
address him. **He is Upendra.**

**Never commit his food data.** `/*.csv` in `.gitignore` is a blanket root rule,
not a list, because the list kept growing and `git add -A` sweeps up a new one
silently. It has already happened once on a public remote. His CSVs now live in
`../Mealo-Resources/data/` — outside the repo, so the ignore rule is a backup
rather than the only safeguard. Keep it that way.

**Never handle credentials.** BYOK keys live in the browser's IndexedDB and go
browser → provider directly. Do not accept, store, echo or request one.

**`npx wrangler` is unpinned** and has pulled a different version on four
consecutive deploys. Worth pinning to `devDependencies`.

---

## Architecture, in the order it matters

**`db/scope.ts` is the spine.** Each agent gets a database handle with a
per-table read/write allowlist. Tables holding one person's body — meals,
medications, symptoms, weights, burns, messages — refuse any read that does not
filter by profile, throwing `ProfileScopeError`. A forgotten filter is a crash,
not one household member seeing the other's day. Do not weaken this.

**Agents never talk to each other.** They share `current_state` (`domain/state.ts`),
a structured slice composed in plain code. A model there would add cost, latency
and the chance of inventing a medication.

**`safety/` runs on both sides of every model call.** `redflags.ts` (R1) is
deterministic triage *before* any call and can end a turn alone. `dosefilter.ts`
(R2) scans output for a dose adjacent to *instructional* language — quoting the
user's own record and cited label text are allowed. `deidentify.ts` (R5) is the
outbound boundary in `llm/adapter.ts`. **These are requirements with tests, not
decoration.** R1–R3 and R5 are done; R4 is partial; R6 is documentation.

**Portions.** A dish carries weighed anchors `(measure, quantity, net_weight_g)`
with macros per 100 g; other measures derive through implied density. A
**measured** portion always beats a **derived** one, including across sync —
the app's arithmetic must never bury a scale reading.

**Sync carries the libraries only — food, and since v10 medicines.** The
kitchen and the medicine cupboard are shared; a body is not. Row ids are
globally unique (`newId()` is a device prefix plus a uuid), but a dish two
phones added independently has two ids — so dishes merge on `slug`, and
portions travel as `(food_slug, measure)` and resolve on receipt. Medicines
merge on `medSlug(name, strength)`, with ingredients and starting schedules as
`(product_slug, position)`. Shipping a local foreign key produces anchors
pointing at rows that do not exist, silently. A medicine marked Keep private
never leaves its phone; who takes what — doses, ticks, sicknesses — never
travels at all.

**Medicine lists are the device's, not anyone's record.** `med_ref_sets` and
`med_ref_items` hold the bundled HSA Singapore register (`scripts/import-hsa.mjs`
→ `src/data/hsa.json`; re-run when HSA refreshes, about every six months) and
any list imported in Dev from CSV or Excel. Never synced, never in the shared
library; only a medicine someone saves from a suggestion becomes a library
entry. Imports are staged ('importing' until complete, invisible to search,
cleared if abandoned) and written through the worker's bulk path, which
refuses every table but `med_ref_items` — an import cannot reach meals.

**Medicines split the way food does.** What a medicine *is* (`med_products`,
its ingredients, a starting schedule) is the household library; what a person
*takes* (`medications`, `med_doses`, `intake_events`, `sick_episodes`) is per
person. A changed name or strength makes a new product — never edit a
product's identity in place, someone else may be taking the old one.
`planDay` in `domain/doses.ts` is the one place that decides what is due on a
day; the Meds screen, the medicine log and the Doctor's slice all call it.
Sick mode and paused medicines are worked out from dates, never written.
Every dose amount is one a person entered or confirmed — the app never fills
one in (R2).

**Local day bucketing happens in JS.** `DATE(ts/1000,'unixepoch')` is UTC and
wrong at +05:30.

---

## Before health tables sync

Smaller than it looks: health rows need no second identity, since their ids are
already globally unique and two people cannot log the same dinner. Only foreign
keys into the library need translating — `meal_items.food_id` travels as a slug,
as portions do. But three decisions come first, and none is made yet:

**`primary` is not one person.** Every install's first profile has the fixed id
`primary` (`lib/active-profile.ts`), so his `primary` and hers are two people
under one id. Rows keyed on it would file one person's meals in the other's day,
through the sync apply step's raw SQL, which `ProfileScopeError` never sees.
Profiles need a cross-device identity first, as dishes got slugs in v6.

**Household key or personal key.** The library travels under the household key,
which both phones hold. Health rows under that key would put his symptoms on her
phone in a form it can open. The exit test is one person's phone → that
person's Mac, which points at a separate per-person key — the passphrase.

**The relay forgets.** `worker/index.ts` prunes batches after 30 days or past
2,000 per household, so it cannot meet "a fresh browser with only the passphrase
rebuilds your full history". Restore needs an encrypted snapshot or the
encrypted export. It already bites the library: a phone silent for 30 days
never receives what was pruned, and nothing says so.

---

## Conventions

**Comments say *why*, never *what*.** They carry the reasoning, the rejected
alternative, the bug that produced the line. This is the house style and it is
not negotiable — a comment restating the code will be rejected. Load-bearing
constants carry their derivation.

**Commit messages are prose, not bullets.** What changed, why, what was
considered and rejected, what a reader would otherwise get wrong. End with:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Tests go with the logic.** Pure functions in `scripts/test-portions.ts`;
anything touching the database in `scripts/e2e/harness.ts` against real SQLite.
Mocks are not used. Every bug fixed gets an assertion that would have caught it.

**Migrations are forward-only**, numbered, never edited once shipped. Schema is
at **v12**. **Shipped means any database has run it — a dev browser included.**
v10 was edited after `npm run dev` had already run it on Upendra's Mac; that
database never re-ran it, and every medicine save failed with "no column named
freq". Never re-pin a checksum: write the next migration. A new one ships with two additions or the tests fail: its checksum
pinned in `SHIPPED` (`test-portions.ts`), and rows in `SEEDS`
(`scripts/e2e/upgrade.ts`) for every table and column it adds. The e2e run
then upgrades a populated database from the previous version through the real
worker and checks every value survived. A statement that deletes or rewrites
rows fails the lint unless it is in `SANCTIONED`, with its reason.

**Real data exists from v11 on.** Every change from here must assume real meal
data and real medication data on both phones, and keep both intact. Upendra
will say when he starts logging medications.

**CSS is one dark theme.** Tokens in `:root` at the top of `styles.css`. No light
mode — the app is opened at the table, often at night.

---

## How Upendra works

**Step by step, with review before proceeding.** Propose, show, get a yes, then
continue. Do not drop a finished ten-file change on him. This is stated, not
inferred.

**Show visual changes before committing them.** Render headless at 390×844
DPR 3 and show a before/after. He will sometimes reject after seeing it — a
+2pt type bump was built, previewed and thrown away. That is the process
working.

**When a visual bug resists explanation, measure it.** Render the real DOM
against the real stylesheet, hide one layer at a time, and fit the geometry to
the rendered pixels. Reasoning about layout produced two confident wrong answers
on the dial arc; measuring produced the cause in one pass.

**Minimal targeted changes over rewrites when debugging.** Find the specific
broken line.

**Never fabricate data, ids, names or entities from inaccessible sources.** If a
source cannot be reached, say so plainly before generating anything.

**He validates patterns rather than supplying them.** Derive the rule from the
data and show your working; he will tell you if it is wrong, and he is usually
right about his own kitchen.

---

## Status

Phases 0–4 complete, including R5. Phase 4.5 (two people) done. **Phase 5 ~30%** —
encrypted delta sync works for the food and medicine libraries; passphrase, encrypted export,
health-table sync and web push are open. **Phase 6 not started** — no LICENSE, no
CONTRIBUTING, no CI, and `README.md` still opens with "Status: Phase 0. No agents
yet." See `ROADMAP.md` for the per-phase checklists and `HANDOFF.md` §6 for known
rough edges.

Track meds was rebuilt in v10–v11: the medicine definition/regimen split (shared
library, per-person regimens), sick mode, non-daily schedules and the medicine
log. Parked, to discuss: reading a prescription from an image or PDF (needs a
decision on whether an image may leave the phone — P2), and a meds summary on
the Home tile. Not yet written into any phase: the remaining Doctor and
Pharmacist work.
