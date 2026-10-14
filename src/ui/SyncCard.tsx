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
import { ago, RELAY_KEEP_DAYS, syncTone } from '../domain/upkeep';
import { Chevron, useToast } from './bits';

type Phase = 'loading' | 'alone' | 'paired';

export function SyncCard() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [joining, setJoining] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [now] = useState(() => Date.now());
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

  const tone = syncTone(last, now);

  // "Household", his word for the card on 15 Oct 2026: the two of them, and
  // the kitchen and medicine cupboard they share. The last sync is always
  // shown, amber after a week, and with what to do once the relay is close
  // to forgetting (domain/upkeep.ts), because a phone left out for 30 days
  // misses what was pruned and nothing else would say so.
  return (
    <section className="card">
      {phase === 'alone' ? (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            One of you creates the household and shows the code; the other enters it. From then on a dish or a medicine either of you adds
            shows up for both. Only the libraries travel: meals, doses taken, sicknesses and weights stay on the phone they were logged on,
            and a medicine marked Keep private never leaves its phone.
          </p>
          <button className="bk-btn bk-btn--go" onClick={() => void start()} disabled={busy}>
            Create a household
          </button>
          <label className="dv-f" style={{ marginTop: 16 }}>
            <span>Or enter the code from the other phone</span>
            <input
              value={joining}
              onChange={(e) => setJoining(e.target.value)}
              placeholder="XXXXX-XXXXX-…"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button className="bk-btn" onClick={() => void join()} disabled={busy || joining.trim().length < 20}>
            Join
          </button>
        </>
      ) : (
        <>
          <div className="dv-kv">
            <span className="k">Food and medicine library</span>
            <span className="v" data-tone={tone === 'ok' ? 'ok' : 'warn'}>
              {last ? `synced ${ago(last, now)}` : 'not synced yet'}
            </span>
          </div>
          {(tone === 'amber' || tone === 'urgent') && (
            <div className="dv-state" data-tone="warn" style={{ marginTop: 4 }}>
              {tone === 'urgent'
                ? `The relay keeps changes for ${RELAY_KEEP_DAYS} days. Open Mealo on both phones and sync before then, or older changes will not reach this one.`
                : 'Open Mealo on the other phone too, so each picks up what the other added.'}
            </div>
          )}
          <button className="bk-btn" onClick={() => void run()} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
          {said && (
            <p className="small" style={{ margin: '8px 0 0' }}>
              {said}
            </p>
          )}

          <button className="dv-go" aria-expanded={pairing} onClick={() => setPairing((v) => !v)}>
            <span className="grow">
              Pairing
              <span className="amt">
                Paired · <span className="num">{id?.slice(0, 6)}…</span> · show the code, or unpair
              </span>
            </span>
            <Chevron dir={pairing ? 'down' : 'right'} />
          </button>
          {pairing && (
            <div className="dv-in">
              <div className="syncrow">
                <button className="link" onClick={() => void toggleCode()} disabled={busy}>
                  {code ? 'Hide code' : 'Show pairing code'}
                </button>
              </div>
              {code && (
                <>
                  {/* Said plainly, because it is true: this string is the key. */}
                  <p className="small keywarn">
                    This code is the key to your library. Anyone who has it can read every dish and medicine in it. Hand it to the other
                    phone and nowhere else.
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
                Unpairing stops the exchange. It deletes nothing: every dish and medicine you already have stays where it is.
              </p>
            </div>
          )}
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
