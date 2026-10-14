# Mealo

A local-first personal health PWA over one on-device SQLite database, with one
AI chat, **Ask Mealo**, and two plain-code agents, **Thali** (meals) and **Dawa**
(medicines). Those are the names people see and the names comments use; in
code the ids are still `doctor`, `nutritionist` and `pharmacist`, and the chat
screen is still the `Doctor` component. The map is in `db/scope.ts`. Built by Upendra
for himself and his partner. Public repo. **Hard constraint: zero recurring cost
to anyone, ever.**

`HANDOFF.md` (gitignored, local only) is the deep context — design decisions,
rejected alternatives, how the thinking changed. Read it once before substantial
work, not every session. This file is what you need every time.

`Claude_memory.md` (gitignored, local only) is where things stand *now*: what
was last shipped, what is open, how Upendra works, what bit the last session.
**Read it at the start of every session and update it at the end.**

`Development_report.md` (gitignored, local only) has one entry per push, newest
first. **Before every push, add the entry** — commit range, what changed and
why, how it was verified, what it means for the data on the phones, what is
left open — from the change list Upendra approves.

---

## Commands

```bash
npm run check          # everything below, plus types, lint and build, twice at another hour (~30 s)
npm run dev            # vite, COOP/COEP headers already set
npm run build          # tsc -b && vite build
npm run dev:demo       # the public demo, on port 5174, with a made-up person
npm run build:demo     # the same, built into dist-demo/
npm run test           # portions + safety + e2e
npm run test:portions  # 965 pure-logic assertions, node, fast
npm run test:safety    # 1156 assertions: the gates, the tools, the numbers and claims checks, the lookup loop, AI insights
npm run test:e2e       # 463 assertions against real OPFS SQLite, headless browser
npm run test:demo      # 42 assertions on the demo's AI relay, against a stand-in provider
npm run test:relay     # 48 assertions against real D1 via wrangler dev --local
npx tsc --noEmit -p tsconfig.app.json
npx oxlint src/ scripts/
```

**`tsc -p tsconfig.json` checks nothing.** That file has no files of its own,
only references, so it reports success having read nothing. `tsconfig.app.json`
covers all of `src/`; `npm run build` (`tsc -b`) follows the references. The
test scripts are under no tsconfig at all — esbuild and vite strip their types
unchecked — so a type error in a test only shows up as a wrong result.

**Clock-dependent bugs hide in daytime runs.** Two were found on 15 Oct
2026 only because the suite ran at 01:49. Run any change that touches days,
slots or times under other zones too; headless Chrome and node both follow
`TZ`: `TZ=Europe/Moscow npm run test:e2e` puts the local clock just after
midnight, `Asia/Bangkok` before 05:00, `America/New_York` in the evening.

**`test:e2e` needs a Chromium.** If Playwright's own build is missing, point it
at Chrome: `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e`.

**`test:relay`'s schema step** hung three times on 6 Oct 2026 and could not be
made to hang again. It now stops after two minutes and prints what wrangler
said, rather than sitting silent.

**Every push runs `npm run check` first** (`.githooks/pre-push`, on since
15 Oct 2026; a fresh clone needs `git config core.hooksPath .githooks`). It
refuses a push when the tree has uncommitted changes to tracked files, when
the commit pushed is not the one checked out, when a file the build could
reach is untracked, when a CSV or database is in the pushed commits, or when
a commit has another author email; then it runs types, lint, build and all
five suites, the three main ones a second time with the clock moved to the
night (or the evening, if it already is night). A suite that reports no
count does not pass. Never `--no-verify`: if the check is wrong, fix it.

**A push to `main` deploys.** Cloudflare Workers Builds builds from GitHub on
every push. Confirmed 7 Oct 2026: the live bundle switched to a GitHub build
about 90 seconds after the push, identical to the local one apart from its
build stamp. So what is live is what is on `main`, and the build stamp in Dev →
This phone is Cloudflare's, not the Mac's. A push is a release; nothing goes to
`main` untested.

