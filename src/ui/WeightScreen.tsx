/**
 * Weight: yesterday, today, and the line between them.
 *
 * Everything drawn here comes from rows that exist. There is no sample series
 * and no carrying a value forward across days nobody weighed — a flat line
 * through an unweighed week looks like data and is not. With one reading there
 * is a dot and no line, because two points are the minimum a line can honestly
 * be made of, and with none there is a sentence instead of an empty chart.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  RANGES,
  bounds,
  byDay,
  dayStartOf,
  goalWeight,
  latestWeight,
  recordWeight,
  setGoalWeight,
  thin,
  weightOn,
  weightsSince,
  type Point,
  type RangeId,
} from '../domain/weight';
import { Chevron } from './bits';
import { WeightDial, WeightNumber } from './WeightDial';

const kg2 = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}`;
const shortDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

type Sheet = null | 'today' | 'goal';

export function WeightScreen({ onBack }: { onBack: () => void }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [today, setToday] = useState<number | null>(null);
  const [yesterday, setYesterday] = useState<number | null>(null);
  const [beforeThat, setBeforeThat] = useState<number | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [range, setRange] = useState<RangeId>('1M');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState(70);

  const load = useCallback(async () => {
    const days = RANGES.find((r) => r.id === range)!.days;
    const rows = await weightsSince(Date.now() - days * 86_400_000);
    setPoints(byDay(rows));

    const t0 = dayStartOf(Date.now());
    const t = await weightOn(t0);
    const y = await weightOn(t0 - 86_400_000);
    const b = await weightOn(t0 - 2 * 86_400_000);
    setToday(t?.kg ?? null);
    setYesterday(y?.kg ?? null);
    setBeforeThat(b?.kg ?? null);
    setGoal(await goalWeight());
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSheet = async (which: Exclude<Sheet, null>) => {
    if (which === 'goal') {
      const last = await latestWeight();
      setDraft(goal ?? last?.kg ?? 70);
    } else {
      // The dial's whole point: start where you were, not at nothing.
      const last = await latestWeight();
      setDraft(today ?? last?.kg ?? 70);
    }
    setSheet(which);
  };

  const save = async () => {
    if (sheet === 'today') await recordWeight(draft);
    else if (sheet === 'goal') await setGoalWeight(draft);
    setSheet(null);
    await load();
  };

  const yDelta = yesterday !== null && beforeThat !== null ? yesterday - beforeThat : null;
  const tDelta = today !== null && yesterday !== null ? today - yesterday : null;

  return (
    <>
      {/* The same header row every other screen uses. Without it the back
          button starts at the very top of the shell, which on a phone means
          underneath the status bar. */}
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron size={15} />
          Home
        </button>
      </div>

      <div className="wgrid">
        <div className="wcard">
          <div className="k">Yesterday</div>
          {yesterday === null ? (
            <div className="v none">Not recorded</div>
          ) : (
            <div className="v">
              {kg2(yesterday)}
              <small>kg</small>
            </div>
          )}
          {yDelta !== null && (
            <div className={`d ${yDelta < 0 ? 'down' : yDelta > 0 ? 'up' : ''}`}>
              {signed(yDelta)} on the day before
            </div>
          )}
        </div>

        <div className="wcard">
          <div className="k">Today</div>
          {today === null ? (
            <div className="v none">Not recorded</div>
          ) : (
            <div className="v">
              {kg2(today)}
              <small>kg</small>
            </div>
          )}
          {tDelta !== null && (
            <div className={`d ${tDelta < 0 ? 'down' : tDelta > 0 ? 'up' : ''}`}>
              {signed(tDelta)} on yesterday
            </div>
          )}
        </div>
      </div>

      <div className="wacts">
        <button className="wact" onClick={() => void openSheet('goal')}>
          Target Weight
          <small>{goal === null ? 'not set' : `${kg2(goal)} kg`}</small>
        </button>
        <button className="wact wact--go" onClick={() => void openSheet('today')}>
          {today === null ? 'Add weight' : 'Update weight'}
          <small>today</small>
        </button>
      </div>

      <WeightChart points={points} goal={goal} range={range} onRange={setRange} />

      {sheet && (
        <div className="wsheet">
          <span className="wwash" />
          <div className="wsh">
            <button onClick={() => setSheet(null)}>Cancel</button>
            <button className="save" onClick={() => void save()}>
              Save
            </button>
          </div>
          <div className="wmid">
            <div className="wlbl">{sheet === 'goal' ? 'Target weight' : "Today's weight"}</div>
            <WeightNumber value={draft} onChange={setDraft} />
            <DraftDelta draft={draft} sheet={sheet} today={today} yesterday={yesterday} goal={goal} />
            <div className="wtap">tap the number to type it</div>
          </div>
          <WeightDial value={draft} onChange={setDraft} />
        </div>
      )}
    </>
  );
}

/**
 * What the number in front of you means, live as the dial turns.
 *
 * Without this a dial in hundredths is illegible — 71.40 and 71.44 look the
 * same at a glance, and the thing you actually want to know is which way and
 * how far from where you were.
 */
