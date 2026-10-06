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

MIGRATIONS.push({
  version: 7,
  name: 'weights',
  sql: `
    -- Weight, entered by hand.
    --
    -- Per person and never anything else: this is the most personal number in
    -- the app and the one that would be most wrong to show in the other
    -- person's day. The food library is shared; a body is not.
    --
    -- Stored in kilograms because storing a unit alongside a number invites
    -- two rows that disagree about what 70 means. Display can convert.
    --
    -- No goal column here; a goal belongs with the other things this person
    -- is aiming at, so it lives on the targets table (v8). Either way nothing
    -- in the app computes a goal weight from height or activity — that would
    -- be a health recommendation. A number the user typed is their own.
    CREATE TABLE IF NOT EXISTS weights (
      id           TEXT PRIMARY KEY,
      profile_id   TEXT,
      measured_at  INTEGER NOT NULL,   -- ms since epoch, local day bucketed in JS
      kg           REAL NOT NULL,
      note         TEXT,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_weights_when
      ON weights(profile_id, measured_at);
  `,
});

MIGRATIONS.push({
  version: 8,
  name: 'goal weight',
  sql: `
    -- A weight to aim at, sitting beside the daily macro targets because it is
    -- the same kind of fact: something this person decided they are working
    -- toward. Nullable and stays null until someone types a number, exactly
    -- like every other column on this table — the chart draws no goal line
    -- until there is a goal to draw.
    --
    -- Typed by the user, never derived. The app has no opinion about what
    -- anyone should weigh and does not acquire one by storing this.
    ALTER TABLE targets ADD COLUMN weight_kg REAL;
  `,
});

MIGRATIONS.push({
  version: 9,
  name: 'burns',
  sql: `
    -- Calories burnt, entered by hand. The same shape as weights and for the
    -- same reasons: per person, local day bucketed in JS, soft deleted.
    --
    -- One row per day holding the day's TOTAL, not one row per session. A
    -- walk in the morning and a gym session at night add into the same row,
    -- because every question anyone asks of this number is a daily one — did
    -- I hit 500 today, what has the week looked like — and a table of
    -- sessions would have to be summed before any of them could be answered.
    -- The cost is that the app cannot show you the session breakdown, which
    -- nothing in it asks for.
    --
    -- kcal, matching foods and targets, so nothing in the app has to know
    -- which unit a number is in.
    --
    -- Emphatically NOT netted against the food budget. Burning 500 does not
    -- raise the day's remaining calories; the tile and the banner read the
    -- plain energy target exactly as before. This is a measurement the agents
    -- can reason about, not a term in an equation the app computes.
    CREATE TABLE IF NOT EXISTS burns (
      id           TEXT PRIMARY KEY,
      profile_id   TEXT,
      measured_at  INTEGER NOT NULL,   -- ms since epoch, local day bucketed in JS
      kcal         REAL NOT NULL,
      note         TEXT,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_burns_when
      ON burns(profile_id, measured_at);

    -- A daily burn target, beside weight_kg and the macro goals. Nullable and
    -- null until someone types a number: the chart draws no target line and
    -- the card shows no meter until there is one.
    --
    -- Typed by the user, never derived. The app has no view on how much
    -- anyone should burn and does not acquire one by storing this.
    ALTER TABLE targets ADD COLUMN burn_kcal REAL;
  `,
});

