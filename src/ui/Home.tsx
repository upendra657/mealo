/**
 * Home: four doors.
 *
 * Two by two, because the three agents plus the workshop is the whole app and
 * a row of seven tabs made you read a menu before you could log a roti. The
 * line above the grid is the one number worth seeing without tapping.
 */

import { useEffect, useState } from 'react';
import { deck, focusDay, greeting, type Phrase } from '../domain/banner';
import { readDay, type DayView } from '../domain/day';
import { loadTargets, standing, type Targets } from '../domain/targets';
import { weightsSince, byDay } from '../domain/weight';
import { Banner } from './Banner';
import { Code, Cutlery, Flame, Pill, Scale, Stethoscope } from './bits';
import type { Screen } from '../App';

export function Home({
  go,
  avatar,
}: {
  go: (s: Screen) => void;
  avatar?: React.ReactNode;
}) {
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

  /**
   * What sits under "Track meals".
   *
   * Three states, because a tile has room for one line and each of them is a
   * different question: not loaded, nothing eaten, and a figure — against a
   * target when there is one, bare when there is not. It never shows a
   * percentage of a goal nobody set.
   */
  const mealsNote = !day
    ? '\u2026'
    : kcal <= 0
      ? 'Nothing logged yet'
      : goal
        ? `${Math.round(kcal).toLocaleString()} of ${goal.toLocaleString()} Cal \u00b7 ${st.pct}%`
        : `${Math.round(kcal).toLocaleString()} Cal today`;

  return (
    <>
      {/* One header, not two: the greeting is the title. The day's calories
          moved down onto the tile they belong to — a number about meals reads
          better under "Track meals" than floating above everything. */}
      <div className="top">
        <div>
          <div className="hello">{greeting(now)}</div>
          <div className="kicker">
            {new Date(now).toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </div>
        </div>
        <div className="grow" />
        {avatar}
      </div>

      {/* Right-aligned above the grid: small on purpose. Neither of these is a
          place you live — they are things you touch once a day and leave.

          Burn first, then weight. Both get logged in the same sitting and burn
          is the one with something to add most days, so it takes the position
          the thumb reaches first. */}
      <div className="wrow">
        <button className="wbtn wbtn--burn" onClick={() => go('burn')} aria-label="Burnt calories">
          <Flame />
        </button>
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
            <div className="note">{mealsNote}</div>
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