function DraftDelta({
  draft,
  sheet,
  today,
  yesterday,
  goal,
}: {
  draft: number;
  sheet: Exclude<Sheet, null>;
  today: number | null;
  yesterday: number | null;
  goal: number | null;
}) {
  if (sheet === 'goal') {
    const from = today ?? yesterday;
    if (from === null) return <div className="wdelta same">no reading to compare with yet</div>;
    const d = draft - from;
    if (Math.abs(d) < 0.005) return <div className="wdelta same">where you are now</div>;
    return (
      <div className={`wdelta ${d < 0 ? 'down' : 'up'}`}>
        {Math.abs(d).toFixed(2)} kg {d < 0 ? 'below' : 'above'} where you are
      </div>
    );
  }

  const from = yesterday ?? today;
  if (from === null) {
    // The first entry has nothing to be a delta from. Say that, rather than
    // leaving the line blank — a blank there reads as something failing.
    if (goal === null) return <div className="wdelta same">first reading</div>;
    const g = draft - goal;
    return (
      <div className="wdelta same">
        {Math.abs(g) < 0.005
          ? 'exactly your target'
          : `${Math.abs(g).toFixed(2)} kg ${g > 0 ? 'above' : 'below'} target`}
      </div>
    );
  }
  const d = draft - from;
  if (Math.abs(d) < 0.005) return <div className="wdelta same">same as yesterday</div>;
  return (
    <div className={`wdelta ${d < 0 ? 'down' : 'up'}`}>
      {signed(d)} kg on yesterday
    </div>
  );
}

/* ------------------------------------------------------------- the chart */

const W = 360;
const H = 200;
const PAD = { l: 30, r: 8, t: 12, b: 22 };

function WeightChart({
  points,
  goal,
  range,
  onRange,
}: {
  points: Point[];
  goal: number | null;
  range: RangeId;
  onRange: (r: RangeId) => void;
}) {
  const [hover, setHover] = useState<Point | null>(null);
  const view = thin(points);

  const ranges = (
    <div className="ranges">
      {RANGES.map((r) => (
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
          <span className="ct">Weight</span>
        </div>
        {ranges}
        <p className="cempty">
          Nothing recorded in this window. Add a weight and the line starts here.
        </p>
      </div>
    );
  }

  const { lo, hi } = bounds(view, goal);
  const span = Math.max(1, view[view.length - 1].t - view[0].t);
  const x = (t: number) =>
    view.length === 1
      ? (PAD.l + W - PAD.r) / 2
      : PAD.l + ((t - view[0].t) / span) * (W - PAD.l - PAD.r);
  const y = (kg: number) => PAD.t + (1 - (kg - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const line = view.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.kg).toFixed(1)}`).join('');
  const last = view[view.length - 1];
  const first = view[0];
  const move = last.kg - first.kg;

  const rules = [0, 1, 2, 3].map((i) => {
    const kg = lo + ((hi - lo) * i) / 3;
    return { kg, y: y(kg) };
  });

  const labelAt = [0, Math.floor(view.length / 2), view.length - 1].filter(
    (n, i, a) => a.indexOf(n) === i,
  );

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = view[0];
    let bd = Infinity;
    for (const p of view) {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) { bd = d; best = p; }
    }
    setHover(best);
  };

  return (
    <div className="chartcard">
      <div className="chead">
        <span className="ct">Weight</span>
        <span className="cs">
          {view.length === 1
            ? '1 reading'
            : `${signed(move)} kg · ${view.length} readings`}
        </span>
      </div>
      {ranges}

      <div className="plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Weight over time">
          <defs>
            <linearGradient id="wfade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--weight)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--weight)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {rules.map((r) => (
            <line key={r.kg} x1={PAD.l} x2={W - PAD.r} y1={r.y} y2={r.y} className="crule" />
          ))}

          {goal !== null && goal > lo && goal < hi && (
            <line x1={PAD.l} x2={W - PAD.r} y1={y(goal)} y2={y(goal)} className="cgoal" />
          )}

          {view.length > 1 && (
            <>
              <path d={`${line}L${x(last.t).toFixed(1)},${H - PAD.b}L${x(first.t).toFixed(1)},${H - PAD.b}Z`} fill="url(#wfade)" />
              <path d={line} className="cline" />
            </>
          )}

          <circle cx={x(last.t)} cy={y(last.kg)} r={4.5} className="cdot" />

          {hover && (
            <>
              <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={H - PAD.b} className="ccross" />
              <circle cx={x(hover.t)} cy={y(hover.kg)} r={4} className="cdot" />
            </>
          )}

          {rules.map((r) => (
            <text key={`l${r.kg}`} x={PAD.l - 6} y={r.y + 3.5} textAnchor="end" className="ctick">
              {r.kg.toFixed(1)}
            </text>
          ))}
          {view.length > 1 &&
            labelAt.map((n, i) => (
              <text
                key={`d${n}`}
                x={x(view[n].t)}
                y={H - 6}
                textAnchor={i === 0 ? 'start' : i === labelAt.length - 1 ? 'end' : 'middle'}
                className="ctick"
              >
                {shortDate(view[n].t)}
              </text>
            ))}
        </svg>

        {hover && (
          <div
            className="ctip"
            style={{ left: `${(x(hover.t) / W) * 100}%`, top: `${(y(hover.kg) / H) * 100}%` }}
          >
            <b>{kg2(hover.kg)} kg</b>
            <span>{shortDate(hover.t)}</span>
          </div>
        )}
      </div>

      <div className="clegend">
        <span>
          <i className="sw-weight" />
          Weight
        </span>
        {goal !== null && (
          <span>
            <i className="sw-goal" />
            Target {kg2(goal)}
          </span>
        )}
        {view.length === 1 && <span className="muted">one point — a line needs two</span>}
      </div>
    </div>
  );
}
