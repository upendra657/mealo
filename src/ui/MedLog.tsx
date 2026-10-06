/**
 * The medicine log: whether the schedule was followed, day by day.
 *
 * Built from the same planDay as the Meds screen, so a dose counts here
 * exactly when it would have been on that day's screen — not on a day its
 * schedule, a sickness or a stop left it off. Three states, said and unsaid:
 * taken and skipped are what someone ticked; missed is a dose that was due
 * and never answered either way, worked out rather than stored.
 *
 * Facts only. The screen counts and draws; it does not grade, scold or say
 * what to do about a missed dose — whether to take one late is a question for
 * a doctor or the label, and the app has no business nudging it.
 *
 * Every state has a shape as well as a colour (filled, dash, ring), so the
 * strip still reads for someone who cannot tell purple from amber.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  addDays,
  dateOf,
  describeDose,
  describeSchedule,
  fmtDay,
  medDay,
  scheduleOfDose,
  tallyOf,
  TIMES,
  type DayPlan,
  type DoseState,
  type Log,
  type PlannedDose,
  type Tally,
} from '../domain/doses';
import { cycleDose, readLog, type Medication } from '../domain/medications';
import { Chevron, Tick } from './bits';
import { SlotIcon } from './SlotIcon';

const RANGES = [
  { id: '7D', days: 7 },
  { id: '30D', days: 30 },
  { id: '3M', days: 90 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

// ------------------------------------------------------------ a dose's row

/** "every Sunday" on a weekly medicine's row; nothing on a daily one. */
function howOften(p: PlannedDose<Medication>): string | null {
  const s = scheduleOfDose(p.dose);
  if (s.freq === 'daily') return null;
  // Mid-sentence, so lower-case the first word only: "every Sunday",
  // "alternate days", "monthly, on the 15th".
  const said = describeSchedule(s);
  return said.charAt(0).toLowerCase() + said.slice(1);
}

/**
 * One dose and its circle. Shared by the Meds screen and a day in the log, so
 * the two can never draw a dose two ways.
 */
export function DoseRow({
  p,
  time,
  onOpen,
  onTick,
}: {
  p: PlannedDose<Medication>;
  time: string;
  onOpen?: () => void;
  onTick: () => void;
}) {
  const often = howOften(p);
  const body = (
    <>
      <span className="grow">
        <span className="nm" style={{ display: 'block' }}>
          {p.med.name}
          {p.med.dose_text && <span className="str num">{p.med.dose_text}</span>}
        </span>
        <span className="amt">
          {describeDose(p.dose)}
          {often && ` · ${often}`}
          {p.late && <span className="late"> · ticked later</span>}
        </span>
      </span>
      {p.med.long_term === 1 && <span className="tag tag--life">Long-Term</span>}
    </>
  );
  const label =
    p.state === 'taken'
      ? `${p.med.name}, taken. Tap to mark skipped`
      : p.state === 'skipped'
        ? `${p.med.name}, skipped. Tap to clear`
        : `Mark ${p.med.name} taken, ${time.toLowerCase()}`;
  return (
    <div className="row dose" data-state={p.state}>
      {onOpen ? (
        <button className="row-tap" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <span className="row-tap">{body}</span>
      )}
      <button className="tickb" data-state={p.state} aria-label={label} onClick={onTick}>
        {p.state === 'skipped' ? <span className="dash" /> : <Tick size={15} />}
      </button>
    </div>
  );
}

