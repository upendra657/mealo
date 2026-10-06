/**
 * One round of sync.
 *
 * Collect what changed, seal it, push it, pull what the other phone sent,
 * open it, apply it. Everything interesting is in the two halves this calls —
 * the merge rules in sync.ts and the write path in librarysync.ts — so this
 * file is mostly about failing safely.
 *
 * Which means, in practice, three rules:
 *
 * **A cursor only advances after the work it describes has succeeded.** The
 * push cursor moves after the relay has the batch, never before; the pull
 * cursor moves after the rows are applied, never on receipt. A cursor that
 * runs ahead of reality silently skips a dish and there is no way to notice,
 * because the dish simply is not there.
 *
 * **A batch that will not decrypt is skipped, not fatal.** The household id
 * gates writes and anyone could guess one, so a batch sealed with a different
 * key is a thing that can legitimately arrive. AES-GCM authenticates, so it
 * fails closed and loudly at the decrypt, and the right response is to ignore
 * that batch and carry on with the rest.
 *
 * **Syncing never blocks logging.** Every entry point returns a result rather
 * than throwing, and nothing here holds a transaction open. Recording a meal
 * on a train with no signal is the thing this app exists to do; a failed sync
 * is a line in Settings, not an error in your face.
 */

import { loadHousehold, open as openSealed, seal } from '../lib/household';
import { getDeviceId } from '../lib/device';
import {
  apply,
  batchOf,
  collect,
  markSynced,
  pullCursor,
  pushCursor,
  setPullCursor,
  setPushCursor,
  type Applied,
} from './librarysync';
import { applyMeds, collectMeds, medPushCursor, setMedPushCursor } from './medsync';
import { isMedTable, READS, type Batch, type WireRow } from './sync';
import { kvGet, kvSet } from '../lib/kv';

export type Received = Applied & { medicines: number };

export type SyncResult = {
  ok: boolean;
  /** Rows this device sent. */
  sent: number;
  /** What arrived and stuck. */
  applied: Received;
  /** Batches that could not be opened — almost certainly not ours. */
  undecryptable: number;
  /** Set when the round failed. Safe to show. */
  error?: string;
};

const EMPTY: Received = { dishes: 0, portions: 0, aliases: 0, medicines: 0, skipped: 0 };

/**
 * Set once this phone has read the relay from the start under wire version 2.
 *
 * Until it updated, this phone dropped every version-2 batch it pulled —
 * correctly, it could not read them — and still moved its pull cursor past
 * them. Those batches hold the other phone's medicines. Re-reading once from
 * zero picks up whatever the relay still has (it keeps 30 days); re-applying
 * food rows already here is a tie and changes nothing.
 */
const REREAD_KV = 'sync.rereadForV2';

/** Base64 for the wire. The relay stores text, not bytes. */
function toB64(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Push, then pull, then apply.
 *
 * Push first on purpose: if the round dies halfway, the other phone has
 * already gained what this one knew. The reverse ordering would leave this
 * device holding the only copy of a dish for another day.
 */
export async function syncLibrary(): Promise<SyncResult> {
  const household = await loadHousehold();
  if (!household) {
    return { ok: false, sent: 0, applied: EMPTY, undecryptable: 0, error: 'Not paired yet.' };
  }
  const device = await getDeviceId();

  let sent = 0;
  let undecryptable = 0;
  let applied: Received = { ...EMPTY };

  try {
    // ---- push ----
    const foodRows: WireRow[] = await collect(await pushCursor());
    const medRows: WireRow[] = await collectMeds(await medPushCursor());
    const rows = [...foodRows, ...medRows];
    if (rows.length > 0) {
      const body = toB64(await seal(household.key, JSON.stringify(batchOf(rows))));
      const res = await fetch('/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ household: household.id, device, body }),
      });
      if (!res.ok) throw new Error(`relay refused the batch (${res.status})`);
      // Only now: the relay has it.
      await setPushCursor(foodRows);
      await setMedPushCursor(medRows);
      sent = rows.length;
    }

    // ---- pull ----
    const rereading = !(await kvGet<boolean>(REREAD_KV));
    if (rereading) await setPullCursor(0);
    // Loop, because a busy household can hold more than one page.
    for (let page = 0; page < 20; page++) {
      const since = await pullCursor();
      const url = `/sync/pull?household=${encodeURIComponent(household.id)}&device=${encodeURIComponent(device)}&since=${since}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`relay would not hand anything over (${res.status})`);
      const page_ = (await res.json()) as {
        batches: { seq: number; body: string }[];
        cursor: number;
        more: boolean;
      };

      const incoming: WireRow[] = [];
      for (const b of page_.batches) {
        let text: string;
        try {
          text = await openSealed(household.key, fromB64(b.body));
        } catch {
          // Not sealed with our key. Someone else's, or noise.
          undecryptable++;
          continue;
        }
        try {
          const parsed = JSON.parse(text) as Batch;
          if (!READS.includes(parsed.v) || !Array.isArray(parsed.rows)) continue;
          incoming.push(...parsed.rows);
        } catch {
          undecryptable++;
        }
      }

      if (incoming.length > 0) {
        const got = await apply(incoming.filter((r) => !isMedTable(r.t)));
        const meds = await applyMeds(incoming.filter((r) => isMedTable(r.t)));
        applied = {
          dishes: applied.dishes + got.dishes,
          portions: applied.portions + got.portions,
          aliases: applied.aliases + got.aliases,
          medicines: applied.medicines + meds.medicines,
          skipped: applied.skipped + got.skipped + meds.skipped,
        };
      }

      // Only now: the rows are in.
      await setPullCursor(page_.cursor);
      if (!page_.more) break;
    }

    // Only after every page is in, so a round that dies halfway re-reads again.
    if (rereading) await kvSet(REREAD_KV, true);
    await markSynced();
    return { ok: true, sent, applied, undecryptable };
  } catch (e) {
    return {
      ok: false,
      sent,
      applied,
      undecryptable,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** One line for Settings. */
export function describe(r: SyncResult): string {
  if (!r.ok) return r.error ?? 'Sync failed.';
  const a = r.applied;
  const got = a.dishes + a.portions + a.aliases + a.medicines;
  if (r.sent === 0 && got === 0) return 'Already up to date.';
  const bits: string[] = [];
  if (r.sent > 0) bits.push(`sent ${r.sent}`);
  if (got > 0) bits.push(`received ${got}`);
  return bits.join(', ') + '.';
}
