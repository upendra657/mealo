/**
 * Symptom history: everything logged in the last ninety days, newest first.
 *
 * Logging a symptom was possible from the first chat screen; seeing them
 * again was not, beyond the few still open in the "what it can see" panel.
 * A record you cannot read back is one you stop keeping. This is the list,
 * with a count by label at the top, since the label is what the app counts
 * by and the count is the first thing worth knowing: "bloating, 4 times".
 *
 * It counts and it lists. It does not say what any of it means; that is in
 * nobody's gift here but a doctor's.
 */

import { useEffect, useState } from 'react';
import { entryTime } from '../domain/chat';
import { countByLabel } from '../domain/symptomlabels';
import { beganAt, recentSymptoms, reopenSymptom, resolveSymptom, type Symptom } from '../domain/symptoms';
import { Sheet } from './bits';
import { PatternView } from './PatternView';

/** How far back the list goes. The report slider's own limit, so the two agree. */
const DAYS = 90;

export function SymptomHistory({ open, onClose, onLog, onChanged }: { open: boolean; onClose: () => void; onLog: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Symptom[] | null>(null);
  /** The symptom whose patterns are open, if any. */
  const [looking, setLooking] = useState<string | null>(null);

  const load = async () => setRows(await recentSymptoms(DAYS));
  // Read each time the sheet opens: a symptom logged a moment ago from the
  // chat has to be at the top when the list is next looked at.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void recentSymptoms(DAYS).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const flip = async (s: Symptom) => {
    if (s.resolved_at) await reopenSymptom(s.id);
    else await resolveSymptom(s.id);
    await load();
    onChanged();
  };

  const counts = rows ? countByLabel(rows) : [];
  if (open && looking) {
    return (
      <Sheet open={open} onClose={onClose} label={`Before ${looking}`}>
        <PatternView label={looking} onBack={() => setLooking(null)} />
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} label="Symptom history">
      <div className="am-sh-t">Symptom history</div>
      <p className="am-sh-s">
        The last {DAYS} days, newest first.{counts.length > 0 ? ' Tap a symptom to see what came before it.' : ''}
      </p>
      <div className="am-labs-all am-hist">
        {rows && rows.length === 0 && <p className="am-sh-n">Nothing logged yet.</p>}
        {counts.length > 0 && (
          <div className="am-labs am-hist-c">
            {/* The way into the patterns (15 Oct 2026). */}
            {counts.map((c) => (
              <button key={c.label} className="pt-chip" onClick={() => setLooking(c.label)}>
                {c.label} <b>{c.n}</b> ›
              </button>
            ))}
          </div>
        )}
        {rows?.map((s) => (
          <div key={s.id} className="am-hist-r" data-done={s.resolved_at ? '1' : undefined}>
            <div className="grow">
              <div className="am-hist-t">
                {entryTime(beganAt(s))}
                {/* Said when it was written down much later than it began. */}
                {s.started_at !== null && s.noted_at - s.started_at > 30 * 60_000 && (
                  <span className="am-hist-logged"> · logged {entryTime(s.noted_at).replace(/^Today · /, '')}</span>
                )}
              </div>
              <div className="am-hist-l">{s.label ?? 'No label'}</div>
              <div className="am-hist-w">{s.raw_text}</div>
            </div>
            {/* Quiet on purpose, his call: people come to log a symptom, not
                to close one, and nothing depends on it being closed. */}
            <button className="link am-hist-done" onClick={() => void flip(s)}>
              {s.resolved_at ? 'Reopen' : 'Resolved'}
            </button>
          </div>
        ))}
      </div>
      <button
        className="am-btn am-btn--go am-sh-go"
        onClick={() => {
          onClose();
          onLog();
        }}
      >
        Log a symptom
      </button>
    </Sheet>
  );
}
