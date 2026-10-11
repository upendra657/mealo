/**
 * The "For human" report, on screen and on paper.
 *
 * A layer over the whole app rather than a screen of its own, drawn into
 * the page body so that printing can show it alone: "Save as PDF" is the
 * browser's own print dialog, which costs nothing and needs no library. On
 * paper it is dark ink on white (see the print rules in styles.css); the app
 * itself stays dark.
 *
 * Everything drawn here was worked out in domain/report.ts. This file
 * chooses a form for each figure and nothing else:
 *
 *   a headline number          a tile, not a chart
 *   calories day by day        bars on one baseline, the target as a line
 *   a figure against a target  one thin bar per figure, each on its own
 *                              scale, because grams and calories share none
 *   doses                      one stacked bar: parts of a whole
 *   weight                     a line, since the order of the days matters
 *
 * A day with nothing logged is drawn as a gap with a mark on the baseline,
 * never as a bar of zero: zero would say "ate nothing", and what is true is
 * "did not log".
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BodyReport, FoodReport, HumanReport, MedsReport } from '../domain/report';
import { dateLabel } from '../domain/export';
import { Chevron } from './bits';

const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Tiles({ cells }: { cells: { value: string; of?: string; label: string }[] }) {
  return (
    <div className="am-figs">
      {cells.map((c) => (
        <div key={c.label}>
          <div className="am-fig-v">
            {c.value} {c.of && <small>{c.of}</small>}
          </div>
          <div className="am-fig-l">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function CaloriesByDay({ food }: { food: FoodReport }) {
  const target = food.averages[0].target;
  const [picked, setPicked] = useState<number | null>(null);
  const top = Math.max(target ?? 0, ...food.perDay.map((d) => d.kcal ?? 0)) * 1.08 || 1;
  const shown = picked != null ? food.perDay[picked] : null;
  return (
    <div className="rp-chart">
      {/* The reading for a tapped day sits above the plot, where a thumb on
          the bar does not cover it. */}
      <div className="rp-read">
        {shown
          ? `${shown.label} · ${shown.kcal == null ? 'nothing logged' : `${whole(shown.kcal)} Cal`}`
          : 'Tap a day for its figure'}
      </div>
      <div className="rp-plot">
        {target != null && (
          <div className="rp-target" style={{ bottom: `${(target / top) * 100}%` }}>
            <span>Target {whole(target)}</span>
          </div>
        )}
        <div className="rp-bars" data-dense={food.perDay.length > 45 ? '1' : undefined}>
          {food.perDay.map((d, i) => (
            <button
              key={d.day}
              className="rp-col"
              aria-label={`${d.label}: ${d.kcal == null ? 'nothing logged' : `${whole(d.kcal)} Cal`}`}
              aria-pressed={picked === i}
              onClick={() => setPicked(picked === i ? null : i)}
            >
              {d.kcal == null ? <i className="rp-none" /> : <i className="rp-bar" style={{ height: `${Math.max(2, (d.kcal / top) * 100)}%` }} />}
            </button>
          ))}
        </div>
      </div>
      <div className="rp-axis">
        <span>{food.perDay[0].label}</span>
        <span>{food.perDay[food.perDay.length - 1].label}</span>
      </div>
      <div className="rp-key">
        <span>
          <i className="rp-k-bar" />
          Logged day
        </span>
        <span>
          <i className="rp-k-none" />
          Nothing logged
        </span>
        {target != null && (
          <span>
            <i className="rp-k-line" />
            Target
          </span>
        )}
      </div>
    </div>
  );
}