`wrangler deploy` is only for putting something live without pushing — and the
next push replaces it. It ships whatever is sitting in `dist/` and does not
build, which has already caused one silent non-deploy where the old bundle went
up and everything looked fine. Build first, either way; locally it is also the
type-check gate before anything reaches `main`:

```bash
npm run build && git push origin main     # the usual release
npm run build && npx wrangler deploy      # live without a push, until the next one
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

**D1 allows 50 queries per Worker invocation on the free plan**
(developers.cloudflare.com/d1/platform/limits, read 15 Oct 2026). A loop of
one query per row in a request handler fails past that, half done. Write
many rows as one statement (`INSERT … SELECT … FROM json_each(?)`); whether
a `batch()` counts as one query is not documented. The local simulator in
`test:relay` may not enforce the limit, so a passing test proves nothing here.

**Wrangler is pinned**, exactly, in `devDependencies` (4.148.0 since 7 Oct
2026), after `npx` pulled a different version on five consecutive deploys.
`npx wrangler` and `test:relay` both run that copy. Upgrade on purpose: bump
it, run `test:relay`, then deploy. `npm audit` flags `sharp` through wrangler's
local simulator (miniflare); it never reaches `dist/` or the Worker, and
`audit fix --force` would move wrangler off the pin.

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
decoration.** R1–R3, R5 and R7 are done; R4 is partial; R6 is documentation.

**`safety/gates.ts` is R7 and the gates beside it**: disordered eating and
extreme goals, a change to a medicine, a diagnosis, an empty record. Each
ends the turn in code with a fixed message and no answer. Every threshold in
it is quoted from a source read on 11 Oct 2026 and named in the file's
header; none may be changed, and none added, without a source read the same
way. Its messages are matched word for word to tell a stop from a model's
answer when the chat is reopened, so rewording one is a change to stored
history. A sentence that gets through, or an ordinary one that is stopped,
goes into `scripts/test-safety.ts` before the pattern is touched.

**Ask Mealo looks things up through tools; it never reads the record itself.**
`domain/tools.ts` is Thali and Dawa as a model sees them: eleven
tools, the lookups all views over `collectExport`, the same collected record the two reports are
built from, so a figure in a chat answer and in a report is one figure. No
tool writes, and none takes a dose, an amount, a target or a weight: the
four `propose_` tools only put the app's own confirm card on screen with
the person's words in it, and a tap on that card is the only thing that
saves. `llm/toolloop.ts`
runs the lookups with a cap (three rounds, then it must answer) and falls
back to the slice for a model that will not take tools. A tool result goes
to the model under a line saying it is data and never instructions, because
a dish can be named anything. `safety/numbers.ts` then removes any sentence
of the answer whose figure is in nothing the model was given, and the screen
says so.

**Whether something gets logged never depends on a model choosing to help.**
A real model, given "I just had 2 roti and dal" and a tool for the meal
card, ignored the tool and answered "Meals logged" with nothing logged
(11 Oct 2026). So the app reads those sentences itself (`mealStatement`,
`doseStatement` in `domain/chat.ts`) and opens the card with no model,
looking the words up in the food table first. `safety/claims.ts` removes any
sentence in which a model says it saved something, and keeps a "Meals
logged" line only if it names a dish the record holds. A meal's receipt is
written from the rows read back out of Track meals after the save.

**A plan made by chat is built by code, from meals already eaten.** "Plan
tomorrow so I hit 90 g protein" is read by `planRequest` and answered with
no model (`domain/mealplan.ts`, reads and the save in `mealplanner.ts`).
Every meal in a plan is one the person logged whole in the last 28 days,
with the dishes and amounts they logged; the planner only chooses which goes
in each slot, and says how far the day is from the aim. Nothing is scaled or
swapped to reach a figure: that would be the app writing an amount nobody
ate. A plan asked for under the calorie floor gets the gate's own stop.

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

**Backup and restore are the one path that replaces everything.** Dev →
Your data. A backup is the whole SQLite file, opened and counted before it
is handed over. Restore (`db/worker.ts`, rules in `db/backup.ts`) opens the
chosen file beside the live database, refuses anything damaged, foreign,
empty or from a newer schema, shows its counts next to the phone's, keeps a
copy of the live database (`mealo.before-restore.sqlite3` in OPFS), then
replaces, re-checks, migrates forward and compares row counts, putting the
copy back on any failure. Never weaken a step of that order. A backup holds
no API key and no pairing code, on purpose: both live in IndexedDB, and a
key in a file in Downloads has left the place built to keep it.

**Reminders: the relay learns the times and nothing else.** Due doses and
an evening meal nudge, by web push (`domain/reminders.ts`, `remindersync.ts`,
`public/push-sw.js`, "Reminders" in `worker/index.ts`). The phone works out
its next 14 days of rings from the record, keeps the list with its words in
IndexedDB, and sends the relay only the minutes. The relay's cron sends an
empty push at each; the service worker reads the phone's own list and shows
what falls on that minute. The whole list is replaced each time, which is
how a ticked dose stops ringing, and `db/scope.ts` announces every write to
a table a ring depends on so no write path can forget to. Three things must
stay true: a push always shows a notification (iOS withdraws a subscription
after three that do not); no reminder ever carries an amount, names on or
off (R2); the permission prompt is raised only by the tap on the switch.
The VAPID keys are Worker secrets Upendra sets himself
(`scripts/vapid-keys.mjs`); never generate, read or ask for the private one.
`/__scheduled` does not reach this Worker in `wrangler dev` (the SPA
fallback answers it); the test uses `/cdn-cgi/handler/scheduled`.

**The demo is a build, not a setting.** `__DEMO__` is a literal set by
`vite.config.ts` from `VITE_DEMO`, so in the real build the branch that loads
`src/demo/seed.ts` is `if (false)` and the made-up person is not in the bundle
at all. (Read through `import.meta.env` the file was still emitted and went to
every phone's offline cache.) The seeder writes through the app's own save
functions, only into a database that was empty when it began, and every step
can be run again, because a reload two seconds in once left it half-written
for good; it is now one transaction, and a run cut short is wiped and
written again. The demo lives on Cloudflare Pages so that its address shares
nothing with the real app's. It has exactly one server-side piece,
`worker/demo-ai.js`: a relay that lets a visitor try Ask Mealo on a shared
key (`AI_KEY`, a Pages secret Upendra sets; never read, ask for or generate
it). The relay forces its own model, passes on only the fields the app
sends, caps the answer, answers the demo's own origin only, and logs
nothing. It does not count visitors: the limit is the provider's free
allowance, on an account with no payment method. No D1, no sync relay, no
cron for the demo, and **never a relay like this for the real app**.
**Run nothing `wrangler pages …` from this folder except through
`npm run deploy:demo`:** here wrangler finds the real app's `wrangler.jsonc`,
and `wrangler pages dev` once served the real build and opened the real D1
with the saved login. `test:demo` (42 checks) runs the relay against a
stand-in provider.

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
at **v14**. **Shipped means any database has run it — a dev browser included.**
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
encrypted delta sync works for the food and medicine libraries, and reminders by web push are
built (asleep until the VAPID secrets are set); passphrase, encrypted export and health-table
sync are open. **Phase 6 mostly done** — the LICENSE (MIT), the demo build, a
walk through it (`docs/demo-tour.png`) and the rewritten README are in; no CONTRIBUTING and no CI. See `ROADMAP.md` for the per-phase checklists and `HANDOFF.md` §6 for known
rough edges.

Track meds was rebuilt in v10–v11: the medicine definition/regimen split (shared
library, per-person regimens), sick mode, non-daily schedules and the medicine
log. Parked, to discuss: reading a prescription from an image or PDF (needs a
decision on whether an image may leave the phone — P2).

Next is making the app smart: Ask Mealo with Thali and Dawa as tools, reports,
and the safety gates and their test suite. The plan and what Upendra has
approved are in `Approved Ideas.md` (gitignored, local only); it is not yet
written into `ROADMAP.md`.
