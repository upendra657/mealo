/**
 * The three pills under the Ask Mealo bar that need no model: Log a meal,
 * Tick my doses, Log a symptom.
 *
 * Each is one question, one card showing exactly what would be written, and
 * one tap. A confirmed card shrinks to a one-line receipt with Undo. They
 * call the same domain functions the Track meals and Track meds screens
 * call, so a meal logged here is the meal you would have logged there.
 *
 * Nothing here is kept in the chat's history. The meal, the ticks and the
 * symptom are saved where they belong; the card that made them lasts for
 * this visit only. Saving cards waits for the tool-calling work, when tool
 * results need storing too and one rule can decide what of either may reach
 * a model.
 */

import { useEffect, useState } from 'react';
import {
  clock,
  dosesAction,
  dosesReceipt,
  entryTime,
  storedReceipt,
  mealSummary,
  nextMark,
  PILLS,
  symptomReceipt,
  type Mark,
  type Pill,
} from '../domain/chat';
import { timeLabel, type PlannedDose } from '../domain/doses';
import { asksAtNight, nightAhead, planReceipt, type NightTomorrow, type PlanAsk } from '../domain/mealplan';
import { buildPlan, dayAhead, savePlan, type DayPlan } from '../domain/mealplanner';
import { deleteMeal, draftFromText, itemsFor, saveMeal, type DraftItem } from '../domain/meals';
import { describeMeasure } from '../domain/measures';
import { markDose, readMedsDay, undoIntake, type Medication } from '../domain/medications';
import { dayLabel } from '../domain/plan';
import { guessSlot, slot } from '../domain/slots';
import { SYMPTOM_GROUPS, suggestLabel } from '../domain/symptomlabels';
import { logSymptom, removeSymptom } from '../domain/symptoms';
import { nightTomorrow, setNightTomorrow } from '../profiles/store';
import { triage } from '../safety/redflags';
import { DoseRow } from './MedLog';
import { Chevron, Sheet, Tick, fmtQty } from './bits';

export type FlowProps = {
  at: number;
  /** What the person typed in answer, or null while the bar is waiting. */
  said: string | null;
  /** Put the words back in the bar to be typed again. */
  onRetype: () => void;
  /** Take the whole thing off the screen: nothing was written. */
  onCancel: () => void;
  /** Something was written or taken back; the caller re-reads the record. */
  onWrote: () => void;
  onAddDish: () => void;
  /** Open Track meals, where what was just logged can be seen. */
  onView?: () => void;
  /**
   * Symptom only: the row already written, when the words were an emergency.
   * The caller writes it, in the tap that sent the words, never this
   * component in an effect: the dev server runs effects twice and that is
   * how one symptom becomes two rows.
   */
  savedId?: string | null;
};

function Asked({ pill, at, said }: { pill: Pill; at: number; said: string | null }) {
  return (
    <>
      <div className="am-q">
        <div className="am-q-t">
          {entryTime(at)} · {PILLS[pill].label}
        </div>
        <div className="am-q-x">{PILLS[pill].asks}</div>
      </div>
      {said !== null && <div className="am-said">{said}</div>}
    </>
  );
}

const ToConfirm = () => (
  <div className="am-eyeb am-eyeb--warn">
    <i />
    To confirm · nothing saved yet
  </div>
);

