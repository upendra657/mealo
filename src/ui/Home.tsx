/**
 * Home: four doors.
 *
 * Two by two, because the three agents plus the workshop is the whole app and
 * a row of seven tabs made you read a menu before you could log a roti. The
 * line above the grid is the one number worth seeing without tapping.
 */

import { useEffect, useState } from 'react';
import { readDay, type DayView } from '../domain/day';
import { loadTargets, standing, type Targets } from '../domain/targets';
import { Code, Cutlery, Pill, Stethoscope } from './bits';
import type { Screen } from '../App';

export function Home({ go }: { go: (s: Screen) => void }) {
  const [day, setDay] = useState<DayView | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);

  useEffect(() => {
    void (async () => {
      setDay(await readDay());
      setTargets(await loadTargets());
    })();
  }, []);

  const kcal = day?.totals[0] ?? 0;
  const goal = targets?.energy_kcal ?? null;
  const st = standing(kcal, goal, true);

  return (
    <>
      <div className="hero">
        <div className="kicker">Today so far</div>
        <p className="line">
          {!day ? (
            '…'
          ) : kcal <= 0 ? (
            'Nothing logged yet.'
          ) : goal ? (
            <>
              <b className="num">{Math.round(kcal)}</b> of{' '}
              <b className="num">{goal}</b> Cal ·{' '}
              <b className={`num is-${st.standing}`}>{st.pct}%</b>
            </>
          ) : (
            <>
              <b className="num">{Math.round(kcal)}</b> Cal · protein{' '}
              <b className="num">{Math.round(day.totals[1])}g</b> · no target set
            </>
          )}
        </p>
      </div>

      <div className="grid2">
        <button className="tile" onClick={() => go('doctor')}>
          <Stethoscope />
          <div>
            <div className="name">Doctor</div>
            <div className="note">Ask about your week</div>
          </div>
        </button>

        <button className="tile tile--primary" onClick={() => go('day')}>
          <Cutlery />
          <div>
            <div className="name">Track meals</div>
            <div className="note">Nutritionist</div>
          </div>
        </button>

        <button className="tile" onClick={() => go('meds')}>
          <Pill />
          <div>
            <div className="name">Track meds</div>
            <div className="note">Pharmacist</div>
          </div>
        </button>

        <button className="tile" onClick={() => go('dev')}>
          <Code />
          <div>
            <div className="name">Dev</div>
            <div className="note">Storage, keys, food table</div>
          </div>
        </button>
      </div>

      <div className="foot">
        Not a medical device. Informational only — it does not diagnose, and it
        never suggests a dose.
      </div>
    </>
  );
}
