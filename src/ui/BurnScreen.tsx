/**
 * Burnt calories: yesterday, today, and the days behind them.
 *
 * The weight screen's layout with four deliberate differences, each of which
 * follows from burn being a daily amount rather than a running level.
 *
 *   bars, not a line   A line between two daily totals claims a value for the
 *                      hours in between. 610 on Monday and 420 on Tuesday did
 *                      not pass through 515; there is no such reading. Bars
 *                      say what a day was and nothing about the gap.
 *   up is good         Weight's delta is green downward. Here it is green
 *                      upward, and short of target is the yellow.
 *   today has a meter  A goal weight is months out. A burn target resets at
 *                      midnight, so "84% of 500" is a real reading here and
 *                      would be meaningless on the other screen.
 *   entry adds         Two sessions in a day are two parts of one number, so
 *                      the sheet adds. Correcting a mistyped total is the
 *                      other path, one tap away, and says which it is doing.
 *
 * Everything drawn comes from rows that exist. A day nobody logged leaves a
 * gap in the row of bars rather than a bar of height zero, because zero is a
 * claim that you moved nothing and an absence is the truth.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  BURN_RANGES,
  average,
  burnOn,
  burnsSince,
  byDay,
  ceiling,
  dayStartOf,
  goalBurn,
  recordBurn,
  setBurnTotal,
  setGoalBurn,
  slotsFor,
  streak,
  thin,
  type BurnPoint,
  type BurnRangeId,
} from '../domain/burn';
import { Chevron } from './bits';
import { WeightDial, WeightNumber } from './WeightDial';

const cal = (n: number) => Math.round(n).toLocaleString();
const signed = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${cal(Math.abs(n))}`;
const shortDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Which sheet, and for the entry sheet, whether it adds or overwrites. */
type Sheet = null | { kind: 'goal' } | { kind: 'entry'; replace: boolean };

