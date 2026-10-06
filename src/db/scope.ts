/**
 * Per-agent table access, enforced in code.
 *
 * The product idea is three agents with asymmetric access: the Doctor sees
 * everything, the Nutritionist and Pharmacist each own their own tables and can
 * read only one thing from the Doctor — `current_state`.
 *
 * SQLite has no row-level security and every agent runs in the same process, so
 * that boundary has to live somewhere. It lives here. An agent asking for a
 * table outside its scope throws; it does not silently return nothing, because
 * a silent empty result is indistinguishable from "no data yet" and would hide
 * the bug for months.
 *
 * This is a correctness boundary, not a security one — anything on the page can
 * import db/client.ts directly. Its job is to make accidental cross-agent reads
 * impossible to write by mistake, which is the failure mode that actually
 * happens.
 */

import { activeProfile } from '../lib/active-profile';
import { bulkInsert, insert, query, run, softDelete, update } from './client';

export type Agent = 'doctor' | 'nutritionist' | 'pharmacist';

type Scope = { read: readonly string[]; write: readonly string[] };

const ALL_TABLES = [
  'medications',
  'intake_events',
  'med_doses',
  'sick_episodes',
  'med_products',
  'med_product_ingredients',
  'med_product_doses',
  'med_ref_sets',
  'med_ref_items',
  'meals',
  'meal_items',
  'foods',
  'custom_foods',
  'food_portions',
  'food_aliases',
  'symptoms',
  'current_state',
  'targets',
  'weights',
  'burns',
  'citations',
  'messages',
  'conversation_summaries',
  'profiles',
] as const;

/**
 * Tables that belong to one person rather than to the household.
 *
 * The food library is shared — same kitchen, same katori — but a record of a
 * body is not. Every row in these tables carries `profile_id`, and the handle
 * below refuses to read them without mentioning it. See the note on
 * ProfileScopeError for why that is a thrown error and not a silent default.
 *
 * `current_state` and `conversation_summaries` are absent because they encode
 * the profile in their primary key instead: one row per profile, and
 * "<profile>:<agent>" respectively.
 *
 * The three `med_product` tables are absent for the reason `custom_foods` is:
 * they are the household's medicine library, what a medicine is rather than
 * who takes it. Who takes it, how much and when is `medications` and
 * `med_doses`, and those are here.
 */
const PROFILE_SCOPED = [
  'medications',
  'intake_events',
  'med_doses',
  'sick_episodes',
  'meals',
  'meal_items',
  'symptoms',
  'weights',
  'burns',
  'messages',
] as const;

export const SCOPES: Record<Agent, Scope> = {
  // Orchestrator. Reads everything, and is the only writer of current_state
  // and the only reader of symptoms.
  doctor: {
    read: ALL_TABLES,
    write: ALL_TABLES,
  },

  // Owns medications. Reads current_state to know the user's situation, and
  // never sees the symptom log that produced it.
  pharmacist: {
    read: [
      'medications',
      'intake_events',
      'med_doses',
      'sick_episodes',
      'med_products',
      'med_product_ingredients',
      'med_product_doses',
      'med_ref_sets',
      'med_ref_items',
      'current_state',
      'citations',
      'messages',
      'conversation_summaries',
    ],
    write: [
      'medications',
      'intake_events',
      'med_doses',
      // Which sickness is running decides which medicines are due, so the
      // Pharmacist owns it. The Doctor still reads it, as it reads everything.
      'sick_episodes',
      'med_products',
      'med_product_ingredients',
      'med_product_doses',
      // Reference lists of medicines, device-local, like the bundled foods.
      'med_ref_sets',
      'med_ref_items',
      'citations',
      'messages',
      'conversation_summaries',
    ],
  },

  // Owns meals. Same deal: current_state in, nothing else.
  nutritionist: {
    read: [
      'meals',
      'meal_items',
      'targets',
      'foods',
      'custom_foods',
      'food_portions',
      'food_aliases',
      'current_state',
      // Read, never written. Weight is a body measurement, so the Doctor owns
      // it; the Nutritionist sees it because the home banner speaks in its
      // voice and a trend is part of how a day reads.
      'weights',
      // Same: the Doctor owns what the body did, the Nutritionist may read it
      // when asked about a day. Read access here is not permission for the
      // banner to bring it up — the banner is a pure function in
      // domain/banner.ts and composes no burn card, deliberately. And it is
      // not permission to net burn against the energy target: nothing in the
      // app subtracts one from the other.
      'burns',
      'citations',
      'messages',
      'conversation_summaries',
    ],
    write: [
      'meals',
      'meal_items',
      'targets',
      'custom_foods',
      'food_portions',
      'food_aliases',
      'citations',
      'messages',
      'conversation_summaries',
    ],
  },
};