MIGRATIONS.push({
  version: 10,
  name: 'medicine library, dose slots and sickness',
  sql: `
    -- A medicine splits into two halves, along the same line v4 drew for food.
    --
    -- What a medicine IS — name, form, strength, active ingredients, and the
    -- schedule people usually take it on — is a fact about a product, like a
    -- dish's recipe, and the household shares it: one of you adds Paracetamol
    -- 650 mg and the other finds it in the library instead of typing it out.
    -- Those rows live in the three med_product tables, carry no profile_id, and
    -- are what sync will carry.
    --
    -- What a person TAKES — their own amounts and times, whether it continues
    -- through a sickness, every tick — is a record of a body. That stays in
    -- medications, med_doses, intake_events and sick_episodes, all per person,
    -- none of them synced.
    --
    -- No CHECK constraints on the vocabulary columns (form, unit, time_of_day,
    -- meal). A CHECK cannot be widened without rebuilding the table, and with
    -- forward-only migrations that rebuild is the expensive kind of change. A
    -- fifth form — drops, an inhaler — should be a code change, so the lists
    -- are enforced in domain code instead.

    CREATE TABLE IF NOT EXISTS med_products (
      id             TEXT PRIMARY KEY,
      -- The merge key, from name AND strength, normalised in JS for the same
      -- reasons custom_foods.slug is (v6), and not UNIQUE for the same reasons.
      -- Strength is in it because Thyroxine 25 mcg and Thyroxine 50 mcg are
      -- two medicines. Changing either on a product saves a new product rather
      -- than editing this one, so a slug never changes under a row, and what
      -- someone's record says they took cannot be rewritten by another
      -- person's edit.
      slug           TEXT,
      name           TEXT NOT NULL,
      form           TEXT,              -- 'tablet' | 'syrup' | 'powder'
      strength_text  TEXT,              -- recorded verbatim, never computed
      -- Never leaves this device: sync skips the row. Off by default because a
      -- shared library is the point, but a medicine can be personal in a way a
      -- dish is not, so it is a decision one medicine at a time.
      private        INTEGER NOT NULL DEFAULT 0,
      -- Removed from the library's search, and nothing more. Anyone already
      -- taking it keeps it and their history still resolves its name, which
      -- is why this is not deleted_at. Syncs like any other edit, so removing
      -- it on one phone removes it from both libraries.
      hidden         INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL,
      deleted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_med_products_slug ON med_products(slug);

    CREATE TABLE IF NOT EXISTS med_product_ingredients (
      id             TEXT PRIMARY KEY,
      product_id     TEXT NOT NULL,
      position       INTEGER NOT NULL,
      name           TEXT NOT NULL,
      strength_text  TEXT,              -- verbatim, as printed on the strip
      updated_at     INTEGER NOT NULL,
      deleted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_med_ingredients_product
      ON med_product_ingredients(product_id);

    -- The schedule the library suggests. Whoever adds a medicine first gives it
    -- theirs; the next person starts from it and edits before saving. Most
    -- medicines are taken on much the same schedule, which is why it travels —
    -- decided knowingly, since these amounts began as one person's doses.
    --
    -- A starting point only. It is copied into med_doses when someone adds the
    -- medicine and never read by their day again, so editing it here changes
    -- nobody's doses.
    CREATE TABLE IF NOT EXISTS med_product_doses (
      id           TEXT PRIMARY KEY,
      product_id   TEXT NOT NULL,
      position     INTEGER NOT NULL,
      amount       REAL,
      unit         TEXT,                -- 'tablet' | 'ml' | 'scoop' | 'g'
      time_of_day  TEXT,                -- 'morning' | 'afternoon' | 'evening' | 'night'
      meal         TEXT,                -- 'before' | 'after'
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_med_product_doses_product
      ON med_product_doses(product_id);

    -- ---- per person ---------------------------------------------------

    -- One person's doses, 1 to 4 a medicine. Every amount here was typed by
    -- that person, or read off their prescription and confirmed by them; the
    -- app never fills one in on its own.
    CREATE TABLE IF NOT EXISTS med_doses (
      id             TEXT PRIMARY KEY,
      profile_id     TEXT,
      medication_id  TEXT NOT NULL,
      position       INTEGER NOT NULL,
      amount         REAL,
      unit           TEXT,
      time_of_day    TEXT,
      meal           TEXT,
      updated_at     INTEGER NOT NULL,
      deleted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_med_doses_med
      ON med_doses(profile_id, medication_id);

    -- One row per sickness, kept for good: the history is the point.
    --
    -- There is no "active" column. A sickness is active from started_on
    -- through last_day unless recovered_on is set, and that is computed when
    -- it is read. So nothing is written when sick mode begins or runs out —
    -- no flag to flip back, no midnight job to forget, no state that can be
    -- left half-switched. Regular medicines pause the same way: by being read
    -- against the dates, never by being edited.
    --
    -- last_day is stored rather than derived from the duration, so the
    -- calendar arithmetic ("1 month" from the 31st) runs once, in local time,
    -- in JS, and Extend has something to move. The duration as picked stays
    -- beside it, which is what lets history say "planned 7 days, lasted 10".
    CREATE TABLE IF NOT EXISTS sick_episodes (
      id             TEXT PRIMARY KEY,
      profile_id     TEXT,
      name           TEXT NOT NULL,
      started_on     TEXT NOT NULL,     -- local ISO date
      last_day       TEXT NOT NULL,     -- local ISO date, inclusive
      duration_n     INTEGER NOT NULL,  -- as picked: 7 …
      duration_unit  TEXT NOT NULL,     -- … 'days' | 'weeks' | 'months' | 'years'
      recovered_on   TEXT,              -- set by Recovered, and only by it
      updated_at     INTEGER NOT NULL,
      deleted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sick_episodes_profile
      ON sick_episodes(profile_id, started_on);

    -- Which library product this is. NULL for every medicine added before
    -- v10; those keep their name, dose_text and free-text schedule and are
    -- shown as written. Nothing turns "every morning" into a dose slot,
    -- because that would be the app interpreting a dose.
    --
    -- New rows still fill name and dose_text (the strength). Neither can
    -- change under a product, so the copy cannot drift, and a person's record
    -- does not depend on a library row someone else can hide.
    ALTER TABLE medications ADD COLUMN product_id TEXT;

    -- Keep taking through a sickness. Nullable on purpose, with no default:
    -- NULL means nobody was ever asked, which is true of every medicine that
    -- existed before this switch did. Defaulting those to 0 would quietly
    -- pause a thyroid tablet the first time sick mode started. New medicines
    -- always write 0 or 1 from the switch; NULL is left for the start-sick
    -- sheet to ask about before it pauses anything.
    ALTER TABLE medications ADD COLUMN long_term INTEGER;

    -- NULL for a regular medicine. Set, the medicine belongs to that sickness
    -- and is active only while it is.
    ALTER TABLE medications ADD COLUMN episode_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_meds_episode ON medications(profile_id, episode_id);

    -- Which dose slot a tick was for. NULL for ticks made before slots existed.
    ALTER TABLE intake_events ADD COLUMN dose_id TEXT;

    -- The local date the dose belonged to, set from the day on screen when the
    -- tick is made. taken_at alone would file a night dose taken at 00:30
    -- under the next day and show last night's Night as never taken.
    ALTER TABLE intake_events ADD COLUMN for_day TEXT;
    CREATE INDEX IF NOT EXISTS idx_intake_day ON intake_events(profile_id, for_day);
  `,
});

