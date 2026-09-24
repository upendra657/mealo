/**
 * Logging, end to end: which meal → which dish → how much → save.
 *
 * One component for the whole flow because the four steps share one draft,
 * and splitting them across screens would mean lifting that draft somewhere
 * else anyway. Each step renders on its own; back always goes one step, not
 * out of the flow.
 *
 * The rule that shapes everything: **nothing is written until Save.** The "+"
 * beside a recent meal is a shortcut into the dish screen with last time's
 * amount filled in, not a one-tap write. A mis-tap should cost a glance, not
 * a wrong day you have to find and undo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  guessMealType,
  repriceItem,
  saveMeal,
  startOfToday,
  updateMealItem,
  setMealSlot,
  type DraftItem,
  type MealType,
} from '../domain/meals';
import {
  matchFood,
  scaleMacros,
  searchFoods,
  type Food,
} from '../domain/foods';
import { MEASURES, toMeasure } from '../domain/measures';
import { resolveFor, upsertPortion } from '../domain/portions';
import { saveDishFromPortion } from '../domain/import';
import { slot as slotOf, SLOTS, type SlotId } from '../domain/slots';
import { recentItems, type Recent } from '../domain/recents';
import { MealDial } from './MealDial';
import { Chevron, Plus, SearchIcon, Sheet, useToast } from './bits';
import type { Screen } from '../App';

/** Over this in one item, the app asks before writing it. */
const BIG_MEAL = 1000;

const QTYS = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];

const fmtQty = (q: number) => (Number.isInteger(q) ? q.toFixed(1) : String(q));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the Day screen hands over when you tap something already logged.
 * Module-level rather than a prop chain: it is set once, read once, and the
 * alternative is threading an optional object through three components.
 */
export type Draft = {
  mode: 'edit';
  itemId: string;
  mealId: string;
  foodId: string | null;
  label: string;
  quantity: number;
  measure: string | null;
  slot: SlotId;
  step: 'dish';
} | null;

let pending: Draft = null;
export function setDraft(d: Draft) {
  pending = d;
}

type Step = 'slot' | 'search' | 'dish' | 'new';

