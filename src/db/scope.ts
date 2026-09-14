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
import { insert, query, run, softDelete, update } from './client';

export type Agent = 'doctor' | 'nutritionist' | 'pharmacist';

type Scope = { read: readonly string[]; write: readonly string[] };

const ALL_TABLES = [
  'medications',
  'intake_events',
  'meals',
  'meal_items',
  'foods',
  'custom_foods',
  'food_portions',
  'food_aliases',
  'symptoms',
  'current_state',
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
 */
const PROFILE_SCOPED = [
  'medications',
  'intake_events',
  'meals',
  'meal_items',
  'symptoms',
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
      'current_state',
      'citations',
      'messages',
      'conversation_summaries',
    ],
    write: [
      'medications',
      'intake_events',
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
      'foods',
      'custom_foods',
      'food_portions',
      'food_aliases',
      'current_state',
      'citations',
      'messages',
      'conversation_summaries',
    ],
    write: [
      'meals',
      'meal_items',
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

    async softDelete(table: string, id: string): Promise<void> {
      assertAllowed(agent, table, 'write');
      return softDelete(table, id);
    },
  };
}