function Food({ food, days }: { food: FoodReport; days: number }) {
  const cal = food.averages[0];
  if (food.daysLogged === 0) {
    return (
      <section className="rp-sec">
        <h2>Meals</h2>
        <p className="rp-note">No meals were logged in this period.</p>
      </section>
    );
  }
  return (
    <section className="rp-sec">
      <h2>Meals</h2>
      <Tiles
        cells={[
          { label: 'Calories a day', value: whole(cal.avg!), of: cal.target != null ? `/ ${whole(cal.target)} Cal` : 'Cal' },
          { label: 'Days logged', value: String(food.daysLogged), of: `of ${days}` },
          ...(food.withinTarget ? [{ label: 'Days within calorie target', value: String(food.withinTarget.days), of: `of ${food.withinTarget.of} logged` }] : []),
          ...(food.planned + food.skipped > 0 ? [{ label: 'Planned, not eaten', value: String(food.planned + food.skipped), of: food.planned + food.skipped === 1 ? 'dish' : 'dishes' }] : []),
        ]}
      />
      <p className="rp-note">
        Averages are over the {plural(food.daysLogged, 'day')} with something logged. A day with nothing logged is missing data, not a day
        without food.{food.withinTarget ? ' "Within target" is 76% to 100% of your calorie target.' : ''}
      </p>

      <h3>Calories, day by day</h3>
      <CaloriesByDay food={food} />

      <h3>Against your targets</h3>
      <div className="rp-rows">
        {food.averages.slice(1).map((m) => {
          const pct = m.target ? Math.min(100, (m.avg! / m.target) * 100) : null;
          return (
            <div key={m.key} className="rp-row">
              <div className="rp-row-h">
                <span>{m.label}</span>
                <span className="num">
                  {whole(m.avg!)}
                  {m.target != null ? ` / ${whole(m.target)}` : ''} {m.unit}
                  {m.target != null && m.avg! > m.target ? ' · over' : ''}
                </span>
              </div>
              {pct != null && (
                <div className="rp-track">
                  <i style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h3>Where it came from</h3>
      <table className="rp-table">
        <tbody>
          {food.behind.map((b) => (
            <tr key={b.key}>
              <th>{b.label}</th>
              <td>
                {b.dishes.length === 0
                  ? 'Nothing recorded'
                  : b.dishes.map((d) => `${d.name} ${Math.round(d.share * 100)}%`).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rp-note">The three dishes that supplied the most of each, as a share of the period&rsquo;s total.</p>

      <h3>When you eat</h3>
      <table className="rp-table">
        <tbody>
          {food.slots.map((s) => (
            <tr key={s.slot}>
              <th>{s.slot}</th>
              <td>
                {plural(s.meals, 'meal')} · {whole(s.avgKcal)} Cal on average
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Meds({ meds }: { meds: MedsReport }) {
  const parts = [
    { id: 'taken', label: 'Taken', n: meds.taken },
    { id: 'skipped', label: 'Skipped', n: meds.skipped },
    { id: 'missed', label: 'Missed', n: meds.missed },
    { id: 'pending', label: 'Still due today', n: meds.pending },
  ].filter((p) => p.n > 0);
  return (
    <section className="rp-sec">
      <h2>Medicines</h2>
      {meds.due === 0 ? (
        <p className="rp-note">No doses were scheduled in this period.</p>
      ) : (
        <>
          <Tiles
            cells={[
              { label: 'Doses taken', value: String(meds.taken), of: `of ${meds.due}` },
              { label: 'Skipped or missed', value: String(meds.skipped + meds.missed), of: `of ${meds.due}` },
            ]}
          />
          <div className="rp-stack" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
            {parts.map((p) => (
              <i key={p.id} data-part={p.id} style={{ flexGrow: p.n }} />
            ))}
          </div>
          {/* The count is written beside each colour: the bar is never the
              only way to tell taken from missed. */}
          <div className="rp-key">
            {parts.map((p) => (
              <span key={p.id}>
                <i data-part={p.id} />
                {p.label} {p.n}
              </span>
            ))}
          </div>
          <p className="rp-note">Missed means a dose was due, was never answered, and its day is over.</p>
        </>
      )}

      {meds.notTaken.length > 0 && (
        <>
          <h3>Doses not taken</h3>
          <table className="rp-table">
            <tbody>
              {meds.notTaken.map((n) => (
                <tr key={`${n.medicine}${n.time}`}>
                  <th>
                    {n.medicine}
                    <small>{n.time}</small>
                  </th>
                  <td>
                    {[n.skipped && `${n.skipped} skipped`, n.missed && `${n.missed} missed`].filter(Boolean).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {meds.medicines.length > 0 && (
        <>
          <h3>Medicines in this period</h3>
          <table className="rp-table">
            <tbody>
              {meds.medicines.map((m) => (
                <tr key={m.name}>
                  <th>
                    {m.name}
                    {m.sickness && <small>for {m.sickness}</small>}
                  </th>
                  <td>
                    {m.schedule}
                    {m.stoppedOn ? ` · stopped ${dateLabel(m.stoppedOn)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {meds.episodes.length > 0 && (
        <>
          <h3>Sick periods</h3>
          <table className="rp-table">
            <tbody>
              {meds.episodes.map((e) => (
                <tr key={`${e.name}${e.from}`}>
                  <th>{e.name}</th>
                  <td>
                    {dateLabel(e.from)} to {dateLabel(e.to)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function WeightLine({ body }: { body: BodyReport }) {
  const W = 340;
  const H = 120;
  const pad = { l: 8, r: 8, t: 22, b: 10 };
  const kgs = body.weights.map((w) => w.kg);
  const lo = Math.min(...kgs);
  const hi = Math.max(...kgs);
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (i / (kgs.length - 1)) * (W - pad.l - pad.r);
  const y = (kg: number) => pad.t + (1 - (kg - lo) / span) * (H - pad.t - pad.b);
  const first = body.weights[0];
  const last = body.weights[body.weights.length - 1];
  return (
    <div className="rp-chart">
      <svg className="rp-line" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weight from ${first.kg.toFixed(1)} kg to ${last.kg.toFixed(1)} kg`}>
        <polyline points={kgs.map((kg, i) => `${x(i)},${y(kg)}`).join(' ')} />
        {/* Only the ends are marked and labelled: a number on every point is
            a table drawn badly. */}
        <circle cx={x(0)} cy={y(first.kg)} r="4.5" />
        <circle cx={x(kgs.length - 1)} cy={y(last.kg)} r="4.5" />
        <text x={pad.l} y={12} textAnchor="start">
          {first.kg.toFixed(1)} kg
        </text>
        <text x={W - pad.r} y={12} textAnchor="end">
          {last.kg.toFixed(1)} kg
        </text>
      </svg>
      <div className="rp-axis">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}

function Body({ body }: { body: BodyReport }) {
  const w = body.weights;
  return (
    <section className="rp-sec">
      <h2>Weight and activity</h2>
      <Tiles
        cells={[
          w.length === 0
            ? { label: 'Weight', value: '–', of: 'not recorded' }
            : { label: w.length === 1 ? `Weight, ${w[0].label}` : 'Latest weight', value: w[w.length - 1].kg.toFixed(1), of: 'kg' },
          ...(body.change != null ? [{ label: 'Change in the period', value: `${body.change > 0 ? '+' : body.change < 0 ? '−' : ''}${Math.abs(body.change).toFixed(1)}`, of: 'kg' }] : []),
          ...(body.goalWeightKg != null ? [{ label: 'Goal weight', value: body.goalWeightKg.toFixed(1), of: 'kg' }] : []),
          ...(body.avgBurn != null
            ? [{ label: `Burn a day, over ${plural(body.burnDays, 'day')}`, value: whole(body.avgBurn), of: body.goalBurnKcal != null ? `/ ${whole(body.goalBurnKcal)} Cal` : 'Cal' }]
            : []),
        ]}
      />
      {w.length >= 2 && <WeightLine body={body} />}
      {w.length >= 2 && <p className="rp-note">{plural(w.length, 'reading')}. The line joins them in order; the days between are not measured.</p>}

      <h3>Symptoms</h3>
      {body.symptoms.length === 0 ? (
        <p className="rp-note">None logged in this period.</p>
      ) : (
        <table className="rp-table">
          <tbody>
            {body.symptoms.map((s, i) => (
              <tr key={i}>
                <th>
                  {s.day}
                  <small>{s.resolved ? 'resolved' : 'still open'}</small>
                </th>
                <td>{s.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ReportView({ report, print, onClose }: { report: HumanReport; print?: boolean; onClose: () => void }) {
  // The page behind must not scroll under the layer, and print needs to
  // know a report is up so it can hide everything else.
  useEffect(() => {
    document.documentElement.classList.add('rp-open');
    return () => document.documentElement.classList.remove('rp-open');
  }, []);
  // Opened by "Save as PDF": straight to the print dialog, once it is drawn.
  useEffect(() => {
    if (!print) return;
    const t = setTimeout(() => window.print(), 350);
    return () => clearTimeout(t);
  }, [print]);

  return createPortal(
    <div className="rp" role="dialog" aria-modal="true" aria-label={report.title}>
      <div className="rp-top">
        <button className="back" onClick={onClose}>
          <Chevron />
          Back
        </button>
        <div className="grow" />
        <button className="rp-pdf" onClick={() => window.print()}>
          Save as PDF
        </button>
      </div>
      <header className="rp-head">
        <div className="am-eyeb">Mealo · worked out by the app</div>
        <h1>{report.title}</h1>
        <p>
          {report.period} · {plural(report.days, 'day')}
        </p>
      </header>
      {report.food && <Food food={report.food} days={report.days} />}
      {report.meds && <Meds meds={report.meds} />}
      {report.body && <Body body={report.body} />}
      <footer className="rp-foot">
        Every figure here was worked out by the app from what was logged. No AI was used and nothing left this phone. This is a record, not
        medical advice.
      </footer>
    </div>,
    document.body,
  );
}