/** A day's doses grouped by time, ticked against that day. */
export function DoseGroups({
  plan,
  onOpen,
  onChanged,
}: {
  plan: DayPlan<Medication>;
  onOpen?: (medId: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <>
      {plan.groups.map((g) => {
        const t = TIMES.find((x) => x.id === g.time)!;
        const done = g.doses.filter((p) => p.state === 'taken').length;
        return (
          <div key={g.time}>
            <div className="section-h">
              <SlotIcon slot={t.slot} size={18} />
              {t.label}
              <span className="k num">
                {done} of {g.doses.length}
              </span>
            </div>
            {g.doses.map((p) => (
              <DoseRow
                key={p.dose.id}
                p={p}
                time={t.label}
                onOpen={onOpen ? () => onOpen(p.med.id) : undefined}
                onTick={async () => {
                  await cycleDose(p, plan.day);
                  await onChanged();
                }}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------- the summary

function answered(t: Tally) {
  return t.taken + t.skipped + t.missed;
}

/** Taken, skipped and missed as one bar, with a 2px gap between parts. */
function TallyBar({ t }: { t: Tally }) {
  const n = answered(t);
  if (n === 0) return <div className="lbar" />;
  const part = (k: 'taken' | 'skipped' | 'missed') =>
    t[k] > 0 ? <i data-k={k} style={{ flexGrow: t[k] }} /> : null;
  return (
    <div className="lbar" role="img" aria-label={`${t.taken} taken, ${t.skipped} skipped, ${t.missed} missed`}>
      {part('taken')}
      {part('skipped')}
      {part('missed')}
    </div>
  );
}

function Legend({ t }: { t: Tally }) {
  return (
    <div className="lleg">
      <span>
        <i className="mk-taken" />
        <b className="num">{t.taken}</b> taken
      </span>
      <span>
        <i className="mk-skipped" />
        <b className="num">{t.skipped}</b> skipped
      </span>
      <span>
        <i className="mk-missed" />
        <b className="num">{t.missed}</b> missed
      </span>
    </div>
  );
}

/** What one day looked like, for its cell: the worst thing that happened. */
function dayMark(plan: DayPlan<Medication>): DoseState | 'none' | 'partial' {
  const t = tallyOf(plan);
  if (answered(t) + t.pending === 0) return 'none';
  if (t.missed > 0) return 'missed';
  if (t.pending > 0) return t.taken + t.skipped > 0 ? 'partial' : 'due';
  if (t.skipped > 0) return t.taken > 0 ? 'partial' : 'skipped';
  return 'taken';
}

const MARK_WORDS: Record<string, string> = {
  none: 'nothing due',
  taken: 'all taken',
  skipped: 'skipped',
  missed: 'something missed',
  partial: 'some answered',
  due: 'not yet ticked',
};

// --------------------------------------------------------------- the log

export function LogPage({ onBack, onDay }: { onBack: () => void; onDay: (day: string) => void }) {
  const [range, setRange] = useState<RangeId>('30D');
  const [log, setLog] = useState<Log<Medication> | null>(null);
  const today = medDay();

  useEffect(() => {
    const days = RANGES.find((r) => r.id === range)!.days;
    let live = true;
    void readLog(addDays(today, -(days - 1)), today).then((l) => {
      if (live) setLog(l);
    });
    return () => {
      live = false;
    };
  }, [range, today]);

  // Weeks run Monday to Sunday, so the first row is padded back to a Monday.
  const first = log?.plans[0]?.day;
  const pad = first ? (dateOf(first).getDay() + 6) % 7 : 0;
  const n = log ? answered(log.total) : 0;

  return (
    <>
      <span className="mwash" />
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          Meds
        </button>
      </div>
      <div className="dish-name">Medicine log</div>

      <div className="ranges" style={{ marginTop: 10 }}>
        {RANGES.map((r) => (
          <button key={r.id} aria-pressed={r.id === range} onClick={() => setRange(r.id)}>
            {r.id}
          </button>
        ))}
      </div>

      {log && (
        <>
          <div className="card lcard">
            <div className="mk">
              {range === '7D' ? 'Last 7 days' : range === '30D' ? 'Last 30 days' : 'Last 3 months'}
            </div>
            {n === 0 ? (
              <p className="empty-note" style={{ margin: '8px 0 0' }}>
                Nothing was due in this stretch.
              </p>
            ) : (
              <>
                <div className="mbig">
                  <span className="n num lnum">{log.total.taken}</span>
                  <span className="of">
                    of {n} {n === 1 ? 'dose' : 'doses'} taken
                  </span>
                </div>
                <TallyBar t={log.total} />
                <Legend t={log.total} />
              </>
            )}
          </div>

          <div className="section-h">By day</div>
          <div className="lgrid" role="grid" aria-label="Each day in the range">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="lwd">
                {d}
              </span>
            ))}
            {Array.from({ length: pad }, (_, i) => (
              <span key={`p${i}`} />
            ))}
            {log.plans.map((plan) => {
              const mark = dayMark(plan);
              return (
                <button
                  key={plan.day}
                  className="lcell"
                  data-mark={mark}
                  data-today={plan.day === today ? '1' : undefined}
                  title={`${fmtDay(plan.day)}: ${MARK_WORDS[mark]}`}
                  aria-label={`${fmtDay(plan.day)}, ${MARK_WORDS[mark]}`}
                  onClick={() => onDay(plan.day)}
                >
                  <i />
                  <span className="num">{dateOf(plan.day).getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="section-h">By medicine</div>
          {log.meds.length === 0 && <p className="empty-note">No scheduled medicines in this stretch.</p>}
          {log.meds.map((m) => {
            const due = answered(m.tally);
            return (
              <div className="row lmed" key={m.med.id}>
                <span className="grow">
                  <span className="nm" style={{ display: 'block' }}>
                    {m.med.name}
                    {m.med.dose_text && <span className="str num">{m.med.dose_text}</span>}
                  </span>
                  <span className="amt">
                    {due === 0
                      ? 'nothing due yet'
                      : `${m.tally.taken} of ${due} taken` +
                        (m.tally.skipped ? ` · ${m.tally.skipped} skipped` : '') +
                        (m.tally.missed ? ` · ${m.tally.missed} missed` : '')}
                  </span>
                  <TallyBar t={m.tally} />
                </span>
              </div>
            );
          })}

          <div className="foot">
            Missed is a dose that was due and never ticked either way. Tap a day to fix one.
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------ one past day

export function DayLogPage({
  day,
  onBack,
}: {
  day: string;
  onBack: () => void;
}) {
  const [plan, setPlan] = useState<DayPlan<Medication> | null>(null);
  const load = useCallback(async () => {
    setPlan((await readLog(day, day)).plans[0] ?? null);
  }, [day]);
  useEffect(() => {
    void load();
  }, [load]);

  const t = plan ? tallyOf(plan) : null;
  const n = t ? answered(t) + t.pending : 0;

  return (
    <>
      <span className="mwash" />
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          Log
        </button>
      </div>
      <div className="dish-name">
        {dateOf(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      <div className="dish-sub">
        {plan?.episode ? `${plan.episode.name} · ` : ''}
        {t && n > 0
          ? `${t.taken} of ${n} taken` + (t.skipped ? ` · ${t.skipped} skipped` : '') +
            (t.missed ? ` · ${t.missed} missed` : '')
          : 'Nothing was due'}
      </div>
      {plan && <DoseGroups plan={plan} onChanged={load} />}
      {plan && day < medDay() && n > 0 && (
        <div className="foot">A tick made today for an earlier day is marked as ticked later.</div>
      )}
    </>
  );
}
