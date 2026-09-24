/**
 * One circle, top right.
 *
 * Profiles and settings behind a single control rather than sitting in the
 * header taking space from the thing you opened the app to do. Switching
 * remounts the screens (App keys on the active profile), so a stale panel
 * showing the other person's day is impossible rather than unlikely.
 */

import { useEffect, useRef, useState } from 'react';
import {
  createProfile,
  deleteProfile,
  renameProfile,
  setActiveProfile,
  type Profile,
} from '../profiles/store';
import { Gear, Target, Tick } from './bits';

export function initial(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase();
}

export function AvatarMenu({
  profiles,
  active,
  onChanged,
  onSettings,
  onTargets,
}: {
  profiles: Profile[];
  active: string;
  onChanged: () => void | Promise<void>;
  onSettings: () => void;
  onTargets: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const me = profiles.find((p) => p.id === active);

  const pick = async (id: string) => {
    setOpen(false);
    if (id === active) return;
    await setActiveProfile(id);
    await onChanged();
  };

  const add = async () => {
    const clean = name.trim();
    if (!clean) return;
    setProblem(null);
    try {
      const id = await createProfile(clean);
      await setActiveProfile(id);
      setName('');
      setManaging(false);
      setOpen(false);
      await onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className="avatar"
        aria-expanded={open}
        aria-haspopup="true"
        title={me ? `Logging as ${me.name}` : 'Profile'}
        onClick={() => setOpen((v) => !v)}
      >
        {initial(me?.name ?? '?')}
      </button>

      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="menu" role="menu">
            <div className="grp">Profile</div>
            {profiles.map((p) => (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={p.id === active}
                onClick={() => void pick(p.id)}
              >
                <span className="pfp">{initial(p.name)}</span>
                {p.name}
                <span className="tick">
                  <Tick />
                </span>
              </button>
            ))}

            <button onClick={() => setManaging((v) => !v)}>
              <span className="pfp">+</span>
              {managing ? 'Never mind' : 'Add or edit people'}
            </button>

            {managing && (
              <div className="menu-manage">
                <input
                  aria-label="New profile name"
                  placeholder="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void add()}
                />
                <button className="cta" disabled={!name.trim()} onClick={() => void add()}>
                  Add
                </button>

                {profiles.map((p) => (
                  <div className="menu-person" key={p.id}>
                    <input
                      aria-label={`Name for ${p.name}`}
                      defaultValue={p.name}
                      onBlur={async (e) => {
                        const v = e.target.value.trim();
                        if (v && v !== p.name) {
                          await renameProfile(p.id, v);
                          await onChanged();
                        }
                      }}
                    />
                    <button
                      className="bin"
                      title={`Remove ${p.name}`}
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
                      ×
                    </button>
                  </div>
                ))}
                <p className="small muted" style={{ margin: '6px 2px 2px' }}>
                  Removing someone hides them but keeps their logs. Meals,
                  medications and symptoms are each person&rsquo;s own; the food
                  table is shared.
                </p>
                {problem && <p className="small bad-text">{problem}</p>}
              </div>
            )}

            <div className="rule" />
            <div className="grp">Settings</div>
            <button
              onClick={() => {
                setOpen(false);
                onTargets();
              }}
            >
              <Target />
              Daily targets
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <Gear />
              App settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}
