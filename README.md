# Mealo

Local-first health tracking with three scoped AI agents — a Doctor, a Nutritionist
and a Pharmacist — that read and write a database which never leaves your device.

**Status: Phase 0.** Skeleton, provider adapter, and storage layer. No agents yet.

---

## What this is not

Read this part first.

- **Not a medical device.** It does not diagnose, and it never suggests, calculates
  or confirms a dose. Not on request, not as an example.
- **Not a substitute for a doctor.** Independent evaluation of consumer chatbots on
  patient-posed medical questions found unsafe answer rates between 5% and 13.5%
  depending on the model. This app is built to reduce that — facts come from cited
  sources rather than model recall, and red-flag symptoms are routed by code before
  the model ever sees the message — but it does not eliminate it.
- **Not a cloud service.** There is no account and no server holding your data.
  If you lose the device and have no export, the data is gone.

## How it works

Your logs live in SQLite in your browser's origin-private file system. Nothing is
uploaded. When an agent needs a model, the app sends a scoped, de-identified slice
of your state to whichever provider *you* configured with *your own* API key.

The key identifies you to that provider and carries no data — rotating it never
touches your logs. From Phase 5 the passphrase, not the key and not the device, is
what identifies your data.

## Running it

```bash
npm install
npm run dev
```

Then open the printed URL and go to **Settings** to configure a provider.

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

## Project layout

```
src/
  lib/
    kv.ts          IndexedDB key/value — settings live here, not in SQLite, so a
                   broken database is never an unrecoverable state
    device.ts      device id + device-scoped row ids
    persist.ts     navigator.storage.persist() and quota reporting
  db/
    migrations.ts  schema; every table has id / updated_at / deleted_at from v1
    worker.ts      SQLite in a worker, OPFS with an in-memory fallback
    client.ts      main-thread API — the seam a sync engine would replace
  llm/
    types.ts       message, tool and error shapes
    providers.ts   registry, including each provider's data policy verbatim
    adapter.ts     the single OpenAI-compatible adapter + outbound payload log
  settings/
    store.ts       persisted provider configuration
  ui/              Phase 0 scaffolding: playground, settings, status bar
```

## Design rules

1. The database never leaves the device unless the user exports it.
2. What crosses the network is a de-identified slice, assembled per call.
3. Facts come from sources (openFDA, RxNorm, IFCT 2017, USDA), not from weights.
4. Fail closed — red-flag triage is code that runs before any model call.
5. No recurring cost to anyone. Bring your own key.
6. Logging friction is the product. Over ten seconds and nothing else matters.

## Phase 0 exit criteria

- [x] Installable PWA shell, dark and light
- [x] SQLite over OPFS with migrations, and `updated_at` + device-scoped ids
- [x] `navigator.storage.persist()` requested and its result surfaced
- [x] One OpenAI-compatible adapter with Ollama as the first implementation
- [x] Settings screen with provider data policies and a Test connection button
- [ ] A message reaches Ollama on the Mac and renders a reply
- [ ] The same adapter reaches Groq from a deployed origin with no CORS error
- [ ] Sync path chosen — spike Evolu against iOS Safari, or decide against it

## Licence

MIT.