/**
 * Thrown when a query reads a per-person table without filtering by profile.
 *
 * This is loud on purpose, and it is the one guard in the codebase that exists
 * because of what the failure would look like rather than how likely it is: a
 * missing `profile_id` in a WHERE clause does not crash, does not look wrong in
 * review, and does not show up in testing with one profile. It shows up as one
 * person's meals appearing in the other's day, and as the Doctor advising him
 * about her symptoms. There is no safe default to fall back on, so the query
 * fails instead.
 */
export class ProfileScopeError extends Error {
  constructor(table: string, sql: string) {
    super(
      `Query reads "${table}" without a profile filter. Every read of a ` +
        `per-person table must constrain profile_id — see db/scope.ts. SQL: ` +
        sql.replace(/\s+/g, ' ').trim().slice(0, 160),
    );
    this.name = 'ProfileScopeError';
  }
}

export class ScopeError extends Error {
  constructor(agent: Agent, table: string, mode: 'read' | 'write') {
    super(
      `${agent} may not ${mode} "${table}". Scope is defined in db/scope.ts — ` +
        `widen it deliberately or route through current_state.`,
    );
    this.name = 'ScopeError';
  }
}

function assertAllowed(agent: Agent, table: string, mode: 'read' | 'write') {
  const allowed = SCOPES[agent][mode];
  if (!allowed.includes(table)) throw new ScopeError(agent, table, mode);
}

/**
 * Pulls table names out of a SQL string.
 *
 * Deliberately crude — it catches FROM, JOIN, INTO and UPDATE targets, which is
 * every way this codebase touches a table. It is a backstop for the typed
 * helpers below, not a SQL parser, and it errs toward flagging too much rather
 * than too little.
 */
export function tablesIn(sql: string): string[] {
  const found = new Set<string>();
  const re = /\b(?:from|join|into|update)\s+["'`]?([a-z_][a-z0-9_]*)["'`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if ((ALL_TABLES as readonly string[]).includes(name)) found.add(name);
  }
  return [...found];
}

export function isProfileScoped(table: string): boolean {
  return (PROFILE_SCOPED as readonly string[]).includes(table);
}

/** Has this SQL constrained profile_id at all? Crude, and meant to be. */
function mentionsProfile(sql: string): boolean {
  return /\bprofile_id\b/i.test(sql);
}

function assertProfileFiltered(sql: string) {
  if (mentionsProfile(sql)) return;
  for (const t of tablesIn(sql)) {
    if (isProfileScoped(t)) throw new ProfileScopeError(t, sql);
  }
}

export type ScopedDb = ReturnType<typeof scopedDb>;

/**
 * Database handle that can only touch what this agent is allowed to touch,
 * for the person currently selected.
 *
 * `profileId` is resolved lazily through a getter rather than captured, so a
 * handle created at module load — which is how every domain file does it —
 * follows the active profile instead of pinning whichever one was selected
 * when the module first ran.
 */
export function scopedDb(agent: Agent, profileId: () => string = activeProfile) {
  return {
    agent,

    /** Read. Every table the SQL mentions must be in the agent's read scope. */
    async query<T = Record<string, unknown>>(
      sql: string,
      bind?: unknown[],
    ): Promise<T[]> {
      for (const t of tablesIn(sql)) assertAllowed(agent, t, 'read');
      assertProfileFiltered(sql);
      return query<T>(sql, bind);
    },

    /** Write raw SQL. Same check, against the write scope. */
    async run(sql: string, bind?: unknown[]): Promise<void> {
      for (const t of tablesIn(sql)) assertAllowed(agent, t, 'write');
      assertProfileFiltered(sql);
      return run(sql, bind);
    },

    async insert(
      table: string,
      values: Record<string, unknown>,
    ): Promise<string> {
      assertAllowed(agent, table, 'write');
      // Stamped here rather than by each caller. A row written without a
      // profile belongs to nobody and is invisible to everyone, which is a
      // far worse bug than a query that throws.
      const row =
        isProfileScoped(table) && values.profile_id === undefined
          ? { ...values, profile_id: profileId() }
          : values;
      return insert(table, row);
    },

    async update(
      table: string,
      id: string,
      values: Record<string, unknown>,
    ): Promise<void> {
      assertAllowed(agent, table, 'write');
      return update(table, id, values);
    },

    /** Many rows at once, for the reference lists; refused for anyone's record. */
    async bulkInsert(table: string, columns: string[], rows: unknown[][]): Promise<number> {
      assertAllowed(agent, table, 'write');
      if (isProfileScoped(table)) {
        throw new Error(`bulk writes skip the profile stamp, so ${table} cannot take one`);
      }
      return bulkInsert(table, columns, rows);
    },

    async softDelete(table: string, id: string): Promise<void> {
      assertAllowed(agent, table, 'write');
      return softDelete(table, id);
    },
  };
}
