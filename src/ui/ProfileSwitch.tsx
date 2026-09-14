/**
 * Who is logging.
 *
 * Sits in the header because switching has to be one tap — two people sharing
 * a tablet at the same table will switch several times a meal, and anything
 * buried in settings guarantees that someone's dinner ends up on the other
 * person's day.
 *
 * Switching remounts the whole app (App.tsx keys on the active id) rather than
 * trying to refresh each screen in place. Simpler, and it makes the class of
 * bug where one stale panel still shows the previous person's data impossible
 * rather than unlikely.
 */

import { useState } from 'react';
import {
  createProfile,
  deleteProfile,
  renameProfile,
  setActiveProfile,
  type Profile,
} from '../profiles/store';

export function ProfileSwitch({
  profiles,
  active,
  onChanged,
}: {
  profiles: Profile[];
  active: string;
  onChanged: () => void | Promise<void>;
}) {
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const switchTo = async (id: string) => {
    if (id === active) return;
    await setActiveProfile(id);
    await onChanged();
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setProblem(null);
    try {
      const id = await createProfile(name);
      await setActiveProfile(id);
      setNewName('');
      setManaging(false);
      await onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="profiles">
      <div className="profile-pills">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={p.id === active ? 'pill pill--on' : 'pill'}
            onClick={() => void switchTo(p.id)}
            title={p.id === active ? 'Logging as this person' : `Switch to ${p.name}`}
          >
            {p.name}
          </button>
        ))}
        <button
          className="pill pill--ghost"
          onClick={() => setManaging((v) => !v)}
          title="Add or edit people"
        >
          {managing ? '×' : '+'}
        </button>
      </div>

      {managing && (
        <div className="profile-manage">
          <p className="small muted">
            Separate logs, shared food table. Meals, medications and symptoms are
            each person's own; dishes and portions are shared.
          </p>

          <div className="row">
            <input
              aria-label="New profile name"
              value={newName}
              placeholder="name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <button className="primary" onClick={() => void add()} disabled={!newName.trim()}>
              Add person
            </button>
          </div>

          <ul className="med-list">
            {profiles.map((p) => (
              <li key={p.id} className="med">
                <input
                  aria-label={`Name for ${p.name}`}
                  defaultValue={p.name}
                  onBlur={async (e) => {
                    if (e.target.value.trim() && e.target.value !== p.name) {
                      await renameProfile(p.id, e.target.value);
                      await onChanged();
                    }
                  }}
                />
                <button
                  disabled={profiles.length <= 1}
                  onClick={async () => {
                    setProblem(null);
                    try {
                      await deleteProfile(p.id);
                      await onChanged();
                    } catch (err) {
                      setProblem(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <p className="small muted">
            Removing someone hides their profile but keeps their logs in the
            database — a health record lost to a mis-tap is not recoverable.
          </p>
          {problem && <p className="small bad">{problem}</p>}
        </div>
      )}
    </div>
  );
}
