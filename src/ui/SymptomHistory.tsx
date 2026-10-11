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
import { recentSymptoms, reopenSymptom, resolveSymptom, type Symptom } from '../domain/symptoms';
import { Sheet } from './bits';

/** How far back the list goes. The report slider's own limit, so the two agree. */
const DAYS = 90;

export function SymptomHistory({ open, onClose, onLog, onChanged }: { open: boolean; onClose: () => void; onLog: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Symptom[] | null>(null);

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
  return (
    <Sheet open={open} onClose={onClose} label="Symptom history">
      <div className="am-sh-t">Symptom history</div>
      <p className="am-sh-s">The last {DAYS} days, newest first.</p>
      <div className="am-labs-all am-hist">
        {rows && rows.length === 0 && <p className="am-sh-n">Nothing logged yet.</p>}
        {counts.length > 0 && (
          <div className="am-labs am-hist-c">
            {counts.map((c) => (
              <span key={c.label}>
                {c.label} <b>{c.n}</b>
              </span>
            ))}
          </div>
        )}
        {rows?.map((s) => (
          <div key={s.id} className="am-hist-r" data-done={s.resolved_at ? '1' : undefined}>
            <div className="grow">
              <div className="am-hist-t">{entryTime(s.noted_at)}</div>
              <div className="am-hist-l">{s.label ?? 'No label'}</div>
              <div className="am-hist-w">{s.raw_text}</div>
            </div>
            <button className="link" onClick={() => void flip(s)}>
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
