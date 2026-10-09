/**
 * The day.
 *
 * What you ate, grouped the way the day is shaped, with the one summary that
 * answers "how am I doing" at the top. Tapping the summary opens the full
 * breakdown; tapping a logged row opens it for correction, because "one
 * burger" turning out to be two is the most common edit there is.
 */

import { useCallback, useEffect, useState } from 'react';
import { readDay, type DayView } from '../domain/day';
import { cyclePlan, deleteMealItem, startOfToday, type MealItem } from '../domain/meals';
import { canTick, circleOf, dayLabel, lastPlannableDay } from '../domain/plan';
import { toMeasure } from '../domain/measures';
import { slot as slotOf } from '../domain/slots';
import {
  loadTargets,
  OVER_IS_BAD,
  standing,
  TARGET_FIELDS,
  type Standing,
  type Targets,
} from '../domain/targets';
import { Bin, Chevron, fmtQty, Plus, Tick, useToast } from './bits';
import { DatePicker } from './DatePicker';
import type { Screen } from '../App';
import { setDraft } from './LogFlow';


export function Day({
  go,
  avatar,
  dayStart,
  setDayStart,
}: {
  go: (s: Screen) => void;
  avatar: React.ReactNode;
  dayStart: number | null;
  setDayStart: (n: number) => void;
}) {
  const start = dayStart ?? startOfToday();
  const [view, setView] = useState<DayView | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [calendar, setCalendar] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setView(await readDay(start));
    setTargets(await loadTargets());
  }, [start]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (dayStart === null) setDayStart(startOfToday());
  }, [dayStart, setDayStart]);

  const date = new Date(start);

  // Date arithmetic, not milliseconds: adding 86,400,000 across a daylight
  // saving change lands an hour off and silently shows the wrong day.
  const shift = (n: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() > lastPlannableDay()) return;
    setDayStart(d.getTime());
  };
  const atLimit = start >= lastPlannableDay();
  const label = dayLabel(start);
  const ticks = canTick(start);

  const totals = view?.totals ?? [0, 0, 0, 0, 0];
  const planned = view?.planned ?? [0, 0, 0, 0, 0];
  const kcalStanding = standing(totals[0], targets?.energy_kcal ?? null, true);

  const remove = async (item: MealItem) => {
    await deleteMealItem(item.id);
    toast('Removed');
    await refresh();
  };

  const tick = async (item: MealItem) => {
    await cyclePlan(item, start);
    await refresh();
  };

  const edit = (item: MealItem) => {
    setDraft({
      mode: 'edit',
      itemId: item.id,
      mealId: item.meal_id,
      foodId: item.food_id,
      label: item.label,
      quantity: item.quantity ?? 1,
      measure: item.unit,
      slot: 'other',
      step: 'dish',
    });
    go('log');
  };

  return (
    <>
      <div className="top">
        <button className="back" onClick={() => go('home')}>
          <Chevron />
          Home
        </button>
        <div className="grow" />
        {avatar}
        <button
          className="icon-btn primary"
          title="Add food"
          onClick={() => {
            setDraft(null);
            go('log');
          }}
        >
          <Plus />
        </button>
      </div>

      <div className="datebar">
        <button className="arrow" onClick={() => shift(-1)} aria-label="Previous day">
          <Chevron size={16} />
        </button>
        {/* The date is the way into the calendar. Stepping a day at a time
            is fine for yesterday and hopeless for last month. */}
        <button
          className="date-open"
          onClick={() => setCalendar((v) => !v)}
          aria-expanded={calendar}
          aria-haspopup="dialog"
        >
          <span className="d">
            {date.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
            <Chevron size={13} dir="down" />
          </span>
          <span className="today">{label || '\u00a0'}</span>
        </button>
        {/* Forward as far as a meal can be planned, and no further. */}
        <button
          className="arrow"
          onClick={() => shift(1)}
          disabled={atLimit}
          aria-label="Next day"
        >
          <Chevron size={16} dir="right" />
        </button>

        {calendar && (
          <DatePicker
            selected={start}
            onPick={setDayStart}
            onClose={() => setCalendar(false)}
          />
        )}
      </div>

      <button
        className="card card--tap"
        onClick={() => go('insights')}
        aria-label="Open insights for this day"
      >
        <div className="kcal">
          <span className="big num">{Math.round(totals[0])}</span>
          <span className="of">
            {targets?.energy_kcal ? (
              <>
                of <span className="num">{targets.energy_kcal}</span> Cal
              </>
            ) : (
              'Cal'
            )}
          </span>
          <span className={`pct num is-${kcalStanding.standing}`}>
            {kcalStanding.pct === null ? '—' : `${kcalStanding.pct}%`}
          </span>
        </div>
        <PlanBar
          standing={kcalStanding.standing}
          value={totals[0]}
          planned={planned[0]}
          goal={targets?.energy_kcal ?? null}
        />
        {planned[0] > 0 && (
          <div className="plan-note">
            <b className="num">+{Math.round(planned[0]).toLocaleString()} Cal</b> planned
          </div>
        )}

        <div className="macros">
          {TARGET_FIELDS.slice(1).map((f, n) => {
            const value = totals[n + 1];
            const goal = targets?.[f.key] ?? null;
            const st = standing(value, goal, OVER_IS_BAD[f.key]);
            return (
              <div className="macro" key={f.key}>
                <span className="lbl">{f.label}</span>
                <span className={`val num is-${st.standing}`}>
                  {st.pct === null ? 'set a target' : `${st.pct}%`}
                </span>
                <PlanBar
                  standing={st.standing}
                  value={value}
                  planned={planned[n + 1]}
                  goal={goal}
                  span
                />
                <span className="lbl num" style={{ gridColumn: '1 / -1' }}>
                  {value}
                  {goal ? ` / ${goal}` : ''} g
                </span>
              </div>
            );
          })}
        </div>
        {!targets?.energy_kcal && (
          <p className="note" style={{ marginBottom: 0 }}>
            No targets set yet. Bars stay grey rather than measuring you
            against a number the app made up.
          </p>
        )}
      </button>

      {view && view.listed.length === 0 && (
        <>
          <div className="section-h">Nothing logged</div>
          <p className="empty-note">Tap + to add the first thing.</p>
        </>
      )}

      {view?.listed.map((g) => {
        const eaten = Math.round(g.macros[0]);
        const ahead = Math.round(g.planned[0]);
        return (
        <div key={g.slot}>
          <div className="section-h">
            {slotOf(g.slot).label}
            <span className="k num">
              {eaten > 0 || ahead === 0 ? `${eaten} Cal` : ''}
              {ahead > 0 && (
                <span className="pl">
                  {eaten > 0 ? '+ ' : ''}
                  {ahead} planned
                </span>
              )}
            </span>
          </div>
          {g.items.map((item) => {
            const circle = circleOf(item.plan_state, start);
            return (
            <div className="row" key={item.id} data-plan={circle ?? undefined}>
              <button
                className="row-tap"
                onClick={() => edit(item)}
                title="Change the amount"
              >
                <span className="grow">
                  <span className="nm" style={{ display: 'block' }}>
                    {item.label}
                  </span>
                  <span className="amt num" style={{ display: 'block' }}>
                    {item.quantity && item.unit
                      ? `${fmtQty(item.quantity)} ${toMeasure(item.unit)?.label ?? item.unit}`
                      : 'amount not recorded'}
                    {item.net_weight_g ? ` · ${item.net_weight_g}g` : ''}
                    {circle && circle !== 'eaten' && (
                      <span className="pl-tag">
                        {circle === 'skipped' ? ' · skipped' : ' · planned'}
                      </span>
                    )}
                  </span>
                </span>
                <span className="kc num">
                  {item.energy_kcal === null ? '—' : Math.round(item.energy_kcal)}
                </span>
              </button>
              {/* Only a meal logged ahead of its time has a circle; one logged
                  as it was eaten is just logged. Before its day the circle is
                  shown but cannot be ticked. */}
              {circle && (
                <button
                  className="tickb"
                  data-state={circle}
                  disabled={!ticks}
                  aria-label={
                    circle === 'eaten'
                      ? `${item.label}, eaten. Tap to mark skipped`
                      : circle === 'skipped'
                        ? `${item.label}, skipped. Tap to plan it again`
                        : ticks
                          ? `Mark ${item.label} eaten`
                          : `${item.label}, planned`
                  }
                  onClick={() => void tick(item)}
                >
                  {circle === 'skipped' ? <span className="dash" /> : <Tick size={15} />}
                </button>
              )}
              <button
                className="bin"
                aria-label={`Delete ${item.label}`}
                title="Delete"
                onClick={() => void remove(item)}
              >
                <Bin />
              </button>
            </div>
            );
          })}
        </div>
        );
      })}

      <div className="foot">
        {view?.hasGaps
          ? 'Some items have no numbers, so the totals are a floor.'
          : 'Tap anything you logged to change its quantity or measure.'}
      </div>
    </>
  );
}

/**
 * A target bar with the day's plans after what was eaten, in grey.
 *
 * The grey part starts where the eaten fill stops and is cut at the end of
 * the bar, so eaten-plus-planned past the target reads as a full bar rather
 * than spilling. The percentage beside it stays what was eaten.
 */
function PlanBar({
  standing,
  value,
  planned,
  goal,
  span,
}: {
  standing: Standing;
  value: number;
  planned: number;
  goal: number | null;
  /** Inside a macro's grid, where the bar is a span across both columns. */
  span?: boolean;
}) {
  const eaten = goal ? Math.min(100, (value / goal) * 100) : 0;
  const grey = goal && planned > 0 ? Math.min(100 - eaten, (planned / goal) * 100) : 0;
  const Tag = span ? 'span' : 'div';
  return (
    <Tag className={`bar f-${standing}${grey > 0 ? ' split' : ''}`}>
      <i style={{ width: `${eaten}%` }} />
      {grey > 0 && <i className="plan" style={{ width: `${grey}%` }} />}
    </Tag>
  );
}
