/**
 * "Before bloating": what came before a symptom, from the mock-up he
 * approved on 15 Oct 2026. Every figure is worked out in domain/patterns.ts,
 * the calculation Ask Mealo's lookup uses too; this file only draws it.
 *
 * The caution is on every result, not behind a tap: the one misreading this
 * screen invites is "paneer causes my bloating, stop eating it", and the
 * place to say otherwise is next to the bar that suggests it.
 */

import { useEffect, useState } from 'react';
import { clock } from '../domain/chat';
import { collectExport } from '../domain/export';
import { daysNeeded, DEFAULT_WINDOW, LOOK_DAYS, MIN_BOUTS, patternFor, sharedWords, TAG_WORDS, WINDOWS, type Pattern, type PatternItem, type WindowId } from '../domain/patterns';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (t: number) => {
  const d = new Date(t);
  return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** A name with the words it shares with another name in the list in bold. */
function Name({ name, shared }: { name: string; shared: Set<string> }) {
  const parts = name.split(/([^A-Za-z\u0900-\u097f]+)/);
  return (
    <span className="pt-name">
      {parts.map((w, k) => (shared.has(w.toLowerCase()) ? <b key={k}>{w}</b> : <span key={k}>{w}</span>))}
    </span>
  );
}
/** Items listed per kind before the rest are summed up in a line. */
const SHOWN = 8;

function Row({ i, label, shared }: { i: PatternItem; label: string; shared: Set<string> }) {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%');
  return (
    <div className="pt-row">
      <div className="pt-top">
        <Name name={i.name} shared={shared} />
        <span className="pt-tag" data-k={i.tag}>
          {TAG_WORDS[i.tag]}
        </span>
      </div>
      <div className="pt-bars">
        <span>Before {label}</span>
        <div className="pt-bar">
          <i data-b style={{ width: pct(i.before, i.of) }} />
        </div>
        <span className="pt-n">
          {i.before} of {i.of}
        </span>
        {i.ofOther > 0 ? (
          <>
            <span>Same hours, other days</span>
            <div className="pt-bar">
              <i style={{ width: pct(i.other, i.ofOther) }} />
            </div>
            <span className="pt-n">
              {i.other} of {i.ofOther}
            </span>
          </>
        ) : (
          <span className="pt-none">No other days logged to compare with.</span>
        )}
      </div>
      {i.tag === 'stands-out' && (
        <ul className="pt-dates">
          {i.dates.map((d) => (
            <li key={d.began}>
              {dayOf(d.began)} · {label} {clock(d.began)} · {i.kind === 'food' ? i.name.toLowerCase() : i.name} {clock(d.at)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kind({ title, items, label }: { title: string; items: PatternItem[]; label: string }) {
  if (items.length === 0) return null;
  const rest = items.slice(SHOWN);
  const shared = sharedWords(items.slice(0, SHOWN).map((i) => i.name));
  return (
    <>
      <div className="section-h" style={{ marginTop: 14 }}>
        {title}
      </div>
      {items.slice(0, SHOWN).map((i) => (
        <Row key={`${i.kind}:${i.name}`} i={i} label={label} shared={shared} />
      ))}
      {rest.length > 0 && (
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          And {rest.length} more, none of them more common before {label} than on other days.
        </p>
      )}
    </>
  );
}

export function PatternView({ label, onBack }: { label: string; onBack: () => void }) {
  const [win, setWin] = useState<WindowId>(DEFAULT_WINDOW);
  const [p, setP] = useState<Pattern | null>(null);
  const word = label.toLowerCase();

  useEffect(() => {
    let live = true;
    void collectExport('full', daysNeeded(win)).then((x) => {
      if (live) setP(patternFor(x, label, win, Date.now()));
    });
    return () => {
      live = false;
    };
  }, [label, win]);

  const n = p?.bouts.length ?? 0;
  // Across every bout in the short list: "paneer" before one headache and
  // "paneer" before another is the likeness worth seeing.
  const fewShared = sharedWords((p?.bouts ?? []).flatMap((b) => b.before.map((e) => e.name)));
  const winLabel = WINDOWS.find((w) => w.id === win)!.words;
  return (
    <>
      <button className="link pt-back" onClick={onBack}>
        ‹ Symptom history
      </button>
      <div className="am-sh-t">Before {word}</div>
      <p className="am-sh-s">
        {p === null
          ? 'Working it out…'
          : n === 0
            ? `No ${word} in the last ${LOOK_DAYS} days. Older entries stay in the history.`
            : `${n} ${n === 1 ? 'time' : 'times'} in the last ${LOOK_DAYS} days.${
                p.few ? '' : ` What was eaten or taken in the ${winLabel} before each, against the same hours on other days.`
              }`}
      </p>
      <div className="pt-seg" role="radiogroup" aria-label="How far back to look">
        {WINDOWS.map((w) => (
          <button key={w.id} role="radio" aria-checked={w.id === win} data-on={w.id === win ? '1' : undefined} onClick={() => {
              if (w.id === win) return;
              setP(null);
              setWin(w.id);
            }}>
            {w.label}
          </button>
        ))}
      </div>

      <div className="am-labs-all">
        {p && n > 0 && p.few && (
          <>
            <div className="pt-note" style={{ marginTop: 6 }}>
              Too few to show a pattern: it needs at least {MIN_BOUTS} times of {word} in a month. What came before each is listed,
              nothing more.
            </div>
            {[...p.bouts].reverse().map((b) => (
              <div className="pt-row" key={b.began}>
                <div className="small muted">
                  {dayOf(b.began)} · {clock(b.began)}
                </div>
                <div style={{ fontSize: 14.5, marginTop: 3 }}>
                  {b.before.length === 0 ? (
                    `Nothing logged in the ${winLabel} before it.`
                  ) : (
                    <>
                      Before it:{' '}
                      {b.before.slice(0, 8).map((e, k) => (
                        <span key={k}>
                          {k > 0 && ', '}
                          <Name name={e.name} shared={fewShared} /> ({clock(e.at)}
                          {sameDay(e.at, b.began) ? '' : `, ${dayOf(e.at)}`})
                        </span>
                      ))}
                      {b.before.length > 8 ? ', and more' : ''}
                    </>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {p && !p.few && (
          <>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Compared with {p.foodDays} other days with meals logged{p.medicineDays ? ` and ${p.medicineDays} with doses due` : ''}. Days
              with nothing logged count neither way.
            </p>
            <Kind title="Food" items={p.items.filter((i) => i.kind === 'food')} label={word} />
            <Kind title="Medicines" items={p.items.filter((i) => i.kind === 'medicine')} label={word} />
          </>
        )}

        {p && n > 0 && (
          <div className="pt-note">
            <b>What this can and cannot say.</b> It shows what came before {word} more often than on other days. It cannot show that a
            food or a medicine causes it: sleep, stress, illness and anything not logged play a part too. Before cutting a food out, talk to
            a doctor or a dietitian. Whether to stop or change a medicine is for your doctor.
          </div>
        )}
        {p && !p.few && (
          <details className="pt-how">
            <summary className="small">How this is worked out</summary>
            <p className="small muted">
              For each time {word} began, everything eaten or taken in the {winLabel} before it is counted, and set against the same hours
              of the day on the other days of the month. Something stands out when it came before at least 3 times, at least twice as
              often as on other days, and too often to be chance once every item checked is allowed for (Fisher&rsquo;s exact test).
              Entries within 12 hours of each other count as one time.
            </p>
          </details>
        )}
      </div>
    </>
  );
}
