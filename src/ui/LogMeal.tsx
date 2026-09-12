/**
 * Meal logging.
 *
 * Text first, but direct macro entry is a peer, not a fallback — for packaged
 * food and whey, typing four numbers off a label is faster and more accurate
 * than any lookup will ever be.
 *
 * Nothing here calls the model. Local parse, local match, and the totals are
 * arithmetic. That is the Phase 2 target: 80% of meals resolving with zero
 * model calls.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deleteMeal,
  draftFromText,
  guessMealType,
  hasGaps,
  itemsFor,
  localHitRate,
  mealsOn,
  round,
  saveMeal,
  totalMacros,
  type DraftItem,
  type Meal,
  type MealItem,
  type MealType,
} from '../domain/meals';
import { countFoods, scaleMacros, searchFoods, type Food } from '../domain/foods';
import { seedFoods } from '../domain/seed';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

function blankItem(label = ''): DraftItem {
  return {
    label,
    quantity: null,
    unit: null,
    food: null,
    grams: 100,
    matchScore: 0,
    source: 'direct',
    energy_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    fibre_g: null,
  };
}

export function LogMeal() {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<DraftItem[] | null>(null);
  const [mealType, setMealType] = useState<MealType>(guessMealType());
  const [meals, setMeals] = useState<Meal[]>([]);
  const [items, setItems] = useState<MealItem[]>([]);
  const [foodCount, setFoodCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const m = await mealsOn();
    const i = await itemsFor(m.map((x) => x.id));
    setMeals(m);
    setItems(i);
    setFoodCount(await countFoods());
  }, []);

  useEffect(() => {
    void (async () => {
      await seedFoods();
      await refresh();
    })();
  }, [refresh]);

  const read = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setDraft(await draftFromText(text.trim()));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft?.length) return;
    setBusy(true);
    try {
      await saveMeal(draft, { rawText: text.trim() || null, mealType });
      setDraft(null);
      setText('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const patch = (idx: number, p: Partial<DraftItem>) =>
    setDraft((d) => d && d.map((it, i) => (i === idx ? { ...it, ...p } : it)));

  const dayTotals = totalMacros(items);
  const dayGaps = hasGaps(items);

  return (
    <div className="stack">
      {foodCount === 0 && (
        <div className="policy policy--warn">
          <strong>No food reference data loaded</strong>
          <p>
            Text matching has nothing to match against yet. Direct macro entry
            works regardless — that's the button below the text box.
          </p>
          <p className="note small">
            node scripts/import-foods.mjs &lt;usda-csv-dir&gt;
          </p>
        </div>
      )}

      {!draft && (
        <section className="card">
          <h2>Log a meal</h2>
          <label className="field">
            <span>What did you eat?</span>
            <textarea
              id="meal-text"
              rows={2}
              placeholder="2 roti, dal tadka, 1 cup curd"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={() => void read()}
              disabled={busy || !text.trim()}
            >
              {busy ? 'Matching…' : 'Match it'}
            </button>
            <button onClick={() => setDraft([blankItem(text.trim())])}>
              Enter macros directly
            </button>
          </div>
          <p className="small muted">
            Matching runs entirely on your device against the bundled tables —
            no model call, no network, works offline.
          </p>
        </section>
      )}

      {draft && (
        <section className="card">
          <div className="today-head">
            <h2>Check and save</h2>
            <span className="muted small">
              {Math.round(localHitRate(draft) * 100)}% matched locally
            </span>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            {MEAL_TYPES.map((t) => (
              <button
                key={t}
                className={mealType === t ? 'tab active' : 'tab'}
                onClick={() => setMealType(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <ul className="med-list">
            {draft.map((it, i) => (
              <DraftRow
                key={i}
                item={it}
                onChange={(p) => patch(i, p)}
                onRemove={() =>
                  setDraft((d) => d && d.filter((_, j) => j !== i))
                }
              />
            ))}
          </ul>

          <div className="row">
            <button onClick={() => setDraft([...(draft ?? []), blankItem()])}>
              Add item
            </button>
          </div>

          <div className="macro-row">
            {(() => {
              const t = draft.reduce(
                (a, i) => ({
                  energy_kcal: a.energy_kcal + (i.energy_kcal ?? 0),
                  protein_g: a.protein_g + (i.protein_g ?? 0),
                  fat_g: a.fat_g + (i.fat_g ?? 0),
                  carbs_g: a.carbs_g + (i.carbs_g ?? 0),
                  fibre_g: a.fibre_g + (i.fibre_g ?? 0),
                }),
                { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, fibre_g: 0 },
              );
              return (
                <>
                  <Macro label="kcal" value={round(t.energy_kcal)} />
                  <Macro label="protein" value={round(t.protein_g)} unit="g" />
                  <Macro label="fat" value={round(t.fat_g)} unit="g" />
                  <Macro label="carbs" value={round(t.carbs_g)} unit="g" />
                  <Macro label="fibre" value={round(t.fibre_g)} unit="g" />
                </>
              );
            })()}
          </div>

          <div className="row">
            <button className="primary" onClick={() => void save()} disabled={busy}>
              Save meal
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="today-head">
          <h2>Today</h2>
          <span className="muted small">
            {meals.length} meal{meals.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="macro-row">
          <Macro label="kcal" value={round(dayTotals.energy_kcal)} big />
          <Macro label="protein" value={round(dayTotals.protein_g)} unit="g" big />
          <Macro label="fat" value={round(dayTotals.fat_g)} unit="g" big />
          <Macro label="carbs" value={round(dayTotals.carbs_g)} unit="g" big />
          <Macro label="fibre" value={round(dayTotals.fibre_g)} unit="g" big />
        </div>
        {dayGaps && (
          <p className="small muted">
            Some items have no numbers, so these totals are a floor, not a
            measurement.
          </p>
        )}

        {meals.length === 0 ? (
          <p className="muted small">Nothing logged today.</p>
        ) : (
          <ul className="med-list">
            {meals.map((m) => {
              const mine = items.filter((i) => i.meal_id === m.id);
              const t = totalMacros(mine);
              return (
                <li key={m.id} className="med">
                  <div>
                    <div className="dose-name">
                      {m.meal_type}
                      <span className="dose-amt">
                        {new Date(m.eaten_at).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="muted small">
                      {mine.map((i) => i.label).join(', ') || '—'}
                    </p>
                    <p className="muted small">
                      {round(t.energy_kcal)} kcal · P {round(t.protein_g)} · F{' '}
                      {round(t.fat_g)} · C {round(t.carbs_g)} · Fib{' '}
                      {round(t.fibre_g)}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      await deleteMeal(m.id);
                      await refresh();
                    }}
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Macro({
  label,
  value,
  unit,
  big,
}: {
  label: string;
  value: number;
  unit?: string;
  big?: boolean;
}) {
  return (
    <div className={big ? 'macro macro--big' : 'macro'}>
      <span className="macro-val">
        {value}
        {unit && <i>{unit}</i>}
      </span>
      <span className="macro-lbl">{label}</span>
    </div>
  );
}

function DraftRow({
  item,
  onChange,
  onRemove,
}: {
  item: DraftItem;
  onChange: (p: Partial<DraftItem>) => void;
  onRemove: () => void;
}) {
  const [options, setOptions] = useState<Food[]>([]);
  const [searching, setSearching] = useState(false);

  const pick = (food: Food) => {
    onChange({
      food,
      source: 'matched',
      matchScore: 1,
      ...scaleMacros(food, item.grams),
    });
    setOptions([]);
    setSearching(false);
  };

  const setGrams = (grams: number) => {
    if (item.food) onChange({ grams, ...scaleMacros(item.food, grams) });
    else onChange({ grams });
  };

  return (
    <li className="med med--editing">
      <div className="grow">
        <div className="today-head">
          <input
            aria-label="Item"
            value={item.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
          <button onClick={onRemove} title="Remove item">
            ×
          </button>
        </div>

        <p className="small muted" style={{ margin: '6px 0' }}>
          {item.food ? (
            <>
              matched <b>{item.food.name}</b>{' '}
              <span className="dose-amt">
                {Math.round(item.matchScore * 100)}%
              </span>
            </>
          ) : (
            'no match — enter macros below'
          )}
          <button
            className="link"
            style={{ marginLeft: 8 }}
            onClick={async () => {
              setSearching(true);
              setOptions(await searchFoods(item.label));
            }}
          >
            {item.food ? 'change' : 'search'}
          </button>
        </p>

        {searching && options.length > 0 && (
          <ul className="models">
            {options.map((f) => (
              <li key={f.id}>
                <button className="link" onClick={() => pick(f)}>
                  {f.name} — {f.energy_kcal ?? '?'} kcal/100g
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="macro-inputs">
          <label>
            <span>grams</span>
            <input
              type="number"
              value={item.grams}
              onChange={(e) => setGrams(Number(e.target.value) || 0)}
            />
          </label>
          {(
            [
              ['energy_kcal', 'kcal'],
              ['protein_g', 'protein'],
              ['fat_g', 'fat'],
              ['carbs_g', 'carbs'],
              ['fibre_g', 'fibre'],
            ] as const
          ).map(([key, lbl]) => (
            <label key={key}>
              <span>{lbl}</span>
              <input
                type="number"
                value={item[key] ?? ''}
                placeholder="—"
                onChange={(e) =>
                  onChange({
                    [key]: e.target.value === '' ? null : Number(e.target.value),
                    source: item.food ? item.source : 'direct',
                  } as Partial<DraftItem>)
                }
              />
            </label>
          ))}
        </div>
      </div>
    </li>
  );
}
