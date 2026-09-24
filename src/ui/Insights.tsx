/**
 * Insights.
 *
 * The dashboard answers "how am I doing". This answers "because of what" —
 * the two questions anyone actually asks of a food log. Which meal did the
 * damage, and which single dish is driving a macro.
 *
 * The page also carries a wash of colour rising from the bottom, keyed to the
 * calorie reading, the same idea as the dial's sky. It sits on a fixed layer
 * behind everything, and every card paints an opaque background, so the tint
 * reaches the black ground and nothing else.
 */

import { useEffect, useState } from 'react';
import {
  contributors,
  energySplit,
  MACRO_LABELS,
  readDay,
  type DayView,
} from '../domain/day';
import { startOfToday } from '../domain/meals';
import { slot as slotOf } from '../domain/slots';
import {
  loadTargets,
  OVER_IS_BAD,
  standing,
  TARGET_FIELDS,
  type Standing,
  type Targets,
} from '../domain/targets';
import { Chevron } from './bits';
import type { Screen } from '../App';

/** rgb triples so the hue can be built at any alpha. */
const HUE: Record<string, string> = {
  low: '232,180,74',
  good: '79,209,169',
  over: '240,113,103',
};

const MACRO_COLOUR = [
  'var(--accent)',
  'var(--m-protein)',
  'var(--m-fat)',
  'var(--m-carbs)',
  'var(--m-fibre)',
];

export function Insights({
  go,
  dayStart,
}: {
  go: (s: Screen) => void;
  dayStart: number | null;
}) {
  const start = dayStart ?? startOfToday();
  const [view, setView] = useState<DayView | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    void (async () => {
      setView(await readDay(start));
      setTargets(await loadTargets());
    })();
  }, [start]);

  const totals = view?.totals ?? [0, 0, 0, 0, 0];
  const cal = standing(totals[0], targets?.energy_kcal ?? null, true);

  const words: Record<Standing, string> = {
    unset: 'No target set',
    empty: 'Nothing logged yet',
    low: 'Still in budget',
    good: 'On target',
    over: 'Over budget',
  };

  const rgb = HUE[cal.standing];
  const rows = view ? contributors(view, pick) : [];
  const max = rows.length ? rows[0].value : 1;

  return (
    <>
      <div
        className="wash"
        style={{
          opacity: rgb ? 1 : 0,
          background: rgb
            ? `radial-gradient(130% 78% at 50% 114%, rgba(${rgb},.36) 0%, rgba(${rgb},.17) 32%, rgba(${rgb},.06) 56%, transparent 80%)`
            : undefined,
        }}
      />

      <div className="top">
        <button className="back" onClick={() => go('day')}>
          <Chevron />
          Today
        </button>
        <div className="grow" />
        <span className="small muted num">
          {start === startOfToday()
            ? 'Today'
            : new Date(start).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
              })}
        </span>
      </div>

      <div className="ins-head">
        <div className={`ins-status is-${cal.standing}`}>{words[cal.standing]}</div>
        <div className="ins-cal">
          <span className="num">{Math.round(totals[0])}</span>
          <span className="ins-of">
            {targets?.energy_kcal
              ? `Cal of ${targets.energy_kcal} · ${cal.pct}%`
              : 'Cal'}
          </span>
        </div>
        <div className={`bar f-${cal.standing}`}>
          <i
            style={{
              width: targets?.energy_kcal
                ? `${Math.min(100, (totals[0] / targets.energy_kcal) * 100)}%`
                : 0,
            }}
          />
        </div>
      </div>

      <div className="field-lbl">Macros</div>
      <div className="card">
        {TARGET_FIELDS.slice(1).map((f, n) => {
          const value = totals[n + 1];
          const goal = targets?.[f.key] ?? null;
          const st = standing(value, goal, OVER_IS_BAD[f.key]);
          return (
            <div className="ins-macro" key={f.key}>
              <span className="nm">{f.label}</span>
              <span className={`fig num is-${st.standing}`}>
                {value}
                {goal ? ` / ${goal}` : ''} g{st.pct === null ? '' : ` · ${st.pct}%`}
              </span>
              <span className={`bar f-${st.standing}`}>
                <i style={{ width: goal ? `${Math.min(100, (value / goal) * 100)}%` : 0 }} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="field-lbl">By meal</div>
      {view && view.groups.length === 0 && (
        <p className="empty-note">Nothing logged for this day.</p>
      )}
      {view?.groups.map((g) => {
        const split = energySplit(g.macros);
        const share = totals[0] ? Math.round((g.macros[0] / totals[0]) * 100) : 0;
        const names = [...new Set(g.items.map((i) => i.label))].join(' · ');
        return (
          <div className="ins-meal" key={g.slot}>
            <div className="hd">
              <span className="nm">{slotOf(g.slot).label}</span>
              <span className="sh num">{share}% of day</span>
              <span className="kc num">{Math.round(g.macros[0])} Cal</span>
            </div>
            <div className="dishes">{names}</div>
            {split && (
              <div className="mx" title="How this meal's calories split">
                <i style={{ width: `${split[0] * 100}%`, background: MACRO_COLOUR[1] }} />
                <i style={{ width: `${split[1] * 100}%`, background: MACRO_COLOUR[2] }} />
                <i style={{ width: `${split[2] * 100}%`, background: MACRO_COLOUR[3] }} />
              </div>
            )}
            <div className="key">
              {[1, 2, 3, 4].map((i) => (
                <span key={i}>
                  <i className="dot" style={{ background: MACRO_COLOUR[i] }} />
                  {MACRO_LABELS[i]} <b className="num">{g.macros[i]}g</b>
                </span>
              ))}
            </div>
          </div>
        );
      })}

      <div className="field-lbl">Top contributors</div>
      <div className="chips">
        {MACRO_LABELS.map((label, i) => (
          <button
            key={label}
            className="chip"
            aria-pressed={i === pick}
            onClick={() => setPick(i)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        {rows.length === 0 ? (
          <p className="empty-note" style={{ padding: '4px 0' }}>
            Nothing contributing yet.
          </p>
        ) : (
          rows.map((r) => (
            <div className="top-row" key={r.label + r.foodId}>
              <span className="nm">{r.label}</span>
              <span className="amt num">
                {pick === 0 ? Math.round(r.value) : r.value} {pick === 0 ? 'Cal' : 'g'}
              </span>
              <span className="sub num">
                {r.share}% of today&rsquo;s {MACRO_LABELS[pick].toLowerCase()}
                {r.times > 1 ? ` · ${r.times}×` : ''}
                {r.grams ? ` · ${r.grams}g eaten` : ''}
              </span>
              <span className="bar">
                <i
                  style={{
                    width: `${(r.value / max) * 100}%`,
                    background: MACRO_COLOUR[pick],
                  }}
                />
              </span>
            </div>
          ))
        )}
      </div>

      <div className="foot">
        Shares are of what you have logged today, not of your target.
      </div>
    </>
  );
}
