/**
 * Profiles — two people, one install.
 *
 * Not accounts, and not security. Anything on the page can read the whole
 * database; this is about a shared device where two people each want their own
 * day, their own medications, and a Doctor that is not reasoning about the
 * other one's symptoms. Same spirit as db/scope.ts: make the wrong thing hard
 * to write by accident, which is the failure that actually happens.
 *
 * What is shared and what is not:
 *
 *   shared     the food library — foods, custom_foods, food_portions,
 *              food_aliases. One kitchen, one katori, one table of dishes.
 *              A dish either of you records is immediately available to both.
 *   separate   meals, medications, doses, symptoms, current_state, and the
 *              agent conversations that read them.
 *
 * Uses the raw client rather than a scoped handle on purpose: profiles are app
 * infrastructure that exists before any agent does, the same reason seeding
 * the food table does.
 */

import { insert, query, softDelete, update } from '../db/client';
import {
  activeProfile,
  PRIMARY_PROFILE,
  setActiveProfileId,
} from '../lib/active-profile';
import { kvGet, kvSet } from '../lib/kv';

const ACTIVE_KEY = 'active-profile';

export type Profile = {
  id: string;
  name: string;
  colour: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export { activeProfile, PRIMARY_PROFILE };

export async function listProfiles(): Promise<Profile[]> {
  return query<Profile>(
    `SELECT * FROM profiles WHERE deleted_at IS NULL
      ORDER BY created_at`,
  );
}

/**
 * Settle which profile is active, before anything reads the database.
 *
 * The stored choice is validated against the table rather than trusted: a
 * profile deleted on another device would otherwise leave this one filtering
 * every query by an id that no longer exists, which looks exactly like having
 * lost all your data.
 */
export async function initProfiles(): Promise<{
  profiles: Profile[];
  active: string;
}> {
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    // Migration 4 creates 'primary'; this only fires if it was deleted.
    await insert('profiles', {
      id: PRIMARY_PROFILE,
      name: 'Me',
      colour: null,
      created_at: Date.now(),
      deleted_at: null,
    });
    setActiveProfileId(PRIMARY_PROFILE);
    return { profiles: await listProfiles(), active: PRIMARY_PROFILE };
  }

  const stored = await kvGet<string>(ACTIVE_KEY);
  const active =
    stored && profiles.some((p) => p.id === stored) ? stored : profiles[0].id;
  setActiveProfileId(active);
  if (active !== stored) await kvSet(ACTIVE_KEY, active);
  return { profiles, active };
}

/**
 * Switch person.
 *
 * The caller must re-read everything afterwards — every screen's data is now a
 * different person's. Nothing here tries to be clever about that; the UI
 * remounts, which is both simpler and harder to get subtly wrong.
 */
export async function setActiveProfile(id: string): Promise<void> {
  const rows = await query<{ id: string }>(
    'SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  if (!rows[0]) throw new Error('No such profile.');
  setActiveProfileId(id);
  await kvSet(ACTIVE_KEY, id);
}

export async function createProfile(name: string): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error('Give the profile a name.');
  return insert('profiles', {
    name: clean,
    colour: null,
    created_at: Date.now(),
    deleted_at: null,
  });
}

export async function renameProfile(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await update('profiles', id, { name: clean });
}

/**
 * Remove a profile.
 *
 * Their logs are left in place, soft-deleted with them rather than erased,
 * because a health record deleted by a mis-tap is not recoverable and the row
 * costs nothing. Refuses to remove the last one — an app with no profile has
 * nowhere to write.
 */
export async function deleteProfile(id: string): Promise<void> {
  const profiles = await listProfiles();
  if (profiles.length <= 1) throw new Error('There has to be one profile.');
  await softDelete('profiles', id);
  if (activeProfile() === id) {
    const next = profiles.find((p) => p.id !== id);
    if (next) await setActiveProfile(next.id);
  }
}

/** How much each person has logged — shown when picking who you are. */
export async function profileCounts(): Promise<
  Map<string, { meals: number; meds: number }>
> {
  const rows = await query<{ profile_id: string; meals: number; meds: number }>(
    `SELECT p.id AS profile_id,
            (SELECT COUNT(*) FROM meals m
              WHERE m.profile_id = p.id AND m.deleted_at IS NULL) AS meals,
            (SELECT COUNT(*) FROM medications d
              WHERE d.profile_id = p.id AND d.deleted_at IS NULL
                AND d.ended_on IS NULL) AS meds
       FROM profiles p WHERE p.deleted_at IS NULL`,
  );
  return new Map(
    rows.map((r) => [r.profile_id, { meals: Number(r.meals), meds: Number(r.meds) }]),
  );
}
