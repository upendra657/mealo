/**
 * The weekly summary, in Ask Mealo.
 *
 * Upendra's call, 15 Oct 2026: Ask Mealo is where a week is talked about,
 * so the week lives there, and nowhere else. It arrives in the thread on
 * the first opening after a week ends (or from the Sunday reminder), and
 * "Your week" opens the sheet whose arrows step back through earlier ones.
 * Approved from a mock-up of exactly this layout.
 *
 * The page reads top down as the rest of Ask Mealo does: what the model
 * wrote, marked AI, then the app's own figures under "Worked out by the
 * app". Each figure carries the week before beside it in grey. No green or
 * red on a change: a colour would be the app praising or scolding a week.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { entryTime } from '../domain/chat';
import { addDays, isoOf } from '../domain/doses';
import { dateLabel } from '../domain/export';
import { duration } from '../domain/fasting';
import {
  basisOf,
  keepWeek,
  keptWeek,
  latestWeek,
  readWeek,
  setWritesItself,
  weekData,
  weekLabel,
  WEEKS_BACK,
  writesItself,
  type KeptWeek,
  type WeekFigures,
} from '../domain/week';
import { chat } from '../llm/adapter';
import { STOPS } from '../safety/gates';
import { readWeekText, weekMessages } from '../safety/weekly';
import type { Settings } from '../settings/store';
import { Chevron, Sheet } from './bits';

type Weeks = { cur: WeekFigures; prev: WeekFigures };

const n = (v: number) => Math.round(v).toLocaleString('en-US');
/** "12 h 05 m": the overnight line's words, short enough for half a phone's width. */
const gap = (ms: number) => duration(ms).replace(/ min$/, ' m');

/** The cells, each with the week before under it where there was one. */
function Figures({ cur, prev }: Weeks) {
  const was = prev.any ? (s: string) => `week before ${s}` : () => '';
  const cells: { v: string; of?: string; l: string; was?: string }[] = [];
  cells.push({ v: String(cur.daysLogged), of: '/ 7', l: 'Days with meals logged', was: was(String(prev.daysLogged)) });
  const kc = cur.macros.energy_kcal;
  if (kc.avg != null) {
    cells.push({ v: n(kc.avg), of: 'Cal', l: kc.target ? `Average · target ${n(kc.target)}` : 'Average, on logged days', was: prev.macros.energy_kcal.avg != null ? was(n(prev.macros.energy_kcal.avg)) : '' });
  }
  const pr = cur.macros.protein_g;
  if (pr.avg != null) {
    cells.push({ v: n(pr.avg), of: 'g', l: pr.target ? `Protein average · target ${n(pr.target)} g` : 'Protein average', was: prev.macros.protein_g.avg != null ? was(`${n(prev.macros.protein_g.avg)} g`) : '' });
  }
  if (cur.doses) {
    cells.push({ v: String(cur.doses.taken), of: `/ ${cur.doses.due}`, l: 'Doses taken', was: prev.doses ? was(`${prev.doses.taken} / ${prev.doses.due}`) : '' });
  }
  if (cur.overnight) {
    cells.push({ v: gap(cur.overnight.ms), l: 'Usual overnight gap', was: prev.overnight ? was(gap(prev.overnight.ms)) : '' });
  }
  // Weight gives way to the gate's own words when its signal fires.
  const w = cur.weight;
  if (w.last && !w.fastLoss) {
    cells.push({
      v: w.last.kg.toFixed(1),
      of: 'kg',
      l: `Last weight, ${dateLabel(w.last.day).split(' ')[0]}`,
      was: w.before ? `${w.before.kg.toFixed(1)} kg on ${dateLabel(w.before.day)}` : '',
    });
  }
  return (
    <>
      <div className="am-figs">
        {cells.map((c) => (
          <div key={c.l}>
            <div className="am-fig-v">
              {c.v} {c.of && <small>{c.of}</small>}
            </div>
            <div className="am-fig-l">{c.l}</div>
            {c.was && <span className="wk-was">{c.was}</span>}
          </div>
        ))}
      </div>
      {w.fastLoss && (
        <div className="am-stop" data-gate="1">
          <div className="am-stop-t">{STOPS['fast-loss'].title}</div>
          <p>{STOPS['fast-loss'].message}</p>
        </div>
      )}
    </>
  );
}

