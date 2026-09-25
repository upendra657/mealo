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

MIGRATIONS.push({
  version: 2,
  name: 'custom foods',
  sql: `
    -- Foods the user defined themselves, kept separate from \`foods\` on
    -- purpose.
    --
    -- \`foods\` is reference data: it ships with the app, no agent may write it,
    -- and reseeding wipes and rewrites it wholesale. Putting user-defined foods
    -- in the same table would mean a dataset upgrade silently deleting the
    -- paneer someone entered by hand.
    --
    -- This table is the opposite of that in every respect: the Nutritionist
    -- owns it, it carries the sync columns, and it is never regenerated. The
    -- matcher searches both and prefers these, because something you defined
    -- beats a generic reference row every time.
    CREATE TABLE IF NOT EXISTS custom_foods (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      per_unit     TEXT NOT NULL DEFAULT '100g',
      energy_kcal  REAL,
      protein_g    REAL,
      fat_g        REAL,
      carbs_g      REAL,
      fibre_g      REAL,
      notes        TEXT,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_custom_foods_name ON custom_foods(name);
  `,
});

MIGRATIONS.push({
  version: 3,
  name: 'food portions',
  sql: `
    -- What a household measure weighs, for one specific dish.
    --
    -- The reason this is a table and not a column: a dish has more than one
    -- honest answer. Dal is 150g in a katori and 250g in a bowl, and neither
    -- is more correct. A single "serving size" column forces a choice that
    -- then has to be undone by hand at every meal that used the other one.
    --
    -- Each row is an anchor: "\`quantity\` \`measure\` of this dish weighs
    -- \`net_weight_g\`". Everything else is derived from the anchors —
    -- arbitrary quantities scale linearly, and other volume measures come
    -- through the density the anchor implies. That derivation lives in
    -- domain/portions.ts; this table only stores what was actually measured.
    --
    -- Shared across profiles on purpose: two people in one kitchen use the
    -- same katori. Only the logs are per-person.
    CREATE TABLE IF NOT EXISTS food_portions (
      id            TEXT PRIMARY KEY,
      food_id       TEXT NOT NULL,     -- custom_foods.id or foods.id
      measure       TEXT NOT NULL,     -- canonical id from domain/measures.ts
      quantity      REAL NOT NULL DEFAULT 1,
      net_weight_g  REAL NOT NULL,
      -- The one offered first when this dish is logged with no measure given.
      is_default    INTEGER NOT NULL DEFAULT 0,
      -- 'user'     typed or imported — a real measurement
      -- 'derived'  written by the app from another anchor; may be replaced
      source        TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','derived')),
      updated_at    INTEGER NOT NULL,
      deleted_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_portions_food ON food_portions(food_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portions_unique
      ON food_portions(food_id, measure);

    -- The weight a logged item actually worked out to. quantity+unit alone
    -- ("1 katori") stops meaning a fixed amount the moment the portion behind
    -- it is corrected, so the number used at the time is recorded with it.
    ALTER TABLE meal_items ADD COLUMN net_weight_g REAL;
  `,
});

