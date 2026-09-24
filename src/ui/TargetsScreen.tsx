/**
 * Daily targets, per person.
 *
 * Empty is a real state here, not a zero. A field nobody filled in leaves its
 * bar grey everywhere else in the app, because a percentage against a goal
 * you never set is a number the app invented.
 */

import { useEffect, useState } from 'react';
import {
  loadTargets,
  saveTargets,
  TARGET_FIELDS,
  type Targets,
} from '../domain/targets';
import { activeProfile, listProfiles, type Profile } from '../profiles/store';
import { Chevron, useToast } from './bits';
import type { Screen } from '../App';

export function TargetsScreen({
  go,
  avatar,
}: {
  go: (s: Screen) => void;
  avatar: React.ReactNode;
}) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [who, setWho] = useState<Profile | null>(null);
  const toast = useToast();

  useEffect(() => {
    void (async () => {
      setTargets(await loadTargets());
      const list = await listProfiles();
      setWho(list.find((p) => p.id === activeProfile()) ?? null);
    })();
  }, []);

  const set = async (key: keyof Targets, raw: string) => {
    const value = raw.trim() === '' ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return;
    setTargets((t) => (t ? { ...t, [key]: value } : t));
    await saveTargets({ [key]: value });
  };

  return (
    <>
      <div className="top">
        <button className="back" onClick={() => go('day')}>
          <Chevron />
          Today
        </button>
        <div className="grow" />
        {avatar}
      </div>

      <h2 className="dish-name">
        {who ? `${who.name}'s daily targets` : 'Daily targets'}
      </h2>
      <div className="dish-sub">
        Each person has their own. Leave a field empty and its bar stays grey
        rather than measuring you against a number the app invented.
      </div>

      <div className="card" style={{ marginTop: 18, padding: '4px 16px' }}>
        {TARGET_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`t-${f.key}`}>
              {f.label}
              <span className="u">{f.unit}</span>
            </label>
            <input
              id={`t-${f.key}`}
              type="number"
              inputMode="numeric"
              placeholder="—"
              value={targets?.[f.key] ?? ''}
              onChange={(e) => void set(f.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <p className="note">
        Going over turns the bar red for calories, carbs and fat. Protein and
        fibre stay green — 61g of fibre is not a failure.
      </p>

      <button
        className="cta"
        onClick={() => {
          toast('Targets saved');
          go('day');
        }}
      >
        Done
      </button>

      <div className="foot">
        Nothing here is computed from your height or weight. Picking a calorie
        goal for you would be a health recommendation, and this app does not
        make those.
      </div>
    </>
  );
}