MIGRATIONS.push({
  version: 11,
  name: 'how often, and when a schedule took effect',
  sql: `
    -- Its own migration because v10 had already run when these were written.
    -- They were first added to v10 in place, on the reasoning that it had not
    -- reached a phone; but it had run on a development database, which
    -- recorded v10 as done, never re-ran it, and then failed every save with
    -- "table med_doses has no column named freq". A migration has shipped
    -- the moment any database has run it.
    --
    -- Which days a dose is due. NULL or 'daily'; 'alternate', every second
    -- day counted from freq_from; 'weekdays', with freq_days the days as 0-6
    -- from Sunday ("0,3"); 'monthly', with freq_days the date ("15"), held at
    -- the last day of a shorter month.
    --
    -- On the dose rather than the medicine on purpose. A schedule change
    -- soft-deletes the rows and writes new ones, and the old rows keep the old
    -- rule — which is what lets the log judge last month by last month's
    -- schedule instead of today's.
    ALTER TABLE med_doses ADD COLUMN freq TEXT;
    ALTER TABLE med_doses ADD COLUMN freq_days TEXT;
    ALTER TABLE med_doses ADD COLUMN freq_from TEXT;       -- local ISO date

    -- The local day this row became the schedule. With deleted_at it is the
    -- span the row was in force; NULL means from the medicine's start, which
    -- is what every row written before this column existed is taken to mean.
    ALTER TABLE med_doses ADD COLUMN from_day TEXT;

    -- How often, on the library's starting schedule, so a weekly medicine
    -- arrives weekly. freq_from is not carried: an alternate-day rhythm starts
    -- when the person taking it starts.
    ALTER TABLE med_product_doses ADD COLUMN freq TEXT;
    ALTER TABLE med_product_doses ADD COLUMN freq_days TEXT;
  `,
});

MIGRATIONS.push({
  version: 12,
  name: 'medicine reference datasets',
  sql: `
    -- Lists of medicines the app can suggest from: brand to ingredients. The
    -- Singapore HSA register ships with the app; anything else is imported on
    -- the device by its owner from a CSV or Excel file — an Indian list, one
    -- day a Thai one.
    --
    -- Reference data, not anyone's record. These tables belong to the device:
    -- no profile_id, never synced, never part of the shared library. Each
    -- phone imports its own copy, which is also what keeps someone else's
    -- dataset from being redistributed by the app (a choice made deliberately
    -- for an unofficial list). Only a medicine somebody saves from a
    -- suggestion enters the household library, as their own entry.
    --
    -- Rows are written and replaced wholesale, like the bundled foods table,
    -- so they are hard-deleted on replace: nothing here is synced, so a
    -- tombstone would serve no one.
    CREATE TABLE IF NOT EXISTS med_ref_sets (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,       -- "A-Z Medicine Dataset of India"
      tag          TEXT NOT NULL,       -- shown on every suggestion: "HSA", "India"
      source_url   TEXT,
      licence      TEXT,
      builtin      INTEGER NOT NULL DEFAULT 0,  -- shipped with the app
      -- 'importing' until every row is in, then 'ready'. Search reads ready
      -- sets only, so a half-finished import is never visible, and one that
      -- dies part-way leaves rows a later start can find and clear.
      status       TEXT NOT NULL,
      row_count    INTEGER NOT NULL DEFAULT 0,
      skipped      INTEGER NOT NULL DEFAULT 0,
      version      TEXT,                -- a bundled set's data version
      imported_at  INTEGER,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS med_ref_items (
      id           TEXT PRIMARY KEY,
      set_id       TEXT NOT NULL,
      name         TEXT NOT NULL,       -- as the dataset writes it
      name_norm    TEXT NOT NULL,       -- normalised, for prefix search
      -- [{"name": "...", "strength": "..."}], as the dataset wrote them
      ingredients  TEXT NOT NULL,
      form         TEXT,                -- the app's form id, when it can tell
      discontinued INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_med_ref_items_name ON med_ref_items(name_norm);
    CREATE INDEX IF NOT EXISTS idx_med_ref_items_set ON med_ref_items(set_id);
  `,
});

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