MIGRATIONS.push({
  version: 4,
  name: 'profiles',
  sql: `
    -- Two people, one app.
    --
    -- The split is deliberate and it is not "everything is per person". A
    -- household shares a kitchen: the same katori, the same dal, the same
    -- weights. So the food library — foods, custom_foods, food_portions,
    -- food_aliases — stays shared, and every dish either of you records is
    -- immediately available to the other.
    --
    -- What is emphatically not shared is the record of a body: meals eaten,
    -- medications, doses, symptoms, and the agent conversations that read
    -- them. Those carry profile_id and are filtered on it, and db/scope.ts
    -- refuses any query against these tables that forgets to.
    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      colour      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    );

    -- 'primary' is a fixed id rather than a device-scoped one, so that the
    -- same person's profile carries the same id on the Mac and the phone and
    -- the two halves reconcile when sync arrives in Phase 5.
    INSERT OR IGNORE INTO profiles (id, name, created_at, updated_at)
      VALUES ('primary', 'Me',
              CAST(strftime('%s','now') AS INTEGER) * 1000,
              CAST(strftime('%s','now') AS INTEGER) * 1000);

    ALTER TABLE medications   ADD COLUMN profile_id TEXT;
    ALTER TABLE intake_events ADD COLUMN profile_id TEXT;
    ALTER TABLE meals         ADD COLUMN profile_id TEXT;
    ALTER TABLE meal_items    ADD COLUMN profile_id TEXT;
    ALTER TABLE symptoms      ADD COLUMN profile_id TEXT;
    ALTER TABLE messages      ADD COLUMN profile_id TEXT;

    -- Everything logged before this migration belongs to whoever was using
    -- the app, which is the primary profile by definition.
    UPDATE medications   SET profile_id = 'primary' WHERE profile_id IS NULL;
    UPDATE intake_events SET profile_id = 'primary' WHERE profile_id IS NULL;
    UPDATE meals         SET profile_id = 'primary' WHERE profile_id IS NULL;
    UPDATE meal_items    SET profile_id = 'primary' WHERE profile_id IS NULL;
    UPDATE symptoms      SET profile_id = 'primary' WHERE profile_id IS NULL;
    UPDATE messages      SET profile_id = 'primary' WHERE profile_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_meals_profile   ON meals(profile_id, eaten_at);
    CREATE INDEX IF NOT EXISTS idx_items_profile   ON meal_items(profile_id);
    CREATE INDEX IF NOT EXISTS idx_meds_profile    ON medications(profile_id);
    CREATE INDEX IF NOT EXISTS idx_intake_profile  ON intake_events(profile_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_sympt_profile   ON symptoms(profile_id, noted_at);
    CREATE INDEX IF NOT EXISTS idx_msg_profile     ON messages(profile_id, agent, created_at);

    -- current_state is one row per profile, keyed by the profile id, so the
    -- old singleton becomes the primary profile's state.
    UPDATE current_state SET id = 'primary' WHERE id = 'singleton';

    -- Conversation summaries are keyed "<profile>:<agent>" from here on.
    UPDATE conversation_summaries
       SET id = 'primary:' || id
     WHERE id IN ('doctor','nutritionist','pharmacist');
  `,
});

MIGRATIONS.push({
  version: 5,
  name: 'daily targets',
  sql: `
    -- What each person is aiming at, per day.
    --
    -- Per profile, because two people in one house do not share a calorie
    -- budget. Every column is nullable on purpose: a target nobody has set is
    -- null, not zero, and the UI shows a grey bar rather than measuring you
    -- against a number the app invented. Nothing here is computed from height
    -- or weight — that would be the app making a health recommendation, which
    -- it does not do.
    CREATE TABLE IF NOT EXISTS targets (
      id           TEXT PRIMARY KEY,   -- the profile id
      energy_kcal  REAL,
      protein_g    REAL,
      fat_g        REAL,
      carbs_g      REAL,
      fibre_g      REAL,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
  `,
});

MIGRATIONS.push({
  version: 6,
  name: 'library slugs and sharing',
  sql: `
    -- Two columns that only make sense once there is more than one device.
    --
    -- \`slug\` is the merge key. Row ids are device-scoped and random (see
    -- lib/device.ts), which is exactly right for a meal — two people cannot
    -- log the same dinner — and exactly wrong for a dish. If one phone adds
    -- "Dal Tadka" and the other adds "Dal Tadka", those are two unrelated ids
    -- holding one dish, and last-write-wins has nothing to resolve: it settles
    -- edits to the same row, not independent creation of the same thing. A
    -- sync that merged on id would quietly double the library.
    --
    -- So a dish carries a second identity derived from its name, computed by
    -- domain/foods.ts \`slugFor\` — the same normaliser the matcher already
    -- uses, deliberately not a second copy of it. Both phones generate the
    -- same slug for the same dish without coordinating, which is the whole
    -- trick.
    --
    -- Not UNIQUE, and not backfilled here. Normalisation strips accents and
    -- plurals, which SQLite cannot do, so the backfill is JS and runs on init
    -- (\`initFoodLibrary\`). A unique index would also mean a migration that
    -- can fail on real data at startup, inside a worker, with the app already
    -- on screen. Uniqueness is enforced at the write path instead, which is
    -- where the question "does this dish already exist" was already being
    -- asked.
    ALTER TABLE custom_foods ADD COLUMN slug TEXT;

    -- \`share\` is per-dish consent to leave the household, for the public
    -- pool in Phase 6. Default 0 — off. Publishing is a decision about one
    -- dish at a time, not a setting flipped once for a library that is also a
    -- record of what two specific people eat.
    ALTER TABLE custom_foods ADD COLUMN share INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_custom_foods_slug ON custom_foods(slug);
  `,
});

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
