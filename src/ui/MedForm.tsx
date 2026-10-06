/**
 * Add meds, and Edit — one form, because they are one question asked twice.
 *
 * Nothing is written until Save. Choosing a medicine from the household
 * library only fills the form: the schedule it brings is whoever added it
 * first's, and the whole point of opening it here is to change that to what
 * your own doctor said before anything is kept.
 *
 * Two lines under the fields say what Save will do to the shared library,
 * because it is not obvious and it reaches the other phone: a changed name or
 * strength becomes a new entry, and a changed ingredient list changes the
 * entry both of you see.
 */

import { useEffect, useState } from 'react';
import {
  EVERY_DAY,
  FORMS,
  FREQS,
  MAX_DOSES,
  WEEKDAYS,
  amountsSet,
  dateOf,
  fmtDay,
  medDay,
  nextDue,
  ordinal,
  MEALS,
  TIMES,
  UNITS_FOR,
  fmtAmount,
  medSlug,
  resizeDoses,
  sortByTime,
  timeLabel,
  unitFor,
  type DoseSlot,
  type Episode,
  type Form,
  type Freq,
  type Schedule,
  type Unit,
} from '../domain/doses';
import {
  draftFromLibrary,
  searchLibrary,
  type Ingredient,
  type MedForm,
  type Product,
} from '../domain/medications';
import { Bin, Chevron, Plus, SearchIcon, Sheet, Wheel } from './bits';

/**
 * Where prescriptions' amounts actually fall, per unit. The typed box under
 * the wheel is there for anything else — up to TYPED_MAX, past which it is
 * no longer a dose anyone would take.
 */
const LADDERS: Record<Unit, number[]> = {
  tablet: [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10],
  ml: [1, 2, 2.5, 3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30],
  scoop: [0.5, 1, 1.5, 2, 2.5, 3, 4],
  g: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30],
  drop: [1, 2, 3, 4, 5, 6, 8, 10],
};
const TYPED_MAX = 500;

const UNIT_LABEL: Record<Unit, string> = {
  tablet: 'tablets',
  ml: 'ml',
  scoop: 'scoops',
  g: 'grams',
  drop: 'drops',
};

type Picker = { kind: 'amount' | 'time' | 'meal' | 'mday'; i: number } | null;

/**
 * The line under How often: when it is next due, so a schedule picked on a
 * Tuesday says "Next: Sun 11 Oct" and can be checked against the prescription
 * before Save.
 */
function nextLine(s: Schedule): string {
  if (s.freq === 'daily') return '';
  if (s.freq === 'weekdays' && s.days.length === 0) return 'Pick at least one day.';
  const today = medDay();
  // An alternate rhythm with no anchor yet starts the day it is saved.
  const from = s.freq === 'alternate' && !s.from ? { ...s, from: today } : s;
  const next = nextDue(from, today);
  if (!next) return '';
  return next === today ? 'Due today.' : `Next: ${fmtDay(next)}.`;
}

