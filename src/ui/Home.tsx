/**
 * Home: four doors.
 *
 * Two by two, because the three agents plus the workshop is the whole app and
 * a row of seven tabs made you read a menu before you could log a roti. The
 * line above the grid is the one number worth seeing without tapping.
 */

import { useEffect, useState } from 'react';
import { deck, focusDay, type Phrase } from '../domain/banner';
import { readDay, type DayView } from '../domain/day';
import { loadTargets, standing, type Targets } from '../domain/targets';
import { weightsSince, byDay } from '../domain/weight';
import { Banner } from './Banner';
import { Code, Cutlery, Pill, Scale, Stethoscope } from './bits';
import type { Screen } from '../App';

export function Home({ go }: { go: (s: Screen) => void }) {
  const [day, setDay] = useState<DayView | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [cards, setCards] = useState<Phrase[]>([]);
  /**
   * Ticks once a minute, only so the banner can notice midnight while the
   * screen is open. Cheap, and the alternative is a line about "today" that
   * is still there at two in the morning.
   */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    void (async () => {
      // Which day the banner talks about is decided before it is read: in the
      // small hours with nothing eaten yet, that is still yesterday.
      const todayView = await readDay();
      const t = await loadTargets();
      setDay(todayView);
      setTargets(t);

      const focus = focusDay(now, todayView.items.length);
      const view = focus.lookingBack ? await readDay(focus.dayStart) : todayView;
      const recent = byDay(await weightsSince(now - 30 * 86_400_000));

      setCards(
        deck({
          now,
          totals: view.totals,
          itemCount: view.items.length,
          targets: t,
          lookingBack: focus.lookingBack,
          weights: [...recent].reverse().map((p) => ({ kg: p.kg, measured_at: p.t })),
        }),
      );
    })();
  }, [now]);

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

      {/* Right-aligned above the grid: small on purpose. Weight is a thing
          you touch once a morning, not a place you live. */}
      <div className="wrow">
        <button className="wbtn" onClick={() => go('weight')} aria-label="Weight">
          <Scale />
        </button>
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

      <Banner cards={cards} />

      <div className="foot">
        Not a medical device. Informational only — it does not diagnose, and it
        never suggests a dose.
      </div>
    </>
  );
}
