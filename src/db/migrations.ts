/**
 * Schema migrations.
 *
 * Rules that apply to every table here:
 *   - `id` is a device-scoped string (see lib/device.ts), never an autoincrement
 *   - `updated_at` is milliseconds since epoch, written on every change
 *   - `deleted_at` marks soft deletes, because a hard delete cannot be synced
 *
 * Those three exist from migration 1 on purpose. Whichever sync path we take in
 * Phase 5 will require all of them, and adding them once months of real logged
 * data exists is the expensive version of this decision.
 *
 * Access scope is documented per table and enforced in db/repos.ts — not here.
 * SQLite has no row-level security, so the boundary lives in the layer above.
 */

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      -- ---- Pharmacist -------------------------------------------------
      CREATE TABLE IF NOT EXISTS medications (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        raw_text     TEXT,              -- exactly what the user typed
        rxcui        TEXT,              -- RxNorm concept, when one resolves
        dose_text    TEXT,              -- recorded verbatim, never computed
        schedule     TEXT,              -- free text in v1
        started_on   TEXT,              -- ISO date
        ended_on     TEXT,
        notes        TEXT,
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS intake_events (
        id             TEXT PRIMARY KEY,
        medication_id  TEXT NOT NULL,
        taken_at       INTEGER NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('taken','skipped')),
        note           TEXT,
        updated_at     INTEGER NOT NULL,
        deleted_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_intake_med  ON intake_events(medication_id);
      CREATE INDEX IF NOT EXISTS idx_intake_time ON intake_events(taken_at);

      -- ---- Nutritionist -----------------------------------------------
      CREATE TABLE IF NOT EXISTS meals (
        id          TEXT PRIMARY KEY,
        eaten_at    INTEGER NOT NULL,
        raw_text    TEXT,               -- as typed; null for pure macro entry
        meal_type   TEXT,               -- breakfast / lunch / dinner / snack
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_meals_time ON meals(eaten_at);

      -- source tells us where the numbers came from, and it matters:
      --   'direct'  the user typed the macros off a label
      --   'matched' resolved against the bundled food tables
      --   'model'   the model estimated it
      -- A 'direct' row must never be silently overwritten by a later match.
      CREATE TABLE IF NOT EXISTS meal_items (
        id           TEXT PRIMARY KEY,
        meal_id      TEXT NOT NULL,
        label        TEXT NOT NULL,
        food_id      TEXT,
        quantity     REAL,
        unit         TEXT,
        energy_kcal  REAL,
        protein_g    REAL,
        fat_g        REAL,
        carbs_g      REAL,
        fibre_g      REAL,
        source       TEXT NOT NULL CHECK (source IN ('direct','matched','model')),
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_items_meal ON meal_items(meal_id);

      -- Bundled reference data (IFCT 2017 + USDA subset). Read-only, shipped
      -- with the app, not synced.
      CREATE TABLE IF NOT EXISTS foods (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        source_db    TEXT NOT NULL,     -- 'IFCT2017' | 'USDA'
        per_unit     TEXT NOT NULL,     -- e.g. '100g'
        energy_kcal  REAL,
        protein_g    REAL,
        fat_g        REAL,
        carbs_g      REAL,
        fibre_g      REAL
      );
      CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);

      -- The user's own vocabulary. Grows as they log; this is what lets most
      -- meals resolve with zero model calls.
      CREATE TABLE IF NOT EXISTS food_aliases (
        id          TEXT PRIMARY KEY,
        alias       TEXT NOT NULL,
        food_id     TEXT NOT NULL,
        hits        INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alias ON food_aliases(alias);

      -- ---- Doctor ------------------------------------------------------
      -- Readable by the Doctor alone. Everything the other agents need about
      -- the user's condition arrives via current_state.
      CREATE TABLE IF NOT EXISTS symptoms (
        id           TEXT PRIMARY KEY,
        noted_at     INTEGER NOT NULL,
        raw_text     TEXT NOT NULL,
        label        TEXT,
        severity     INTEGER,           -- 1-5, user reported
        resolved_at  INTEGER,
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_symptoms_time ON symptoms(noted_at);

      -- Exactly one row, id = 'singleton'. Written by the Doctor, read by all
      -- three. This is the entire cross-agent interface.
      CREATE TABLE IF NOT EXISTS current_state (
        id           TEXT PRIMARY KEY,
        summary      TEXT,              -- short, de-identified, model-facing
        flags        TEXT,              -- JSON array of strings
        updated_at   INTEGER NOT NULL
      );

      -- ---- Shared ------------------------------------------------------
      CREATE TABLE IF NOT EXISTS citations (
        id            TEXT PRIMARY KEY,
        claim         TEXT NOT NULL,
        source_name   TEXT NOT NULL,    -- 'openFDA', 'RxNorm', 'IFCT2017', ...
        source_url    TEXT NOT NULL,
        excerpt       TEXT,
        retrieved_at  INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        deleted_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        agent       TEXT NOT NULL CHECK (agent IN ('doctor','nutritionist','pharmacist')),
        role        TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent, created_at);

      -- Rolling per-agent summary, so we never replay full history into a
      -- prompt. See the token budget section of the blueprint.
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id          TEXT PRIMARY KEY,   -- the agent name
        summary     TEXT NOT NULL,
        upto_msg_id TEXT,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
