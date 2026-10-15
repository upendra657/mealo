/**
 * Dev → Lists → Sample dishes: add the list with one tap, or remove it.
 *
 * Drawn under its own row in the Lists card, as the medicine lists are. The
 * words say what the tap does before it is tapped (fetches about 30 KB from
 * Mealo's own address, keeps it on this phone only), because it is the one
 * button in the app that reaches the network for data the person did not
 * type (domain/samplelist.ts).
 */

import { useEffect, useState } from 'react';
import { addSampleList, finishRemovals, removeSampleList, sampleListState, type SampleState } from '../domain/samplelist';
import { useToast } from './bits';

export function SampleListCard() {
  /** undefined until read, so "not added" never flashes up on a phone that has it. */
  const [state, setState] = useState<SampleState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void finishRemovals()
      .then(sampleListState)
      .then(setState)
      .catch(() => setState(null));
  }, []);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await addSampleList();
      setState(s);
      toast(`${s.count} sample dishes added`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeSampleList();
      setState(null);
      toast('Sample dishes removed');
    } finally {
      setBusy(false);
    }
  };

  if (state === undefined) return <div className="mlists dv-in" />;

  return (
    <div className="mlists dv-in">
      <p className="small muted" style={{ marginTop: 0 }}>
        For a phone that starts with an empty food table. Added only when you tap, from Mealo&rsquo;s own server, about 30 KB.
        The list stays on this phone and is never synced. Search shows its dishes beside yours; one goes into My food table only
        if you keep it.
      </p>

      {state ? (
        <>
          <div className="mlist-row">
            <span className="grow">
              <span className="nm">{state.name}</span>
              <span className="amt">
                {state.count} dishes{state.addedAt ? ` · added ${new Date(state.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </span>
              {state.credits && <span className="amt">{state.credits}</span>}
            </span>
            <button className="bin" aria-label={`Remove ${state.name}`} disabled={busy} onClick={() => void remove()}>
              ×
            </button>
          </div>
          <p className="small muted" style={{ margin: '10px 2px 0' }}>
            Remove takes the list off this phone. Meals already logged from it keep their numbers, and dishes you kept stay in My
            food table.
          </p>
        </>
      ) : (
        <>
          <div className="mlist-row">
            <span className="grow">
              <span className="nm">
                <span className="num">137</span> from UK CoFID 2021
              </span>
              <span className="amt">North Indian and everyday dishes, per 100 g as eaten</span>
              <span className="amt">McCance and Widdowson&rsquo;s · Open Government Licence v3.0</span>
            </span>
          </div>
          <div className="mlist-row">
            <span className="grow">
              <span className="nm">
                <span className="num">32</span> from the Indian Nutrient Databank
              </span>
              <span className="amt">South Indian dishes, by the piece or bowl only</span>
              <span className="amt">INDB 2024 · Vijayakumar et al., Curr Dev Nutr</span>
            </span>
          </div>
          <button className="cta" style={{ marginTop: 12 }} disabled={busy} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add 169 sample dishes'}
          </button>
          <p className="small muted" style={{ margin: '10px 2px 0' }}>
            Needs a connection for this one tap. Nothing on this phone changes until all 169 are in.
          </p>
        </>
      )}

      {error && (
        <div className="result result--fail" style={{ marginTop: 12 }}>
          <strong>{error}</strong>
        </div>
      )}
    </div>
  );
}