export function LogFlow({
  go,
  dayStart,
}: {
  go: (s: Screen) => void;
  dayStart: number | null;
}) {
  // Read once, at mount, and clear it: a lazy useState initialiser is the
  // idiomatic capture-once. Reading a ref during render works today but goes
  // wrong the moment anything re-renders before the effect runs.
  const [editing] = useState<Draft>(() => {
    const d = pending;
    pending = null;
    return d;
  });

  const [step, setStep] = useState<Step>(editing ? 'dish' : 'slot');
  const [slot, setSlot] = useState<MealType>(editing?.slot ?? guessMealType());
  const [item, setItem] = useState<DraftItem | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Rehydrate an edit into a live draft item.
  useEffect(() => {
    if (!editing) return;
    void (async () => {
      const match = editing.foodId
        ? await matchFood(editing.label)
        : null;
      const food =
        match && match.food.id === editing.foodId ? match.food : null;
      const res = await resolveFor(editing.foodId, editing.quantity, editing.measure);
      setItem({
        label: editing.label,
        quantity: editing.quantity,
        unit: res.measure,
        food,
        grams: res.grams,
        basis: res.basis,
        portionNote: res.note,
        portionMeasured: res.measured,
        matchScore: food ? 1 : 0,
        source: food ? 'matched' : 'direct',
        ...(food
          ? scaleMacros(food, res.grams)
          : {
              energy_kcal: null,
              protein_g: null,
              fat_g: null,
              carbs_g: null,
              fibre_g: null,
            }),
      });
    })();
  }, [editing]);

  const open = useCallback(async (food: Food, quantity: number, measure: string | null) => {
    const res = await resolveFor(food.id, quantity, measure);
    setItem({
      label: food.name,
      quantity,
      unit: res.measure,
      food,
      grams: res.grams,
      basis: res.basis,
      portionNote: res.note,
      portionMeasured: res.measured,
      matchScore: 1,
      source: 'matched',
      ...scaleMacros(food, res.grams),
    });
    setStep('dish');
  }, []);

  const back = () => {
    if (step === 'dish') {
      if (editing) return go('day');
      setStep('search');
    } else if (step === 'new') setStep('search');
    else if (step === 'search') setStep('slot');
    else go('day');
  };

  const save = async () => {
    if (!item) return;
    setBusy(true);
    try {
      if (editing) {
        await updateMealItem(editing.itemId, item);
        await setMealSlot(editing.mealId, slot);
        toast(`${item.label} updated`);
      } else {
        await saveMeal([item], {
          mealType: slot,
          eatenAt: eatenAt(dayStart),
        });
        toast(`${item.label} added`);
      }
      go('day');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {step === 'slot' && (
        <SlotStep
          slot={slot}
          setSlot={setSlot}
          onCancel={() => go('day')}
          onConfirm={() => setStep('search')}
        />
      )}

      {step === 'search' && (
        <SearchStep
          slot={slot}
          onBack={back}
          onPick={open}
          onNew={() => setStep('new')}
        />
      )}

      {step === 'dish' && item && (
        <DishStep
          item={item}
          setItem={setItem}
          slot={slot}
          setSlot={setSlot}
          editing={!!editing}
          busy={busy}
          onBack={back}
          onSave={save}
        />
      )}

      {step === 'new' && (
        <NewDishStep onBack={back} onCreated={open} />
      )}
    </>
  );
}

/**
 * When a meal logged for a past day actually happened.
 *
 * Today gets the real clock so the order of meals is right. A past day gets
 * midday, because pretending to know that Tuesday's lunch was at 13:42 is
 * inventing a fact; noon is visibly a placeholder.
 */
function eatenAt(dayStart: number | null): number {
  const start = dayStart ?? startOfToday();
  if (start === startOfToday()) return Date.now();
  return start + 12 * 3_600_000;
}

/* ------------------------------------------------------------- slot step */

function SlotStep({
  slot,
  setSlot,
  onCancel,
  onConfirm,
}: {
  slot: MealType;
  setSlot: (s: MealType) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = slotOf(slot);
  return (
    <div className="selector">
      <div className="top" style={{ position: 'relative', zIndex: 2 }}>
        <button className="back" onClick={onCancel}>
          <Chevron />
          Cancel
        </button>
      </div>

      <div className="sel-title">
        <div className="t">{s.label}</div>
        <div className="h">{s.hint}</div>
      </div>

      <MealDial value={slot} onChange={setSlot} onConfirm={onConfirm} />

      <button className="sel-go" onClick={onConfirm}>
        Tap again to continue
        <Chevron size={14} dir="right" />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- search step */

function SearchStep({
  slot,
  onBack,
  onPick,
  onNew,
}: {
  slot: MealType;
  onBack: () => void;
  onPick: (f: Food, q: number, m: string | null) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Food[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void recentItems(slot).then(setRecents);
  }, [slot]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setSearching(true);
    void searchFoods(term, 25).then((r) => {
      if (live) {
        setHits(r);
        setSearching(false);
      }
    });
    return () => {
      live = false;
    };
  }, [q]);

  const term = q.trim();

  return (
    <>
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          {slotOf(slot).label}
        </button>
      </div>

      <div className="search">
        <SearchIcon />
        <input
          id="dish-search"
          value={q}
          placeholder="Search your dishes"
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <button className="row" style={{ width: '100%', marginTop: 9 }} onClick={onNew}>
        <span className="add-mark" aria-hidden="true">
          <Plus size={15} />
        </span>
        <span className="grow" style={{ textAlign: 'left' }}>
          <span className="nm" style={{ display: 'block' }}>
            Add a dish
          </span>
          <span className="amt" style={{ display: 'block' }}>
            Not in the table yet — record it once, it&rsquo;s there for both of you
          </span>
        </span>
      </button>

      {term.length >= 2 ? (
        <>
          <div className="section-h">
            {searching ? 'Searching…' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
          </div>
          {hits.map((f) => (
            <DishRow key={f.id} food={f} onPick={onPick} />
          ))}
          {!searching && hits.length === 0 && (
            <>
              <p className="empty-note">Nothing matches “{term}”.</p>
              <button className="cta" onClick={onNew}>
                Add “{term}” as a dish
              </button>
            </>
          )}
        </>
      ) : (
        <>
          {recents.length > 0 && (
            <>
              <div className="section-h">
                Log again<span className="k">last amount pre-filled</span>
              </div>
              {recents.map((r) => (
                <RecentRow key={r.key} recent={r} onPick={onPick} />
              ))}
            </>
          )}
        </>
      )}

      <div className="foot">
        Pick a dish, set the amount, then save. Nothing is logged before that.
      </div>
    </>
  );
}

function DishRow({
  food,
  onPick,
}: {
  food: Food;
  onPick: (f: Food, q: number, m: string | null) => void;
}) {
  const [anchor, setAnchor] = useState<{ measure: string; grams: number } | null>(null);

  useEffect(() => {
    let live = true;
    void resolveFor(food.id, 1, null).then((r) => {
      if (live && r.measure) setAnchor({ measure: r.measure, grams: r.grams });
    });
    return () => {
      live = false;
    };
  }, [food.id]);

  return (
    <div className="row">
      <button
        className="row-tap"
        onClick={() => onPick(food, 1, anchor?.measure ?? null)}
      >
        <span className="grow">
          <span className="nm" style={{ display: 'block' }}>
            {food.name}
          </span>
          <span className="amt num" style={{ display: 'block' }}>
            {food.energy_kcal === null ? '? ' : Math.round(food.energy_kcal)} Cal/100g
            {anchor
              ? ` · 1 ${toMeasure(anchor.measure)?.label ?? anchor.measure} = ${anchor.grams}g`
              : ''}
          </span>
        </span>
      </button>
    </div>
  );
}

function RecentRow({
  recent,
  onPick,
}: {
  recent: Recent;
  onPick: (f: Food, q: number, m: string | null) => void;
}) {
  const go = async () => {
    const m = await matchFood(recent.label);
    if (m) onPick(m.food, recent.quantity, recent.measure);
  };
  return (
    <div className="row">
      <button className="row-tap" onClick={() => void go()}>
        <span className="grow">
          <span className="nm" style={{ display: 'block' }}>
            {recent.label}
          </span>
          <span className="amt num" style={{ display: 'block' }}>
            {fmtQty(recent.quantity)}{' '}
            {recent.measure ? (toMeasure(recent.measure)?.label ?? recent.measure) : ''}
            {recent.grams ? ` · ${recent.grams}g` : ''}
            {recent.energy ? ` · ${Math.round(recent.energy)} Cal` : ''}
          </span>
        </span>
      </button>
      <button
        className="add-mark"
        title={`Open ${recent.label} at ${fmtQty(recent.quantity)}`}
        onClick={() => void go()}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- dish step */

function DishStep({
  item,
  setItem,
  slot,
  setSlot,
  editing,
  busy,
  onBack,
  onSave,
}: {
  item: DraftItem;
  setItem: (i: DraftItem) => void;
  slot: MealType;
  setSlot: (s: MealType) => void;
  editing: boolean;
  busy: boolean;
  onBack: () => void;
  onSave: () => void;
}) {
  const [picker, setPicker] = useState<'qty' | 'meas' | 'slot' | null>(null);
  const [guard, setGuard] = useState(false);
  const [savedPortion, setSavedPortion] = useState(false);

  const food = item.food;
  const measure = item.unit ? toMeasure(item.unit) : null;
  const kcal = item.energy_kcal ?? 0;

  const reprice = async (change: { quantity?: number; unit?: string | null }) => {
    setItem(await repriceItem(item, change));
  };

  const ownMeasures = food ? [] : [];
  const measureIds = Object.keys(MEASURES);

  const rememberPortion = async () => {
    if (!food || !measure || measure.kind === 'weight') return;
    await upsertPortion({
      foodId: food.id,
      measure: measure.id,
      quantity: item.quantity ?? 1,
      netWeightG: item.grams,
      source: 'user',
    });
    setSavedPortion(true);
  };

  return (
    <>
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          {editing ? 'Today' : 'Search'}
        </button>
        <div className="grow" />
        <button className="slot-pick" onClick={() => setPicker('slot')}>
          {slotOf(slot).label}
          <Chevron size={13} dir="down" />
        </button>
      </div>

      <h2 className="dish-name">{item.label}</h2>
      <div className="dish-sub">
        {food ? (
          <>
            <span className="num">
              {food.energy_kcal === null ? '?' : Math.round(food.energy_kcal)}
            </span>{' '}
            Cal per 100g · your table
          </>
        ) : (
          'No match — the numbers below are whatever you enter'
        )}
      </div>

      <div className="field-lbl">How much did you have</div>
      <div className="amount">
        <button className="afield" onClick={() => setPicker('qty')}>
          <span className="k">Quantity</span>
          <span className="v">
            <span className="t num">{fmtQty(item.quantity ?? 1)}</span>
            <Chevron size={15} dir="down" />
          </span>
        </button>
        <button className="afield" onClick={() => setPicker('meas')}>
          <span className="k">Measure</span>
          <span className="v">
            <span className="t">{measure ? cap(measure.label) : '—'}</span>
            <Chevron size={15} dir="down" />
          </span>
        </button>
      </div>

      <div className="readout">
        <div className="head">
          <span className="cal num">{Math.round(kcal)}</span>
          <span className="cu">Cal</span>
          <span className="wt num">Net wt {item.grams} g</span>
        </div>
        <div className="mlist">
          {(
            [
              ['Protein', item.protein_g],
              ['Fats', item.fat_g],
              ['Carbs', item.carbs_g],
              ['Fibre', item.fibre_g],
            ] as const
          ).map(([label, v]) => (
            <div className="mrow" key={label}>
              <span className="k">{label}</span>
              <span className="v num">{v === null ? '—' : v} g</span>
            </div>
          ))}
        </div>
        <div className="basis">
          <span className={item.portionMeasured ? 'tag tag--known' : 'tag tag--guess'}>
            {item.portionMeasured ? 'yours' : 'estimated'}
          </span>
          <span>{item.portionNote}</span>
          {food && measure && measure.kind !== 'weight' && !item.portionMeasured && !savedPortion && (
            <button className="link" onClick={() => void rememberPortion()}>
              remember this
            </button>
          )}
          {savedPortion && <span> · saved</span>}
        </div>
      </div>

      <button
        className="cta"
        disabled={busy}
        onClick={() => (kcal > BIG_MEAL ? setGuard(true) : onSave())}
      >
        {editing ? 'Save changes' : `Add to ${slotOf(slot).label.toLowerCase()}`}
      </button>
      <button className="cta cta--ghost" onClick={onBack}>
        {editing ? 'Cancel' : 'Back to search'}
      </button>

      <div className="foot">
        Change the quantity or measure and the weight, calories and macros all
        re-derive from your recorded portion.
      </div>

      {/* --- pickers --- */}
      <Sheet open={picker === 'qty'} onClose={() => setPicker(null)} label="Quantity">
        <h3>Quantity</h3>
        <Wheel
          values={QTYS.includes(item.quantity ?? 1) ? QTYS : [...QTYS, item.quantity ?? 1].sort((a, b) => a - b)}
          value={item.quantity ?? 1}
          render={(v) => fmtQty(v as number)}
          onChange={(v) => void reprice({ quantity: v as number })}
        />
        <label className="typed">
          <span>or type it</span>
          <input
            id="qty-typed"
            type="number"
            step="0.05"
            min="0"
            inputMode="decimal"
            value={item.quantity ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) void reprice({ quantity: v });
            }}
          />
        </label>
        <button className="done" onClick={() => setPicker(null)}>
          Done
        </button>
      </Sheet>

      <Sheet open={picker === 'meas'} onClose={() => setPicker(null)} label="Measure">
        <h3>Measure</h3>
        <Wheel
          values={[...ownMeasures, ...measureIds]}
          value={item.unit ?? 'g'}
          render={(v) => cap(toMeasure(v as string)?.label ?? String(v))}
          onChange={(v) => void reprice({ unit: v as string })}
        />
        <button className="done" onClick={() => setPicker(null)}>
          Done
        </button>
      </Sheet>

      <Sheet open={picker === 'slot'} onClose={() => setPicker(null)} label="Which meal">
        <h3>Which meal</h3>
        <Wheel
          values={SLOTS.map((s) => s.id)}
          value={slot}
          render={(v) => slotOf(v as string).label}
          onChange={(v) => setSlot(v as MealType)}
        />
        <button className="done" onClick={() => setPicker(null)}>
          Done
        </button>
      </Sheet>

      {/* --- the big-meal check --- */}
      <Sheet open={guard} onClose={() => setGuard(false)} label="Confirm a large entry">
        <h2 className="guard-title">Cheat meal?</h2>
        <p className="guard-line">
          <b className="num">{Math.round(kcal)}</b> Cal — {fmtQty(item.quantity ?? 1)}{' '}
          {measure ? measure.label : ''} of {item.label}, working out to{' '}
          <span className="num">{item.grams}g</span>.
        </p>
        <p className="guard-hint">No? Check the measurements.</p>
        <button
          className="cta"
          disabled={busy}
          onClick={() => {
            setGuard(false);
            onSave();
          }}
        >
          Confirm, log it
        </button>
        <button className="cta cta--ghost" onClick={() => setGuard(false)}>
          Back, let me fix it
        </button>
      </Sheet>
    </>
  );
}

/* ---------------------------------------------------------------- wheel */

/**
 * The scroll picker.
 *
 * Snap points at a fixed row height, the live value read back from
 * scrollTop. Deliberately not a <select>: on a phone this is the control
 * people already know from every other tracker, and it shows neighbouring
 * values, which a native picker on desktop does not.
 */
function Wheel({
  values,
  value,
  render,
  onChange,
}: {
  values: (string | number)[];
  value: string | number;
  render: (v: string | number) => string;
  onChange: (v: string | number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const ROW = 40;

  useEffect(() => {
    const i = Math.max(0, values.indexOf(value));
    if (ref.current) ref.current.scrollTop = i * ROW;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const i = Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / ROW)));
      if (values[i] !== value) onChange(values[i]);
    }, 90);
  };

  const selected = Math.max(0, values.indexOf(value));

  return (
    <div className="wheel-hold">
      <div className="wheel-rail" />
      <div className="wheel" ref={ref} onScroll={onScroll}>
        <ul>
          {values.map((v, i) => (
            <li key={String(v)} aria-selected={i === selected}>
              {render(v)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ new dish */

function NewDishStep({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (f: Food, q: number, m: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [measure, setMeasure] = useState('katori');
  const [custom, setCustom] = useState('');
  const [weight, setWeight] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const n = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s));
  const measureId = measure === '__custom' ? custom.trim().toLowerCase() : measure;
  const wt = n(weight);
  const qty = Number(quantity) || 1;
  const ready = !!name.trim() && !!measureId && !!wt && wt > 0;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await saveDishFromPortion({
        name,
        quantity: qty,
        measure: measureId,
        netWeightG: wt,
        energy: n(vals.energy),
        protein: n(vals.protein),
        fat: n(vals.fat),
        carbs: n(vals.carbs),
        fibre: n(vals.fibre),
      });
      if (!res.foodId) {
        setProblem(res.issues[0]?.text ?? 'Could not save that.');
        return;
      }
      const m = await matchFood(name);
      if (m) onCreated(m.food, qty, measureId);
    } finally {
      setBusy(false);
    }
  };

  const per100 = ready && wt ? 100 / wt : null;

  return (
    <>
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          Search
        </button>
      </div>

      <h2 className="dish-name">Add a dish</h2>
      <div className="dish-sub">
        One portion you actually eat. Everything else — half of it, three of
        them, the same dish in a bowl — gets worked out from this. It goes into
        the shared table, so it&rsquo;s there for both of you.
      </div>

      <div className="field-lbl">Dish</div>
      <div className="search">
        <input
          id="new-dish-name"
          value={name}
          placeholder="Masala dosa"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field-lbl">One portion</div>
      <div className="card" style={{ padding: '4px 16px' }}>
        <div className="field">
          <label htmlFor="nd-qty">Quantity</label>
          <input
            id="nd-qty"
            type="number"
            step="0.25"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="nd-meas">Measure</label>
          <select id="nd-meas" value={measure} onChange={(e) => setMeasure(e.target.value)}>
            {(['volume', 'count', 'weight'] as const).map((kind) => (
              <optgroup
                key={kind}
                label={kind === 'volume' ? 'Bowls and spoons' : kind === 'count' ? 'Pieces' : 'Weight'}
              >
                {Object.values(MEASURES)
                  .filter((m) => m.kind === kind)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </optgroup>
            ))}
            <option value="__custom">something else…</option>
          </select>
        </div>
        {measure === '__custom' && (
          <div className="field">
            <label htmlFor="nd-custom">Call it</label>
            <input
              id="nd-custom"
              type="text"
              placeholder="vada pav"
              value={custom}
              style={{ textAlign: 'left', fontFamily: 'var(--ui)' }}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="nd-wt">
            Net weight<span className="u">g / ml</span>
          </label>
          <input
            id="nd-wt"
            type="number"
            inputMode="decimal"
            placeholder="—"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </div>
      </div>

      <div className="field-lbl">What that portion contains</div>
      <div className="card" style={{ padding: '4px 16px' }}>
        {(
          [
            ['energy', 'Calories', 'Cal'],
            ['protein', 'Protein', 'g'],
            ['fat', 'Fats', 'g'],
            ['carbs', 'Carbs', 'g'],
            ['fibre', 'Fibre', 'g'],
          ] as const
        ).map(([key, label, unit]) => (
          <div className="field" key={key}>
            <label htmlFor={`nd-${key}`}>
              {label}
              <span className="u">{unit}</span>
            </label>
            <input
              id={`nd-${key}`}
              type="number"
              inputMode="decimal"
              placeholder="—"
              value={vals[key] ?? ''}
              onChange={(e) => setVals((v) => ({ ...v, [key]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      {per100 !== null && wt && (
        <p className="note">
          Stored as{' '}
          <span className="num">
            {vals.energy ? Math.round(Number(vals.energy) * per100) : '—'}
          </span>{' '}
          Cal per 100g, with 1{' '}
          {measureId ? (toMeasure(measureId)?.label ?? measureId) : 'portion'} ={' '}
          <span className="num">{Math.round((wt / qty) * 10) / 10}g</span> kept as its
          anchor. Half of it is{' '}
          <span className="num">{Math.round((wt / qty / 2) * 10) / 10}g</span>.
        </p>
      )}

      {problem && <p className="small bad-text">{problem}</p>}

      <button className="cta" disabled={!ready || busy} onClick={() => void save()}>
        Save and log it
      </button>
      <button className="cta cta--ghost" onClick={onBack}>
        Cancel
      </button>
      <div className="foot">
        Stored per 100g with your portion kept as its anchor — the same shape as
        your spreadsheet rows.
      </div>
    </>
  );
}
