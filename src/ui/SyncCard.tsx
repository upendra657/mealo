/**
 * Pairing, and the button that runs a sync.
 *
 * One household, two phones, one food library. The first phone creates the
 * household and shows a code; the second takes the code. That is the whole
 * ceremony, and it happens once.
 *
 * The code is the key. Not a link, not an invite that expires — whoever holds
 * it can read everything in the library from then on, because the relay
 * cannot and somebody has to be able to. So it is hidden behind a tap rather
 * than sitting on screen, and the copy says what it is instead of calling it
 * a code and hoping.
 *
 * Nothing here decides anything about merging. It calls syncLibrary() and
 * reports what came back.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createHousehold,
  joinHousehold,
  leaveHousehold,
  loadHousehold,
  pairingCodeFor,
} from '../lib/household';
import { lastSyncAt } from '../domain/librarysync';
import { describe, syncLibrary } from '../domain/relay';
import { useToast } from './bits';

type Phase = 'loading' | 'alone' | 'paired';

export function SyncCard() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [joining, setJoining] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    const h = await loadHousehold();
    setId(h?.id ?? null);
    setPhase(h ? 'paired' : 'alone');
    setLast(await lastSyncAt());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    try {
      const { household, code: c } = await createHousehold();
      setId(household.id);
      setCode(c);
      setPhase('paired');
      toast('Household created. Show the code to the other phone.');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    try {
      await joinHousehold(joining);
      setJoining('');
      await refresh();
      toast('Paired. Syncing now.');
      await run();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That code was not readable.');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await syncLibrary();
      setSaid(describe(r));
      setLast(await lastSyncAt());
    } finally {
      setBusy(false);
    }
  };

  const toggleCode = async () => {
    setCode(code ? null : await pairingCodeFor());
  };

  const unpair = async () => {
    await leaveHousehold();
    setCode(null);
    setSaid(null);
    await refresh();
    toast('Unpaired. Nothing was deleted.');
  };

  if (phase === 'loading') return null;

  return (
    <section className="card">
      <h2>Shared library</h2>

      {phase === 'alone' ? (
        <>
          <p className="small muted">
            One of you creates the household and shows the code; the other
            enters it. From then on a dish or a medicine either of you adds
            shows up for both. Only the libraries travel — meals, doses taken,
            sicknesses and weights stay on the phone they were logged on, and
            a medicine marked Keep private never leaves its phone.
          </p>

          <button className="primary" onClick={() => void start()} disabled={busy}>
            Create a household
          </button>

          <label className="field">
            <span>or enter the code from the other phone</span>
            <input
              value={joining}
              onChange={(e) => setJoining(e.target.value)}
              placeholder="XXXXX-XXXXX-…"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button
            className="primary"
            onClick={() => void join()}
            disabled={busy || joining.trim().length < 20}
          >
            Join
          </button>
        </>
      ) : (
        <>
          <p className="small muted">
            Paired. <span className="num">{id?.slice(0, 6)}…</span> ·{' '}
            {last ? `last synced ${when(last)}` : 'not synced yet'}
          </p>

          <div className="syncrow">
            <button className="primary" onClick={() => void run()} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="link" onClick={() => void toggleCode()} disabled={busy}>
              {code ? 'Hide code' : 'Show pairing code'}
            </button>
          </div>

          {said && <p className="small">{said}</p>}

          {code && (
            <>
              {/* Said plainly, because it is true: this string is the key. */}
              <p className="small keywarn">
                This code is the key to your library. Anyone who has it can read
                every dish and medicine in it. Hand it to the other phone and
                nowhere else.
              </p>
              <p className="paircode" onClick={() => void copy(code, toast)}>
                {code}
              </p>
              <div className="syncrow">
                <button className="link" onClick={() => void copy(code, toast)}>
                  Copy
                </button>
              </div>
            </>
          )}

          <div className="syncrow">
            <button className="link" onClick={() => void unpair()} disabled={busy}>
              Unpair this phone
            </button>
          </div>
          <p className="small muted">
            Unpairing stops the exchange. It deletes nothing — every dish and
            medicine you already have stays where it is.
          </p>
        </>
      )}
    </section>
  );
}

async function copy(code: string, toast: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copied.');
  } catch {
    toast('Copy failed — select it by hand.');
  }
}

function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ms).toLocaleDateString();
}
