/**
 * The front door.
 *
 * Principle P6 says logging friction is the product: if recording a dose takes
 * more than ten seconds, nothing else about this app matters. So this screen
 * opens straight onto today's list with the two buttons that matter, and asks
 * nothing else of you.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  intakeToday,
  listActive,
  logIntake,
  loggingStreak,
  undoIntake,
  type IntakeEvent,
  type Medication,
} from '../domain/medications';

function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function Today({ onAdd }: { onAdd: () => void }) {
  const [meds, setMeds] = useState<Medication[] | null>(null);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [streak, setStreak] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, e, s] = await Promise.all([
        listActive(),
        intakeToday(),
        loggingStreak(),
      ]);
      setMeds(m);
      setEvents(e);
      setStreak(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const log = async (medId: string, status: 'taken' | 'skipped') => {
    setBusy(medId);
    try {
      await logIntake(medId, status);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (eventId: string) => {
    await undoIntake(eventId);
    await refresh();
  };

  if (error) {
    return (
      <div className="result result--fail">
        <strong>Could not load today</strong>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!meds) return <p className="muted">Loading…</p>;

  if (meds.length === 0) {
    return (
      <section className="card empty">
        <h2>Nothing to log yet</h2>
        <p className="muted">
          Add what you're actually taking — supplements count. The point of the
          next seven days is finding out whether logging fits into your day at
          all.
        </p>
        <button className="primary" onClick={onAdd}>
          Add the first one
        </button>
      </section>
    );
  }

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="stack">
      <div className="today-head">
        <div>
          <h2>{today}</h2>
          <p className="muted small">
            {events.length === 0
              ? 'Nothing logged yet today'
              : `${events.length} logged today`}
          </p>
        </div>
        {streak > 0 && (
          <div className="streak" title="Consecutive days with at least one entry">
            <b>{streak}</b>
            <span>day{streak === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>

      <ul className="dose-list">
        {meds.map((m) => {
          const mine = events.filter((e) => e.medication_id === m.id);
          const taken = mine.filter((e) => e.status === 'taken').length;
          const skipped = mine.filter((e) => e.status === 'skipped').length;
          return (
            <li key={m.id} className={`dose ${mine.length ? 'dose--done' : ''}`}>
              <div className="dose-main">
                <div className="dose-name">
                  {m.name}
                  {m.dose_text && <span className="dose-amt">{m.dose_text}</span>}
                </div>
                {m.schedule && <p className="muted small">{m.schedule}</p>}
                {mine.length > 0 && (
                  <p className="small logged">
                    {taken > 0 && `${taken} taken`}
                    {taken > 0 && skipped > 0 && ' · '}
                    {skipped > 0 && `${skipped} skipped`}
                    {' · '}
                    {mine.map((e, i) => (
                      <span key={e.id}>
                        {i > 0 && ', '}
                        {timeOfDay(e.taken_at)}
                        <button
                          className="link undo"
                          onClick={() => void undo(e.id)}
                          title="Undo this entry"
                        >
                          undo
                        </button>
                      </span>
                    ))}
                  </p>
                )}
              </div>
              <div className="dose-actions">
                <button
                  className="tap tap--take"
                  disabled={busy === m.id}
                  onClick={() => void log(m.id, 'taken')}
                >
                  Taken
                </button>
                <button
                  className="tap tap--skip"
                  disabled={busy === m.id}
                  onClick={() => void log(m.id, 'skipped')}
                >
                  Skipped
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="small muted">
        Tap more than once if you take something several times a day — every tap
        is its own entry, and undo is there if you mis-tap.
      </p>
    </div>
  );
}