export function BurnScreen({ onBack }: { onBack: () => void }) {
  const [points, setPoints] = useState<BurnPoint[]>([]);
  const [today, setToday] = useState<number | null>(null);
  const [yesterday, setYesterday] = useState<number | null>(null);
  const [beforeThat, setBeforeThat] = useState<number | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [range, setRange] = useState<BurnRangeId>('1M');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState(300);
  /**
   * Captured once, on mount.
   *
   * The chart's right edge is today, so the bar positions depend on it. Reading
   * the clock during render instead would move every bar by one slot the first
   * time the screen re-rendered after midnight, without any data having
   * changed. Same reason Home holds its own `now`.
   */
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    const days = BURN_RANGES.find((r) => r.id === range)!.days;
    const rows = await burnsSince(Date.now() - days * 86_400_000);
    setPoints(byDay(rows));

    const t0 = dayStartOf(Date.now());
    setToday((await burnOn(t0))?.kcal ?? null);
    setYesterday((await burnOn(t0 - 86_400_000))?.kcal ?? null);
    setBeforeThat((await burnOn(t0 - 2 * 86_400_000))?.kcal ?? null);
    setGoal(await goalBurn());
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const openGoal = () => {
    setDraft(goal ?? 500);
    setSheet({ kind: 'goal' });
  };

  /**
   * The entry sheet opens on a session, not on the day's total.
   *
   * Adding is the default, so the number in front of you is what you are about
   * to add — starting it at today's 320 would mean the first thing you do is
   * drag it back down to what you actually burnt. Correcting opens on the
   * total, because that is the number being replaced.
   */
  const openEntry = (replace: boolean) => {
    setDraft(replace ? (today ?? goal ?? 500) : (goal ?? 300));
    setSheet({ kind: 'entry', replace });
  };

  const save = async () => {
    if (!sheet) return;
    if (sheet.kind === 'goal') await setGoalBurn(draft);
    else if (sheet.replace) await setBurnTotal(draft);
    else await recordBurn(draft);
    setSheet(null);
    await load();
  };

  const yDelta =
    yesterday !== null && beforeThat !== null ? yesterday - beforeThat : null;
  const tDelta = today !== null && yesterday !== null ? today - yesterday : null;
  const pct =
    today !== null && goal !== null && goal > 0
      ? Math.min(100, Math.round((today / goal) * 100))
      : null;

  return (
    <>
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron size={15} />
          Home
        </button>
      </div>

      <div className="wgrid">
        <div className="wcard wcard--burn">
          <div className="k">Yesterday</div>
          {yesterday === null ? (
            <div className="v none">Not recorded</div>
          ) : (
            <div className="v">
              {cal(yesterday)}
              <small>Cal</small>
            </div>
          )}
          {yDelta !== null && (
            <div className={`d ${yDelta > 0 ? 'up' : yDelta < 0 ? 'down' : ''}`}>
              {signed(yDelta)} on the day before
            </div>
          )}
        </div>

        <div className="wcard wcard--burn">
          <div className="k">Today</div>
          {today === null ? (
            <div className="v none">Nothing yet</div>
          ) : (
            <div className="v">
              {cal(today)}
              <small>Cal</small>
            </div>
          )}
          {tDelta !== null && (
            <div className={`d ${tDelta > 0 ? 'up' : tDelta < 0 ? 'down' : ''}`}>
              {signed(tDelta)} on yesterday
            </div>
          )}
          {/* Only with a target to fill toward. A meter against no goal is a
              bar that means nothing. */}
          {pct !== null && (
            <>
              <div className="meter">
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="mlbl">
                {pct}% of {cal(goal!)}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="wacts">
        <button className="wact" onClick={openGoal}>
          Target goal
          <small>{goal === null ? 'not set' : `${cal(goal)} Cal a day`}</small>
        </button>
        <button className="wact wact--burn" onClick={() => openEntry(false)}>
          Calories burnt
          <small>{today === null ? 'today' : `adds to ${cal(today)}`}</small>
        </button>
      </div>

      {/* The way back from a mistyped number. Only worth offering once there
          is a total to correct. */}
      {today !== null && (
        <button className="wfix" onClick={() => openEntry(true)}>
          Correct today&rsquo;s total instead
        </button>
      )}

      <BurnChart
        points={points}
        goal={goal}
        range={range}
        onRange={setRange}
        now={now}
      />

      {sheet && (
        <div className="wsheet wsheet--burn">
          <span className="wwash" />
          <div className="wsh">
            <button onClick={() => setSheet(null)}>Cancel</button>
            <button className="save" onClick={() => void save()}>
              Save
            </button>
          </div>
          <div className="wmid">
            <div className="wlbl">
              {sheet.kind === 'goal'
                ? 'Calories to burn a day'
                : sheet.replace
                  ? "Correct today's total"
                  : 'Calories burnt'}
            </div>
            <WeightNumber
              value={draft}
              onChange={setDraft}
              unit="Cal"
              decimals={0}
              label="Calories"
            />
            <DraftNote
              draft={draft}
              sheet={sheet}
              today={today}
              yesterday={yesterday}
              goal={goal}
              points={points}
            />
            <div className="wtap">tap the number to type it</div>
          </div>
          <WeightDial
            value={draft}
            onChange={setDraft}
            min={0}
            max={3000}
            step={10}
            labelEvery={250}
            majorEvery={50}
            decimals={0}
            label="Calories"
            unitWord="calories"
            hue="burn"
          />
        </div>
      )}
    </>
  );
}

/**
 * What the number in front of you will do, live as the dial turns.
 *
 * The line matters more here than on the weight sheet, because the same dial
 * means three different things depending on how it was opened: a target, an
 * amount to add, or a total to overwrite. Saying which, with the arithmetic
 * already done, is the difference between the add behaviour being convenient
 * and it being a trap.
 */
function DraftNote({
  draft,
  sheet,
  today,
  yesterday,
  goal,
  points,
}: {
  draft: number;
  sheet: Exclude<Sheet, null>;
  today: number | null;
  yesterday: number | null;
  goal: number | null;
  points: BurnPoint[];
}) {
  if (sheet.kind === 'goal') {
    const avg = average(points);
    if (avg === null) {
      return <div className="wdelta same">nothing logged yet to compare with</div>;
    }
    const d = draft - avg;
    if (Math.abs(d) < 5) {
      return <div className="wdelta same">about your usual day</div>;
    }
    return (
      <div className={`wdelta ${d > 0 ? 'down' : 'up'}`}>
        {cal(Math.abs(d))} {d > 0 ? 'above' : 'below'} your average
      </div>
    );
  }

  if (sheet.replace) {
    const was = today ?? 0;
    const d = draft - was;
    return (
      <>
        <div className={`wdelta ${d > 0 ? 'up' : d < 0 ? 'down' : 'same'}`}>
          {Math.abs(d) < 1 ? 'unchanged' : `${signed(d)} on the ${cal(was)} recorded`}
        </div>
        <div className="wnote">Replaces today&rsquo;s total outright</div>
      </>
    );
  }

  // Adding. The total it becomes is the number that matters, so it leads.
  const total = (today ?? 0) + draft;
  const d = yesterday !== null ? total - yesterday : null;
  return (
    <>
      <div className={`wdelta ${d === null ? 'same' : d > 0 ? 'up' : d < 0 ? 'down' : 'same'}`}>
        {d === null
          ? goal !== null && total >= goal
            ? 'target met'
            : 'first entry'
          : `${signed(d)} on yesterday`}
      </div>
      <div className="wnote">
        {today === null
          ? `Today becomes ${cal(total)} Cal`
          : `Adding to the ${cal(today)} already logged — today becomes ${cal(total)}`}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- the chart */

const W = 360;
const H = 200;
const PAD = { l: 34, r: 10, t: 12, b: 22 };

function BurnChart({
  points,
  goal,
  range,
  onRange,
  now,
}: {
  points: BurnPoint[];
  goal: number | null;
  range: BurnRangeId;
  onRange: (r: BurnRangeId) => void;
  now: number;
}) {
  const [hover, setHover] = useState<BurnPoint | null>(null);
  const view = thin(points);

  const ranges = (
    <div className="ranges ranges--burn">
      {BURN_RANGES.map((r) => (
        <button key={r.id} aria-pressed={r.id === range} onClick={() => onRange(r.id)}>
          {r.id}
        </button>
      ))}
    </div>
  );

  if (view.length === 0) {
    return (
      <div className="chartcard">
        <div className="chead">
          <span className="ct">Burnt</span>
        </div>
        {ranges}
        <p className="cempty">
          Nothing recorded in this window. Log a burn and the first bar lands here.
        </p>
      </div>
    );
  }

  const hi = ceiling(view, goal);
  // Bars are read against zero. A burn chart starting at 300 would make a 320
  // day look like nothing at all, which is the opposite of what it is for.
  const y = (c: number) => PAD.t + (1 - c / hi) * (H - PAD.t - PAD.b);
  const base = y(0);

  const slots = slotsFor(view, now);
  const from0 = dayStartOf(now) - (slots - 1) * 86_400_000;
  const slotW = (W - PAD.l - PAD.r) / slots;
  const bw = Math.max(2, Math.min(15, slotW * 0.62));
  const xOf = (t: number) =>
    PAD.l + (Math.round((dayStartOf(t) - from0) / 86_400_000) + 0.5) * slotW;

  const rules = [0, 1, 2, 3].map((i) => (hi * i) / 3);
  const run = streak(view, goal);
  const avg = average(view);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = view[0];
    let bd = Infinity;
    for (const p of view) {
      const d = Math.abs(xOf(p.t) - px);
      if (d < bd) { bd = d; best = p; }
    }
    setHover(best);
  };

  return (
    <div className="chartcard">
      <div className="chead">
        <span className="ct">Burnt</span>
        <span className="cs">
          {view.length} day{view.length === 1 ? '' : 's'}
          {avg !== null && ` · ${cal(avg)} avg`}
        </span>
      </div>
      {/* Only with a target. Without one there is no such thing as a run. */}
      {goal !== null && (
        <div className="cstreak">
          {run === 0
            ? 'Last day under target — the next one starts a run'
            : `${run} day${run === 1 ? '' : 's'} running at or above target`}
        </div>
      )}
      {ranges}

      <div className="plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Calories burnt per day">
          {rules.map((r) => (
            <line key={r} x1={PAD.l} x2={W - PAD.r} y1={y(r)} y2={y(r)} className="crule" />
          ))}

          {view.map((p) => (
            <rect
              key={p.t}
              className={`bar${goal !== null && p.kcal >= goal ? ' met' : ''}${
                hover && hover.t === p.t ? ' hot' : ''
              }`}
              x={xOf(p.t) - bw / 2}
              y={y(p.kcal)}
              width={bw}
              height={Math.max(2, base - y(p.kcal))}
              rx={Math.min(4, bw / 2)}
            />
          ))}

          {/* Over the bars and labelled. The rule is deliberately recessive,
              so the number carries it rather than the colour. */}
          {goal !== null && goal < hi && (
            <>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(goal)} y2={y(goal)} className="cgoal" />
              <text x={W - PAD.r} y={y(goal) - 4} textAnchor="end" className="cgoallbl">
                target {cal(goal)}
              </text>
            </>
          )}

          {rules.map((r) => (
            <text key={`l${r}`} x={PAD.l - 6} y={y(r) + 3.5} textAnchor="end" className="ctick">
              {cal(r)}
            </text>
          ))}
          <text x={PAD.l} y={H - 6} textAnchor="start" className="ctick">
            {shortDate(view[0].t)}
          </text>
          {view.length > 1 && (
            <text x={W - PAD.r} y={H - 6} textAnchor="end" className="ctick">
              {shortDate(view[view.length - 1].t)}
            </text>
          )}
        </svg>

        {hover && (
          <div
            className="ctip ctip--burn"
            style={{
              left: `${(xOf(hover.t) / W) * 100}%`,
              top: `${(y(hover.kcal) / H) * 100}%`,
            }}
          >
            <b>{cal(hover.kcal)} Cal</b>
            <span>
              {shortDate(hover.t)}
              {goal !== null &&
                ` · ${hover.kcal >= goal ? 'at target' : `${cal(goal - hover.kcal)} under`}`}
            </span>
          </div>
        )}
      </div>

      <div className="clegend">
        {goal === null ? (
          <span>
            <i className="sw-burn" />
            Burnt
          </span>
        ) : (
          <>
            <span>
              <i className="sw-burn" />
              At target
            </span>
            <span>
              <i className="sw-burn-2" />
              Under
            </span>
            <span>
              <i className="sw-goal" />
              Target {cal(goal)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
