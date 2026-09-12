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

import { insert, query, run, softDelete, update } from './client';

export type Agent = 'doctor' | 'nutritionist' | 'pharmacist';

type Scope = { read: readonly string[]; write: readonly string[] };

const ALL_TABLES = [
  'medications',
  'intake_events',
  'meals',
  'meal_items',
  'foods',
  'food_aliases',
  'symptoms',
  'current_state',
  'citations',
  'messages',
  'conversation_summaries',
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
      'food_aliases',
      'current_state',
      'citations',
      'messages',
      'conversation_summaries',
    ],
    write: [
      'meals',
      'meal_items',
      'food_aliases',
      'citations',
      'messages',
      'conversation_summaries',
    ],
  },
};

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

export type ScopedDb = ReturnType<typeof scopedDb>;

/** Database handle that can only touch what this agent is allowed to touch. */
export function scopedDb(agent: Agent) {
  return {
    agent,

    /** Read. Every table the SQL mentions must be in the agent's read scope. */
    async query<T = Record<string, unknown>>(
      sql: string,
      bind?: unknown[],
    ): Promise<T[]> {
      for (const t of tablesIn(sql)) assertAllowed(agent, t, 'read');
      return query<T>(sql, bind);
    },

    /** Write raw SQL. Same check, against the write scope. */
    async run(sql: string, bind?: unknown[]): Promise<void> {
      for (const t of tablesIn(sql)) assertAllowed(agent, t, 'write');
      return run(sql, bind);
    },

    async insert(
      table: string,
      values: Record<string, unknown>,
    ): Promise<string> {
      assertAllowed(agent, table, 'write');
      return insert(table, values);
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