export function MedFormScreen({
  mode,
  initial,
  sickness,
  backLabel,
  onBack,
  onSave,
  sharedEntry = false,
}: {
  mode: 'add' | 'edit';
  initial: MedForm;
  /** The sickness this medicine is for, when it is for one. */
  sickness: Episode | null;
  backLabel: string;
  onBack: () => void;
  onSave: (f: MedForm) => Promise<void>;
  /** Edit only: the entry this medicine points at is in the shared library. */
  sharedEntry?: boolean;
}) {
  const [f, setF] = useState<MedForm>(() => ({
    ...initial,
    schedule: initial.schedule ?? EVERY_DAY,
    doses: initial.doses.length ? sortByTime(initial.doses) : resizeDoses([], 1, initial.form),
  }));
  const [library, setLibrary] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  /** The library entry the form was filled from, as it was when picked. */
  const [picked, setPicked] = useState<MedForm | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'add') return;
    void searchLibrary('').then(setLibrary);
  }, [mode]);

  const patch = (p: Partial<MedForm>) => setF((x) => ({ ...x, ...p }));
  /**
   * Switching frequency starts from today: a weekly medicine set up on a
   * Tuesday defaults to Tuesdays, a monthly one to today's date. An alternate
   * rhythm keeps its old anchor if it already had one, so editing an amount
   * does not move which days are due.
   */
  const setFreq = (freq: Freq) => {
    const today = dateOf(medDay());
    const next: Schedule =
      freq === 'daily' ? EVERY_DAY
      : freq === 'weekdays' ? { freq, days: f.schedule.freq === 'weekdays' ? f.schedule.days : [today.getDay()], from: null }
      : freq === 'monthly' ? { freq, days: f.schedule.freq === 'monthly' ? f.schedule.days : [today.getDate()], from: null }
      : { freq, days: [], from: f.schedule.freq === 'alternate' ? f.schedule.from : null };
    patch({ schedule: next });
  };
  const toggleDay = (d: number) => {
    const has = f.schedule.days.includes(d);
    patch({
      schedule: {
        ...f.schedule,
        days: (has ? f.schedule.days.filter((x) => x !== d) : [...f.schedule.days, d]).sort(),
      },
    });
  };
  const scheduleOk = f.schedule.freq !== 'weekdays' || f.schedule.days.length > 0;
  const setDose = (i: number, p: Partial<DoseSlot>) =>
    setF((x) => ({ ...x, doses: x.doses.map((d, j) => (j === i ? { ...d, ...p } : d)) }));

  const results = query.trim()
    ? library.filter((p) => {
        const hay = `${p.name} ${p.strength_text ?? ''}`.toLowerCase();
        return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
      }).slice(0, 6)
    : [];

  const pick = async (p: Product) => {
    const d = await draftFromLibrary(p.id);
    if (!d) return;
    const filled = { ...d, long_term: false, private: false, doses: d.doses.length ? d.doses : f.doses };
    setF(filled);
    setPicked(filled);
    setQuery('');
  };

  // What Save will do to the shared library, worked out the way the domain
  // does it — by the same key — so the note cannot promise something else.
  const reference = mode === 'edit' ? initial : picked;
  const identityChanged =
    reference !== null && medSlug(f.name, f.strength) !== medSlug(reference.name, reference.strength);
  const ingredientKey = (l: Ingredient[]) =>
    l.filter((i) => i.name.trim()).map((i) => medSlug(i.name, i.strength_text)).join('|');
  const ingredientsChanged =
    reference !== null && !identityChanged &&
    ingredientKey(f.ingredients) !== ingredientKey(reference.ingredients);
  const touchesShared = mode === 'edit' ? sharedEntry : picked !== null;

  // Keep private is a choice made when an entry is created. Picking one the
  // household already has creates nothing, so there is nothing to keep back.
  const showPrivate = mode === 'add' && (picked === null || identityChanged);
  const showLongTerm = sickness === null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...f,
        private: showPrivate ? f.private : false,
        long_term: showLongTerm ? f.long_term : false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const openAmount = (i: number) => {
    setTyped(String(f.doses[i].amount ?? ''));
    setPicker({ kind: 'amount', i });
  };
  const current = picker ? f.doses[picker.i] : null;
  const unit = current?.unit ?? (f.form ? UNITS_FOR[f.form][0] : 'tablet');
  const ladder = LADDERS[unit];
  // What the wheel shows for a dose with no amount yet. Shown, not stored:
  // Done is what commits it, so the number is still one the person chose.
  const shownDefault = ladder.includes(1) ? 1 : ladder[0];
  const amount = current?.amount ?? shownDefault;

  return (
    <>
      <span className="mwash" />
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          {backLabel}
        </button>
      </div>

      <div className="dish-name">{mode === 'edit' ? `Edit ${initial.name}` : 'Add meds'}</div>
      {sickness && (
        <div className="addsub">
          <i />
          For {sickness.name}
        </div>
      )}

      {mode === 'add' && library.length > 0 && (
        <>
          <div className="field-lbl">From your household</div>
          <label className="search">
            <SearchIcon />
            <input
              placeholder="Search medicines already added"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {results.length > 0 && (
            <div className="libres">
              {results.map((p) => (
                <div className="row linkrow" key={p.id}>
                  <button className="row-tap" onClick={() => void pick(p)}>
                    <span className="grow">
                      <span className="nm">
                        {p.name}
                        {p.strength_text && <span className="muted"> {p.strength_text}</span>}
                      </span>
                      <span className="amt">
                        {FORMS.find((x) => x.id === p.form)?.label ?? 'Type not set'}
                      </span>
                    </span>
                    <Chevron dir="right" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {query.trim() && results.length === 0 && (
            <p className="empty-note">Nothing by that name yet — fill it in below.</p>
          )}
        </>
      )}

      <div className="field-lbl">Name</div>
      <div className="search">
        <input
          id="med-name"
          value={f.name}
          placeholder="e.g. Paracetamol"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>

      <div className="field-lbl">Type</div>
      <div className="chips chips--meds">
        {FORMS.map((x) => (
          <button
            key={x.id}
            className="chip"
            aria-pressed={f.form === x.id}
            onClick={() =>
              patch({
                form: x.id,
                doses: f.doses.map((d) => ({ ...d, unit: unitFor(x.id as Form, d.unit) })),
              })
            }
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="field-lbl split">
        Strength <span className="opt">optional</span>
      </div>
      <div className="search">
        <input
          id="med-strength"
          value={f.strength ?? ''}
          placeholder="as written, e.g. 650 mg"
          onChange={(e) => patch({ strength: e.target.value })}
        />
      </div>
      {identityChanged && touchesShared && (
        <p className="mnote">Saves as a new entry in the library. The existing one stays as it is.</p>
      )}

      <div className="field-lbl split">
        Active pharmaceutical ingredients <span className="opt">optional</span>
      </div>
      <div className="ing">
        {f.ingredients.map((ing, i) => (
          <div className="ing-row" key={i}>
            <input
              value={ing.name}
              placeholder="Ingredient"
              aria-label="Ingredient"
              onChange={(e) =>
                patch({
                  ingredients: f.ingredients.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                })
              }
            />
            <input
              className="num"
              value={ing.strength_text ?? ''}
              placeholder="500 mg"
              aria-label="Strength"
              onChange={(e) =>
                patch({
                  ingredients: f.ingredients.map((x, j) =>
                    j === i ? { ...x, strength_text: e.target.value } : x,
                  ),
                })
              }
            />
            <button
              className="bin"
              aria-label={`Remove ${ing.name || 'ingredient'}`}
              onClick={() => patch({ ingredients: f.ingredients.filter((_, j) => j !== i) })}
            >
              <Bin size={15} />
            </button>
          </div>
        ))}
        <button
          className="ing-add"
          onClick={() => patch({ ingredients: [...f.ingredients, { name: '', strength_text: '' }] })}
        >
          <Plus size={15} />
          Add ingredient
        </button>
      </div>
      {ingredientsChanged && touchesShared && (
        <p className="mnote">Changes the ingredients in the household library, for both of you.</p>
      )}

      <div className="field-lbl">How often</div>
      <div className="chips chips--meds">
        {FREQS.map((x) => (
          <button
            key={x.id}
            className="chip"
            aria-pressed={f.schedule.freq === x.id}
            onClick={() => setFreq(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      {f.schedule.freq === 'weekdays' && (
        // Monday first, the way a week is read; stored Sunday-first, the way
        // Date counts.
        <div className="wdays">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <button
              key={d}
              aria-pressed={f.schedule.days.includes(d)}
              aria-label={WEEKDAYS[d]}
              onClick={() => toggleDay(d)}
            >
              {WEEKDAYS[d].charAt(0)}
            </button>
          ))}
        </div>
      )}
      {f.schedule.freq === 'monthly' && (
        <div className="mday">
          <PickField
            k="Day of the month"
            v={ordinal(f.schedule.days[0] ?? 1)}
            onClick={() => setPicker({ kind: 'mday', i: 0 })}
          />
        </div>
      )}
      {nextLine(f.schedule) && <p className="mnote">{nextLine(f.schedule)}</p>}

      <div className="field-lbl">Times a day</div>
      <div className="times">
        {Array.from({ length: MAX_DOSES }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            className="num"
            aria-pressed={f.doses.length === n}
            onClick={() => patch({ doses: resizeDoses(f.doses, n, f.form) })}
          >
            {n}
          </button>
        ))}
      </div>

      {f.doses.map((d, i) => (
        <div className="dslot" key={i}>
          <div className="dk">Dose {i + 1}</div>
          <div className="dgrid">
            <PickField
              k="Amount"
              v={d.amount === null ? 'Set' : fmtAmount(d.amount, d.unit)}
              unset={d.amount === null}
              onClick={() => openAmount(i)}
            />
            <PickField k="Time" v={timeLabel(d.time_of_day)} onClick={() => setPicker({ kind: 'time', i })} />
            <PickField
              k="Meal"
              v={MEALS.find((m) => m.id === d.meal)?.label ?? 'Any'}
              onClick={() => setPicker({ kind: 'meal', i })}
            />
          </div>
        </div>
      ))}

      {showLongTerm && (
        <Toggle
          on={f.long_term}
          onFlip={() => patch({ long_term: !f.long_term })}
          name="Long-Term"
          hint="Keep taking in sick mode"
        />
      )}
      {showPrivate && (
        <Toggle
          on={f.private}
          onFlip={() => patch({ private: !f.private })}
          name="Keep private"
          hint="Not added to the household library"
        />
      )}

      {error && (
        <div className="result result--fail" style={{ marginTop: 18 }}>
          <strong>{error}</strong>
        </div>
      )}

      <button
        className="cta cta--meds"
        disabled={busy || !f.name.trim() || !amountsSet(f.doses) || !scheduleOk}
        onClick={() => void save()}
      >
        Save
      </button>
      <div className="foot" />

      {/* --- pickers --- */}
      <Sheet open={picker?.kind === 'amount'} onClose={() => setPicker(null)} label="Amount">
        <h3>Amount</h3>
        {f.form && UNITS_FOR[f.form].length > 1 && current && (
          <div className="chips chips--meds unit-chips">
            {UNITS_FOR[f.form].map((u) => (
              <button
                key={u}
                className="chip"
                aria-pressed={current.unit === u}
                onClick={() => setDose(picker!.i, { unit: u })}
              >
                {UNIT_LABEL[u]}
              </button>
            ))}
          </div>
        )}
        {picker?.kind === 'amount' && current && (
          <Wheel
            values={ladder.includes(amount) ? ladder : [...ladder, amount].sort((a, b) => a - b)}
            value={amount}
            render={(v) => fmtAmount(v as number, unit)}
            onChange={(v) => {
              setDose(picker!.i, { amount: v as number, unit });
              setTyped(String(v));
            }}
          />
        )}
        <label className="typed">
          <span>or type it</span>
          <input
            type="number"
            step="0.25"
            min="0"
            max={TYPED_MAX}
            inputMode="decimal"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(v) && v > 0 && picker) {
                setDose(picker.i, { amount: Math.min(TYPED_MAX, Math.round(v * 100) / 100), unit });
              }
            }}
          />
        </label>
        <button
          className="done"
          onClick={() => {
            if (picker && current && current.amount === null) {
              setDose(picker.i, { amount, unit });
            }
            setPicker(null);
          }}
        >
          Done
        </button>
      </Sheet>

      <Sheet open={picker?.kind === 'time'} onClose={() => setPicker(null)} label="Time of day">
        <h3>Time of day</h3>
        {picker?.kind === 'time' && current && (
          <Wheel
            values={TIMES.map((t) => t.id)}
            value={current.time_of_day ?? 'morning'}
            render={(v) => timeLabel(v as DoseSlot['time_of_day'])}
            onChange={(v) => setDose(picker!.i, { time_of_day: v as DoseSlot['time_of_day'] })}
          />
        )}
        <button
          className="done"
          onClick={() => {
            // Rows follow the day, so a dose moved to night drops to the end.
            setF((x) => ({ ...x, doses: sortByTime(x.doses) }));
            setPicker(null);
          }}
        >
          Done
        </button>
      </Sheet>

      <Sheet open={picker?.kind === 'mday'} onClose={() => setPicker(null)} label="Day of the month">
        <h3>Day of the month</h3>
        {/* Mounted only while open. Sheets stay mounted when closed, and a
            wheel reports whatever row it settles on: fed the weekday list
            (Sunday is 0, which 1-31 does not have), this one scrolled to
            "1st" behind a closed sheet and quietly made a weekly medicine
            monthly. Every wheel on this form is gated the same way. */}
        {picker?.kind === 'mday' && f.schedule.freq === 'monthly' && (
          <Wheel
            values={Array.from({ length: 31 }, (_, i) => i + 1)}
            value={f.schedule.days[0] ?? 1}
            render={(v) => ordinal(v as number)}
            onChange={(v) => patch({ schedule: { freq: 'monthly', days: [v as number], from: null } })}
          />
        )}
        {(f.schedule.days[0] ?? 1) > 28 && (
          <p className="sk-note" style={{ textAlign: 'center' }}>
            In shorter months, the last day of the month.
          </p>
        )}
        <button className="done" onClick={() => setPicker(null)}>
          Done
        </button>
      </Sheet>

      <Sheet open={picker?.kind === 'meal'} onClose={() => setPicker(null)} label="Meal">
        <h3>Before or after a meal</h3>
        {current && (
          <div className="chips chips--meds unit-chips">
            {MEALS.map((m) => (
              <button
                key={m.id}
                className="chip"
                aria-pressed={current.meal === m.id}
                onClick={() => {
                  setDose(picker!.i, { meal: m.id });
                  setPicker(null);
                }}
              >
                {m.label} meal
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}

function PickField({
  k,
  v,
  unset = false,
  onClick,
}: {
  k: string;
  v: string;
  unset?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="afield" data-unset={unset ? '' : undefined} onClick={onClick}>
      <span className="k">{k}</span>
      <span className="v">
        <span className="t">{v}</span>
        <Chevron size={13} dir="down" />
      </span>
    </button>
  );
}

export function Toggle({
  on,
  onFlip,
  name,
  hint,
}: {
  on: boolean;
  onFlip: () => void;
  name: string;
  hint?: string;
}) {
  return (
    <button className="lt" role="switch" aria-checked={on} onClick={onFlip}>
      <span className="grow">
        <span className="nm">{name}</span>
        {hint && <span className="amt">{hint}</span>}
      </span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}
