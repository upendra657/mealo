/**
 * Who the app is currently logging for.
 *
 * A module with no imports, deliberately: db/scope.ts reads it on every query
 * and every insert, and profiles/store.ts writes it. Putting the value in its
 * own leaf module keeps that from becoming an import cycle.
 *
 * Synchronous by design. The database layer cannot await a lookup in the
 * middle of building a WHERE clause, so the id is held in memory and refreshed
 * by profiles/store.ts whenever it changes.
 */

/** The profile every pre-existing row was migrated to. See migration 4. */
export const PRIMARY_PROFILE = 'primary';

let current = PRIMARY_PROFILE;

export function activeProfile(): string {
  return current;
}

export function setActiveProfileId(id: string): void {
  if (id) current = id;
}