/** One line per symptom, in the patterns view's own words. */
function Symptoms({ cur }: { cur: WeekFigures }) {
  if (cur.symptoms.length === 0) return <div className="wk-sym">No symptoms logged this week</div>;
  return (
    <>
      {cur.symptoms.slice(0, 3).map((s) => (
        <div key={s.label} className="wk-sym">
          {s.label} logged <b>{s.bouts === 1 ? 'once' : `${s.bouts} times`}</b> ·{' '}
          {s.few
            ? 'too few in the month to look for a pattern yet'
            : s.standsOut.length
              ? `${s.standsOut.slice(0, 2).join(', ')} came before it more often`
              : 'nothing stands out before it'}
        </div>
      ))}
    </>
  );
}

function Written({ text, stale, onAgain }: { text: KeptWeek; stale: boolean; onAgain: () => void }) {
  const nothing = !text.lead && text.better.length === 0 && text.workOn.length === 0;
  return (
    <>
      {nothing && <p className="am-a wk-quiet">The model returned nothing the app could keep.</p>}
      {text.lead && <p className="am-a">{text.lead}</p>}
      {text.better.length > 0 && (
        <>
          <div className="wk-h">Better than last week</div>
          <ul className="am-ul">
            {text.better.map((t) => (
              <li key={t}>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {text.workOn.length > 0 && (
        <>
          <div className="wk-h">To work on</div>
          <ul className="am-ul">
            {text.workOn.map((t) => (
              <li key={t}>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {text.removed > 0 && (
        <p className="wk-note">
          The app removed {text.removed} {text.removed === 1 ? 'sentence' : 'sentences'} that did not pass its checks.
        </p>
      )}
      {stale && (
        <p className="wk-note">
          More was logged for this week after this was written.{' '}
          <button className="link" onClick={onAgain}>
            Write it again
          </button>
        </p>
      )}
    </>
  );
}

/**
 * A week: Ask Mealo's lines, then the figures. Shared by the thread's entry
 * and the sheet. `auto` lets it write by itself when the person chose that;
 * only the thread's entry passes it, so stepping back through old weeks
 * never spends a request without a tap.
 */
function WeekBody({ start, settings, auto, weeks: given }: { start: string; settings: Settings | null; auto?: boolean; weeks?: Weeks }) {
  const [weeks, setWeeks] = useState<Weeks | null>(given ?? null);
  const [text, setText] = useState<KeptWeek | null>(null);
  const [itself, setItself] = useState(false);
  const [writing, setWriting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    // Keyed by its week wherever it is drawn, so a new week is a new body
    // and nothing here has to be put back to empty first.
    let live = true;
    void (async () => {
      try {
        const [w, kept, on] = await Promise.all([given ? Promise.resolve(given) : readWeek(start), keptWeek(start), writesItself()]);
        if (!live) return;
        setWeeks(w);
        setText(kept);
        setItself(on);
      } catch (e) {
        if (live) setReadFailed(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [start, given]);

  const write = useCallback(async () => {
    if (!weeks || !settings) return;
    setWriting(true);
    setFailed(null);
    try {
      const data = weekData(weeks.cur, weeks.prev);
      const res = await chat(settings, { messages: weekMessages(data), temperature: 0.2, maxTokens: 500 });
      setText(await keepWeek(start, readWeekText(res.text, data), basisOf(data)));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }, [weeks, settings, start]);

  // Once per showing, and only for a week with something in it.
  useEffect(() => {
    if (!auto || !itself || tried.current || !weeks?.cur.any || text || !settings) return;
    tried.current = true;
    void write();
  }, [auto, itself, weeks, text, settings, write]);

  if (readFailed) return <p className="wk-note">This week could not be read: {readFailed}</p>;
  if (!weeks) return <p className="am-wait">Reading your records…</p>;
  if (!weeks.cur.any) return <p className="wk-sym">Nothing was logged this week.</p>;

  const stale = !!text && text.basis !== basisOf(weekData(weeks.cur, weeks.prev));
  return (
    <>
      <div className="am-src">
        <span className="am-ai">AI</span>
        <span className="am-eyeb">Ask Mealo</span>
      </div>
      {writing ? (
        <p className="am-wait">Writing your week…</p>
      ) : text ? (
        <Written text={text} stale={stale} onAgain={() => void write()} />
      ) : !settings ? (
        <p className="am-a wk-quiet">Ask Mealo writes a few lines about each week once a model provider is set up in Dev.</p>
      ) : (
        <>
          <p className="am-a wk-quiet">
            {failed ? `It could not be written: ${failed}` : 'Not written for this week. One request on your key, with your name and identifiers removed.'}
          </p>
          <div className="wk-links">
            <button className="am-more" onClick={() => void write()}>
              {failed ? 'Try again' : 'Write it'}
            </button>
            {!itself && (
              <button
                className="am-more"
                onClick={async () => {
                  await setWritesItself(true);
                  setItself(true);
                  void write();
                }}
              >
                Write it every week
              </button>
            )}
          </div>
        </>
      )}
      <div className="am-eyeb am-eyeb--app wk-app">
        <i />
        Worked out by the app · against the week before
      </div>
      <Figures {...weeks} />
      <Symptoms cur={weeks.cur} />
    </>
  );
}

/** The week as it arrives in the thread. */
export function WeekEntry({
  at,
  start,
  weeks,
  settings,
  onEarlier,
  onAsk,
}: {
  at: number;
  start: string;
  weeks?: Weeks;
  settings: Settings | null;
  onEarlier: () => void;
  onAsk: (start: string) => void;
}) {
  return (
    <div className="am-entry">
      <div className="am-q">
        <div className="am-q-t">{entryTime(at)} · Your week</div>
        <div className="am-q-x">{weekLabel(start)}</div>
      </div>
      <WeekBody key={start} start={start} settings={settings} weeks={weeks} auto />
      <div className="wk-links">
        <button className="am-more" onClick={onEarlier}>
          <Chevron size={13} />
          Earlier weeks
        </button>
        <button className="am-more" onClick={() => onAsk(start)}>
          Ask about this week
        </button>
      </div>
    </div>
  );
}

/** "Your week": the latest week, and the arrows back through earlier ones. */
export function WeekSheet({
  open,
  back: i,
  onBack,
  settings,
  onClose,
  onAsk,
}: {
  open: boolean;
  /** Weeks back from the latest. */
  back: number;
  onBack: (back: number) => void;
  settings: Settings | null;
  onClose: () => void;
  onAsk: (start: string) => void;
}) {
  const [itself, setItself] = useState(false);
  useEffect(() => {
    if (open) void writesItself().then(setItself);
  }, [open]);

  const start = addDays(latestWeek(isoOf(new Date())), -7 * i);
  return (
    <Sheet open={open} onClose={onClose} label="Your week">
      <div className="am-sh-t">Your week</div>
      <div className="wk-nav">
        <button aria-label="Earlier week" disabled={i >= WEEKS_BACK - 1} onClick={() => onBack(i + 1)}>
          <Chevron size={15} />
        </button>
        <span className="wk-p">{weekLabel(start)}</span>
        <button aria-label="Later week" disabled={i === 0} onClick={() => onBack(i - 1)}>
          <Chevron dir="right" size={15} />
        </button>
      </div>
      <div className="am-entry wk-sheet">{open && <WeekBody key={start} start={start} settings={settings} />}</div>
      <button
        className="lt"
        role="switch"
        aria-checked={itself}
        onClick={async () => {
          await setWritesItself(!itself);
          setItself(!itself);
        }}
      >
        <span className="grow">
          <span className="nm">Write each week by itself</span>
          <span className="amt">When a week ends, the first time you open Ask Mealo. One request a week on your key.</span>
        </span>
        <span className="switch" />
      </button>
      <button
        className="am-btn am-btn--go am-sh-go"
        onClick={() => {
          onClose();
          onAsk(start);
        }}
      >
        Ask about this week
      </button>
    </Sheet>
  );
}