/** What a confirmed card leaves behind. Undo takes the write back, once. */
function Receipt({ text, onUndo, onView }: { text: string; onUndo: () => Promise<void>; onView?: () => void }) {
  const [undone, setUndone] = useState(false);
  return (
    <div className="am-rcpt" data-undone={undone ? '1' : undefined}>
      {!undone && (
        <span className="am-rcpt-ok">
          <Tick size={12} />
        </span>
      )}
      <span className="grow">{undone ? `Undone: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text}</span>
      {!undone && onView && (
        <button className="am-rcpt-undo" onClick={onView}>
          View
        </button>
      )}
      {!undone && (
        <button
          className="am-rcpt-undo"
          onClick={async () => {
            await onUndo();
            setUndone(true);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ a meal

export function MealFlow({ at, said, onRetype, onCancel, onWrote, onAddDish, onView }: FlowProps) {
  const [draft, setDraft] = useState<DraftItem[] | null>(null);
  const [done, setDone] = useState<{ mealId: string; text: string } | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    if (said === null) return;
    let live = true;
    void draftFromText(said).then((d) => {
      if (live) setDraft(d);
    });
    return () => {
      live = false;
    };
  }, [said]);

  if (done) {
    return (
      <Receipt
        text={done.text}
        onView={onView}
        onUndo={async () => {
          await deleteMeal(done.mealId);
          onWrote();
        }}
      />
    );
  }

  const sum = draft ? mealSummary(draft) : null;
  // Logged as eaten now, in the slot the clock suggests: this pill is for the
  // meal just had. Planning ahead stays on the Track meals screen, where the
  // day and the slot are chosen on purpose.
  const where = slot(guessSlot(now));

  return (
    <div className="am-entry">
      <Asked pill="meal" at={at} said={said} />
      {said !== null && draft && sum && (
        <>
          {sum.action && <ToConfirm />}
          <div className="am-card">
            {draft.length === 0 && <div className="am-hint">Nothing here reads as a dish.</div>}
            {draft.map((it, i) => (
              <div key={i} className="am-li" data-miss={it.food ? undefined : '1'}>
                <span>{it.food?.name ?? it.label}</span>
                <span className="am-li-q">
                  {it.food
                    ? it.quantity && it.unit
                      ? `${fmtQty(it.quantity)} ${describeMeasure(it.unit).toLowerCase()}`
                      : `${Math.round(it.grams)} g`
                    : 'not in your food table'}
                </span>
                {it.food ? (
                  <span className="am-li-k">{Math.round(it.energy_kcal ?? 0)} Cal</span>
                ) : (
                  <button className="am-li-add" onClick={onAddDish}>
                    Add dish
                  </button>
                )}
              </div>
            ))}
            {sum.known > 0 && (
              <div className="am-li am-li--tot">
                <span>
                  {where.label}, {clock(now.getTime())}
                </span>
                <span className="am-li-k">{sum.kcal.toLocaleString('en-US')} Cal</span>
              </div>
            )}
            {sum.hint && <div className="am-hint">{sum.hint}</div>}
            <div className="am-btns">
              <button className="am-btn" onClick={onCancel}>
                Cancel
              </button>
              <button className="am-btn" onClick={onRetype}>
                Change
              </button>
              {sum.action && (
                <button
                  className="am-btn am-btn--go"
                  onClick={async () => {
                    const known = draft.filter((d) => d.food !== null);
                    const mealId = await saveMeal(known, {
                      rawText: said,
                      mealType: where.id,
                      eatenAt: now.getTime(),
                    });
                    // The receipt is written from what Track meals now
                    // holds, read back, not from what the card meant to
                    // save. If the two ever differ the receipt says so.
                    const stored = await itemsFor([mealId]);
                    const kcal = Math.round(stored.reduce((n, i) => n + (i.energy_kcal ?? 0), 0));
                    setDone({ mealId, text: storedReceipt(where.label, stored.length, kcal, known.length) });
                    onWrote();
                  }}
                >
                  {sum.action}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- doses

export function DosesFlow({ at, onCancel, onWrote }: FlowProps) {
  const [due, setDue] = useState<PlannedDose<Medication>[] | null>(null);
  const [day, setDay] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [done, setDone] = useState<{ events: string[]; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void readMedsDay().then((plan) => {
      if (!live) return;
      // Due means its time has come and it has no answer yet. Later today is
      // left out: ticking a night dose at lunch is how a record goes wrong.
      const list = plan.groups.flatMap((g) => g.doses).filter((p) => p.state === 'due');
      setDue(list);
      setDay(plan.day);
      setMarks(list.map(() => null));
    });
    return () => {
      live = false;
    };
  }, []);

  if (done) {
    return (
      <Receipt
        text={done.text}
        onUndo={async () => {
          for (const id of done.events) await undoIntake(id);
          onWrote();
        }}
      />
    );
  }

  const action = dosesAction(marks);
  return (
    <div className="am-entry">
      <Asked pill="doses" at={at} said={null} />
      {due && due.length === 0 && <p className="am-a">Nothing is due right now.</p>}
      {due && due.length > 0 && (
        <>
          <ToConfirm />
          <div className="am-card am-card--doses">
            {due.map((p, i) => (
              <div key={p.dose.id}>
                {(i === 0 || due[i - 1].dose.time_of_day !== p.dose.time_of_day) && (
                  <div className="am-eyeb am-dose-g">{timeLabel(p.dose.time_of_day)}</div>
                )}
                {/* The Meds screen's own row and circle, so a dose is never
                    drawn two ways. Its state here is the card's, not the
                    record's, until the button is pressed. */}
                <DoseRow
                  p={{ ...p, state: marks[i] ?? 'due' }}
                  time={timeLabel(p.dose.time_of_day)}
                  onTick={() => setMarks((m) => m.map((x, n) => (n === i ? nextMark(x) : x)))}
                />
              </div>
            ))}
            <div className="am-hint">Tap a circle to tick a dose. Tap it again for skipped.</div>
            <div className="am-btns">
              <button className="am-btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                className="am-btn am-btn--go"
                disabled={!action}
                onClick={async () => {
                  const events: string[] = [];
                  for (let i = 0; i < due.length; i++) {
                    const m = marks[i];
                    if (m) events.push(await markDose(due[i], day, m));
                  }
                  setDone({ events, text: dosesReceipt(marks) });
                  onWrote();
                }}
              >
                {action ?? 'Tick doses'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- symptom

export function SymptomFlow({ at, said, onRetype, onCancel, onWrote, savedId }: FlowProps) {
  const [logged, setLogged] = useState<{ id: string; label: string | null } | null>(null);
  const [now] = useState(() => Date.now());
  // What the person picked, kept with the words it was picked for. "Change"
  // sends the words back to the bar, and a label chosen for the old ones
  // must not be waiting on the card when different ones come back.
  const [choice, setChoice] = useState<{ said: string; label: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const flagged = said !== null ? triage(said) : null;
  // An emergency arrives already saved (see savedId), with an Undo. It is the
  // one write in the app made without a confirmation: nobody should be asked
  // to press a button while reading "seek care now". Upendra's decision, and
  // his reason for keeping it at all: what happened is part of what the
  // record is for.
  const stop = flagged && flagged.triggered ? flagged.message : null;

  const suggested = said !== null ? suggestLabel(said) : null;
  const chose = choice !== null && choice.said === said;
  const label = chose ? choice.label : suggested;

  const receipt = (id: string, as: string | null) => (
    <Receipt
      text={symptomReceipt(as)}
      onUndo={async () => {
        await removeSymptom(id);
        onWrote();
      }}
    />
  );

  if (stop) {
    return (
      <div className="am-entry">
        <Asked pill="symptom" at={at} said={said} />
        <div className="am-eyeb am-eyeb--bad">
          <i />
          Stopped by the app · not sent to any AI
        </div>
        <div className="am-stop">
          <div className="am-stop-t">Seek care now</div>
          <p>{stop}</p>
        </div>
        {/* Saved by the screen, in the tap, with the same suggestLabel on the
            same words: nobody was asked to check a label here either. */}
        {savedId && receipt(savedId, suggested)}
      </div>
    );
  }

  if (logged) return receipt(logged.id, logged.label);

  return (
    <div className="am-entry">
      <Asked pill="symptom" at={at} said={said} />
      {said !== null && (
        <>
          <ToConfirm />
          <div className="am-card">
            <div className="am-kv">
              <span className="am-kk">Your words</span>
              <span>{said}</span>
            </div>
            <div className="am-kv">
              <span className="am-kk">Label</span>
              <span className="am-kvv">
                <button
                  className="am-lab"
                  data-none={label ? undefined : '1'}
                  onClick={() => setPicking(true)}
                >
                  {label ?? (chose ? 'No label' : 'Choose a label')}
                  <Chevron dir="down" size={13} />
                </button>
                {/* Says whose the label is. A suggestion that looks like a
                    fact is how "my partner has a cough" gets filed under
                    the wrong person without anyone deciding it. */}
                {!chose && (
                  <span className="am-sug">
                    {suggested
                      ? 'Suggested from your words. Tap to change.'
                      : 'Nothing in the list matched. Choose one, or log it without.'}
                  </span>
                )}
              </span>
            </div>
            <div className="am-kv">
              <span className="am-kk">When</span>
              <span>Now, {clock(now)}</span>
            </div>
            <div className="am-btns">
              <button className="am-btn" onClick={onCancel}>
                Cancel
              </button>
              <button className="am-btn" onClick={onRetype}>
                Change
              </button>
              <button
                className="am-btn am-btn--go"
                onClick={async () => {
                  setLogged({ id: await logSymptom(said, { label: label ?? undefined }), label });
                  onWrote();
                }}
              >
                Log symptom
              </button>
            </div>
          </div>
          <Sheet open={picking} onClose={() => setPicking(false)} label="What kind of symptom?">
            <div className="am-sh-t">What kind of symptom?</div>
            <p className="am-sh-s">One label. Your words are kept as you wrote them.</p>
            <div className="am-labs-all">
              {SYMPTOM_GROUPS.map((g) => (
                <div key={g.group}>
                  <div className="am-eyeb am-sh-l">{g.group}</div>
                  <div className="am-labs">
                    {g.labels.map((l) => (
                      <button
                        key={l}
                        aria-pressed={l === label}
                        onClick={() => {
                          setChoice({ said, label: l });
                          setPicking(false);
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="am-eyeb am-sh-l">None of these</div>
              <div className="am-labs">
                <button
                  data-none="1"
                  aria-pressed={chose && label === null}
                  onClick={() => {
                    setChoice({ said, label: null });
                    setPicking(false);
                  }}
                >
                  No label
                </button>
              </div>
            </div>
          </Sheet>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- a day planned

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Mon 12 Oct", day before month whatever the phone's language says. */
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
};

/**
 * A day of meals put together by the app, to confirm.
 *
 * Not a pill: it is opened by a sentence ("plan tomorrow so I hit 90 g
 * protein"), read by the app, and nothing under the bar asks for one. The
 * card works with no provider set up, because no model takes part: the day
 * is chosen in code from meals already logged (`domain/mealplan.ts`).
 *
 * "Another" steps through the next-nearest days rather than asking for a new
 * one, so every day offered is one the same rule produced and the first is
 * always the nearest.
 *
 * Before NIGHT_ENDS a day counted from today ("tomorrow") is two days, and
 * which one is the person's to say: the first time, the card asks instead of
 * planning, and the answer is kept on their profile. After that it plans
 * straight away and says which reading it used, with Change beside it.
 * Neither day is picked in advance: a default would be the app answering.
 */
export function PlanFlow({
  at,
  said,
  ask,
  onCancel,
  onWrote,
  onView,
}: {
  at: number;
  said: string;
  ask: PlanAsk;
  onCancel: () => void;
  onWrote: () => void;
  onView: (dayStart: number) => void;
}) {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [n, setN] = useState(0);
  const [done, setDone] = useState<{ ids: string[]; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Judged at the moment the request was made, so a card left open past
  // five does not change its question under the person's eyes.
  const night = asksAtNight(ask, new Date(at));
  // undefined while the profile is read; null when they have not been asked.
  const [meant, setMeant] = useState<NightTomorrow | null | undefined>(night ? undefined : null);
  const ahead = !night ? ask.ahead : meant ? nightAhead(ask.ahead, meant) : null;

  useEffect(() => {
    if (!night) return;
    let live = true;
    void nightTomorrow().then((m) => {
      if (live) setMeant(m);
    });
    return () => {
      live = false;
    };
  }, [night]);

  useEffect(() => {
    if (ahead === null) return;
    let live = true;
    void buildPlan({ ...ask, ahead }).then((p) => {
      if (live) setPlan(p);
    });
    return () => {
      live = false;
    };
  }, [ask, ahead]);

  // The only thing that moves the day once the card is open, so the old
  // plan is cleared here rather than in the effect that builds the new one.
  const choose = async (m: NightTomorrow) => {
    await setNightTomorrow(m);
    setPlan(null);
    setN(0);
    setMeant(m);
  };

  if (night && meant === null) {
    const begun = dayAhead(nightAhead(ask.ahead, 'begun'), new Date(at));
    const after = dayAhead(ask.ahead, new Date(at));
    // For "tomorrow" the two are named by what they are; for "day after
    // tomorrow" or "in 3 days" by where the count starts.
    const one = ask.ahead === 1;
    return (
      <div className="am-entry">
        <div className="am-q">
          <div className="am-q-t">{entryTime(at)} · Plan a day</div>
          <div className="am-q-x">Which day?</div>
        </div>
        <div className="am-said">{said}</div>
        <div className="am-card">
          <div className="am-hint am-hint--lead">
            It is {clock(at)} on {DAYS_LONG[new Date(at).getDay()]}. After midnight, "tomorrow" means the day that has
            just begun to some people, and the day after it to others. Which do you mean?
          </div>
          <div className="am-opts am-opts--days">
            <button className="am-opt" onClick={() => void choose('begun')}>
              <div className="am-opt-t">{shortDate(begun)}</div>
              <div className="am-opt-d">{one ? 'The day that has just begun' : 'Counting from the day that has just begun'}</div>
            </button>
            <button className="am-opt" onClick={() => void choose('after')}>
              <div className="am-opt-t">{shortDate(after)}</div>
              <div className="am-opt-d">{one ? 'The day after it' : 'Counting from the day after it'}</div>
            </button>
          </div>
          <div className="am-hint">
            Mealo remembers your answer for plans made after midnight. You can change it on any of them.
          </div>
          <div className="am-btns">
            <button className="am-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const nightLine = night && meant && (
    <div className="am-hint am-hint--lead">
      After midnight, "tomorrow" is {meant === 'begun' ? 'the day that has just begun' : 'the day after the one that has just begun'}, as you
      chose.{' '}
      <button className="am-see-link" onClick={() => void choose(meant === 'begun' ? 'after' : 'begun')}>
        Change
      </button>
    </div>
  );

  if (done && plan) {
    return (
      <Receipt
        text={done.text}
        onView={() => onView(plan.dayStart)}
        onUndo={async () => {
          for (const id of done.ids) await deleteMeal(id);
          onWrote();
        }}
      />
    );
  }

  const choice = plan?.choices[n] ?? null;
  const when = plan ? [dayLabel(plan.dayStart), shortDate(plan.dayStart)].filter(Boolean).join(', ') : '';

  return (
    <div className="am-entry">
      <div className="am-q">
        <div className="am-q-t">{entryTime(at)} · Plan a day</div>
        <div className="am-q-x">{when || 'Putting a day together'}</div>
      </div>
      <div className="am-said">{said}</div>
      {plan && !choice && (
        <div className="am-card">
          {nightLine}
          <div className="am-hint">{plan.empty}</div>
          <div className="am-btns">
            <button className="am-btn" onClick={onCancel}>
              Close
            </button>
          </div>
        </div>
      )}
      {plan && choice && (
        <>
          <ToConfirm />
          <div className="am-card am-card--doses">
            {nightLine}
            {choice.meals.map((m) => (
              <div key={m.slot}>
                <div className="am-eyeb am-dose-g">{slot(m.slot).label}</div>
                {m.items.map((it, i) => (
                  <div key={i} className="am-li">
                    <span>{it.label}</span>
                    <span className="am-li-q">
                      {it.quantity && it.unit && it.unit !== 'g'
                        ? `${fmtQty(it.quantity)} ${describeMeasure(it.unit).toLowerCase()}`
                        : `${Math.round(it.grams)} g`}
                    </span>
                    <span className="am-li-k">{Math.round(it.energy_kcal ?? 0)} Cal</span>
                  </div>
                ))}
              </div>
            ))}
            <div className="am-li am-li--tot">
              <span>{plan.kept.length ? 'The day, with what is already there' : 'The day'}</span>
              <span className="am-li-k">
                {Math.round(choice.dayTotals.energy_kcal).toLocaleString('en-US')} Cal · {Math.round(choice.dayTotals.protein_g)} g protein
              </span>
            </div>
            {choice.line && <div className="am-hint">{choice.line}</div>}
            {plan.kept.length > 0 && (
              <div className="am-hint">
                Left as it is: {plan.kept.map((k) => slot(k).label.toLowerCase()).join(', ')}.
              </div>
            )}
            <div className="am-hint">
              Each meal is one you logged in the last 28 days, with the same dishes and amounts. Nothing is adjusted to reach a figure.
            </div>
            <div className="am-btns">
              <button className="am-btn" onClick={onCancel}>
                Cancel
              </button>
              {plan.choices.length > 1 && (
                <button className="am-btn" onClick={() => setN((n + 1) % plan.choices.length)}>
                  Another · {n + 1} of {plan.choices.length}
                </button>
              )}
              <button
                className="am-btn am-btn--go"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const ids = await savePlan(plan.dayStart, choice, said);
                    // Written from what Track meals now holds, read back.
                    const stored = await itemsFor(ids);
                    const meant = choice.meals.reduce((c, m) => c + m.items.length, 0);
                    const kcal = stored.reduce((c, i) => c + (i.energy_kcal ?? 0), 0);
                    setDone({ ids, text: planReceipt(shortDate(plan.dayStart), new Set(stored.map((i) => i.meal_id)).size, stored.length, kcal, meant) });
                    onWrote();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Plan this day
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
