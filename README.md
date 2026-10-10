# Mealo

Local-first health tracking: meals, medicines, weight and symptoms in a database
that lives on your device, and one AI chat that reads it.

- **Ask Mealo** is the AI chat. It answers from your own records, through a model
  provider you choose and a key you supply.
- **Thali** (meals) and **Dawa** (medicines) are not AI. They are plain code, so
  every calorie total and every "2 of 4 taken" is arithmetic, not a model's guess.

The app works fully without an API key. Tracking never depends on a model.

**Status:** meal and medicine tracking, two profiles on one device, and encrypted
sync of the shared food and medicine libraries are built; meal tracking is in
daily use. Ask Mealo exists as a chat over a summary of your records; giving it
tools, reports and a full safety test suite is the work in progress.
[ROADMAP.md](ROADMAP.md) has the phases so far.

---

## What this is not

Read this part first.

- **Not a medical device.** It does not diagnose, and it never suggests, calculates
  or confirms a dose. Not on request, not as an example.
- **Not for emergencies.** If something feels serious, see a doctor or call your
  local emergency number. A message that describes one of a fixed list of
  emergencies is stopped by code and answered with a direction to get care, before
  any model is called. That list cannot cover everything.
- **Not a substitute for a doctor.** A physician-led evaluation of four consumer
  chatbots on 222 patient-posed medical questions found unsafe answer rates between
  5% and 13.5% depending on the model
  ([Draelos et al., *npj Digital Medicine*, 2026](https://doi.org/10.1038/s41746-026-02428-5)).
  This app is built to reduce that — facts come from cited
  sources rather than model recall, and red-flag symptoms are routed by code before
  the model ever sees the message — but it does not eliminate it.
- **Not a cloud service.** There is no account and no server that can read your
  data. If you lose the device and have no export, the data is gone.

## How it works

Your logs live in SQLite in your browser's origin-private file system. When Ask
Mealo needs a model, the app sends a scoped, de-identified slice of your state to
whichever provider *you* configured with *your own* API key.

The key identifies you to that provider and carries no data — rotating it never
touches your logs. From Phase 5 the passphrase, not the key and not the device, is
what identifies your data.

Two devices can be paired to share one food library and one medicine library.
Those travel as ciphertext through a small relay that cannot read them, because
the household key never leaves the devices. What a person ate, took, weighed or
felt does not travel at all.

## Running it

```bash
npm install
npm run dev
```

Then open the printed URL and go to **Dev** on the home screen to configure a
provider.

### Provider setup

Every provider in the list is selectable. The app states each one's data policy
next to the key field and lets you decide — it does not decide for you.

| Provider | Free tier trains on your data? |
|---|---|
| Groq | No — stated across all tiers |
| Together AI | No — not without explicit opt-in |
| Ollama (local) | Nothing leaves your machine |
| Google Gemini | **Yes** on the free tier; human reviewers may read input and output |
| OpenRouter | **Yes** — free models require enabling training *and* prompt publication |

Use the **Test connection** button before anything else. It lists the provider's
models, which is cheap, needs no tokens, and fails in exactly the same way a real
call would — making it a reliable CORS canary.

### Local development against Ollama

```bash
ollama serve
ollama pull llama3.1:8b
```

Ollama refuses cross-origin browser requests by default. Set the origin or every
call fails as CORS against your own computer:

```bash
OLLAMA_ORIGINS="http://localhost:5173" ollama serve
```

## Cross-origin isolation

SQLite's OPFS backend requires the page to be cross-origin isolated, so the dev
and preview servers send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Your deployment host has to send them too.** Without them the app silently falls
back to an in-memory database that loses everything on reload. The status bar at
the top of the app reports which mode is live — watch it after you deploy.

## Deploying

A Cloudflare Worker serving static assets, free tier; `wrangler.jsonc` is the
whole configuration. The host **must** send the two isolation headers, which is
why `public/_headers` exists and why GitHub Pages is not an option — it cannot
set custom headers at all.

The same Worker is the sync relay, and it keeps its encrypted batches in a D1
database, so a deploy needs one of your own:

```bash
npx wrangler d1 create mealo-sync      # prints a database_id; put it in wrangler.jsonc
npx wrangler d1 execute mealo-sync --remote --file=migrations/0001_batches.sql
npm run build && npx wrangler deploy
```

`wrangler deploy` uploads whatever is in `dist/` and does not build, so build
first. Connecting the repository in the Cloudflare dashboard (**Workers & Pages**)
instead rebuilds and deploys on every push to `main`.

**Check the status bar on the deployed page before anything else.** If it reads
`in-memory` rather than `OPFS`, the headers aren't arriving and nothing you log
will survive a reload.

### Installing on iOS

Open the deployed HTTPS URL in Safari → Share → **Add to Home Screen**. It has
to be the deployed URL, not `localhost`, and it has to be Safari — Chrome on iOS
cannot install web apps.

Storage durability improves once installed: browsers weigh user engagement when
deciding whether to grant persistent storage, and an installed app scores higher
than a tab. Export regularly until the status bar says `persistent`.

## Project layout

```
src/
  db/
    migrations.ts  schema, forward-only; every table has id / updated_at /
                   deleted_at from v1
    worker.ts      SQLite in a worker, OPFS with an in-memory fallback
    client.ts      main-thread API
    scope.ts       per-table access, and the rule that a read of one person's
                   records must name the person or it throws
  domain/          the logic, as plain functions: meals, portions, medicines and
                   doses, weight, targets, the home banner, sync
  safety/
    redflags.ts    emergency triage in code, before any model call
    dosefilter.ts  removes dosing instructions from what a model says
    deidentify.ts  strips identifiers from everything sent to a provider
  llm/
    providers.ts   registry, including each provider's data policy verbatim
    adapter.ts     the single OpenAI-compatible adapter + outbound payload log
    conversation.ts  stored threads and rolling summaries
  data/            bundled reference data and the drug-label lookups
  lib/             device id, key/value store, household key, file parsing
  profiles/        who is logging
  settings/        persisted provider configuration
  ui/              the screens
worker/
  index.ts         the sync relay: an append-only log of ciphertext
scripts/           tests (pure logic, real SQLite in a browser, the relay) and
                   the data importers
```

## Design rules

1. The database never leaves the device unless the user exports it.
2. What crosses the network is a de-identified slice, assembled per call.
3. Facts come from sources (openFDA, RxNorm, USDA, Singapore's HSA register),
   not from weights.
4. Fail closed — red-flag triage is code that runs before any model call.
5. No recurring cost to anyone. Bring your own key.
6. Logging friction is the product. Over ten seconds and nothing else matters.

## Bundled data

- `src/data/foods.json`: 329 foods from USDA FoodData Central (public domain).
- `src/data/hsa.json`: Singapore's Listing of Registered Therapeutic Products,
  from the Health Sciences Authority under the Singapore Open Data Licence. The
  source and version are recorded in the file.

## Licence

MIT — see [LICENSE](LICENSE). The software is provided as is, without warranty.
