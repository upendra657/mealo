/**
 * Edit dish — the same form as "Add a dish", filled in.
 *
 * Opened from the dish screen in the log flow and from each row of the food
 * table, so a wrong dish can be corrected where it is noticed. The form
 * describes one portion with its contents, exactly as the sheet and the add
 * screen do, rather than asking for per-100g numbers nobody has to hand.
 *
 * Saving a dish that has been logged before asks first whether those entries
 * should be worked out again — see domain/dishedit.ts for why that is the
 * person's call and not the app's.
 */

import { useEffect, useState } from 'react';
import { dishNamed, type Food } from '../domain/foods';
import { per100Of, type Per100 } from '../domain/import';
import { MEASURES, toMeasure } from '../domain/measures';
import { portionsFor, type Portion } from '../domain/portions';
import {
  deleteDish,
  entriesUsing,
  previewEntries,
  saveDishEdit,
  type DishEdit,
  type Entry,
} from '../domain/dishedit';
import { Chevron, fmtQty, Sheet } from './bits';

const NUMBERS = [
  ['energy', 'Calories', 'Cal', 'energy_kcal'],
  ['protein', 'Protein', 'g', 'protein_g'],
  ['fat', 'Fats', 'g', 'fat_g'],
  ['carbs', 'Carbs', 'g', 'carbs_g'],
  ['fibre', 'Fibre', 'g', 'fibre_g'],
] as const;
type Key = (typeof NUMBERS)[number][0];

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const portionLabel = (p: Pick<Portion, 'quantity' | 'measure'>) =>
  `${fmtQty(p.quantity)} ${toMeasure(p.measure)?.label ?? p.measure}`;

export function EditDish({
  food,
  onBack,
  onSaved,
  onDeleted,
}: {
  food: Food;
  onBack: () => void;
  onSaved: (food: Food) => void;
  onDeleted: () => void;
}) {
  const [portions, setPortions] = useState<Portion[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [name, setName] = useState(food.name);
  const [quantity, setQuantity] = useState('1');
  const [measure, setMeasure] = useState('katori');
  const [weight, setWeight] = useState('');
  const [vals, setVals] = useState<Partial<Record<Key, string>>>({});
  /**
   * Whether the weight or the contents were changed. Untouched, the dish keeps
   * the per-100g numbers it had: the contents are shown rounded, and turning
   * them back into per-100g would nudge every number on a save that only
   * meant to fix the name.
   */
  const [touched, setTouched] = useState(false);
  /** Other portions' weights as typed, by portion id. */
  const [otherWt, setOtherWt] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [clash, setClash] = useState<Food | null>(null);
  const [ask, setAsk] = useState<'save' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([portionsFor(food.id), entriesUsing(food.id)]).then(([ps, es]) => {
      if (!live) return;
      setPortions(ps);
      setEntries(es);
      // The default portion fills the form, so a correction starts from what
      // the app has been using. A dish with no portion is described as 100 g.
      const def = ps.find((p) => p.is_default) ?? ps[0];
      const w = def ? def.net_weight_g : 100;
      setQuantity(def ? fmtQty(def.quantity) : '100');
      setMeasure(def ? def.measure : 'g');
      setWeight(String(w));
      const show = (v: number | null) => (v === null ? '' : String(Math.round(((v * w) / 100) * 10) / 10));
      setVals({
        energy: show(food.energy_kcal),
        protein: show(food.protein_g),
        fat: show(food.fat_g),
        carbs: show(food.carbs_g),
        fibre: show(food.fibre_g),
      });
    });
    return () => {
      live = false;
    };
  }, [food]);

  useEffect(() => {
    let live = true;
    void dishNamed(name).then((f) => live && setClash(f && f.id !== food.id ? f : null));
    return () => {
      live = false;
    };
  }, [name, food.id]);

  const n = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s));
  const wt = n(weight);
  const qty = Number(quantity) || 1;
  const ready = !!name.trim() && !!wt && wt > 0 && !clash && !busy;

  const per100: Per100 =
    touched && wt
      ? per100Of(
          {
            line: 1,
            name,
            quantity: qty,
            measure,
            netWeightG: wt,
            energy: n(vals.energy),
            protein: n(vals.protein),
            fat: n(vals.fat),
            carbs: n(vals.carbs),
            fibre: n(vals.fibre),
          },
          wt,
        )
      : {
          energy_kcal: food.energy_kcal,
          protein_g: food.protein_g,
          fat_g: food.fat_g,
          carbs_g: food.carbs_g,
          fibre_g: food.fibre_g,
        };

  // A portion in the form's own measure is the one being edited above, so it
  // is not offered again below. Switch the form from piece to katori and the
  // piece moves down here, kept unless removed.
  const others = portions.filter((p) => p.measure !== toMeasure(measure)?.id);

  const edit: DishEdit = {
    name,
    per100,
    portion: { measure, quantity: qty, netWeightG: wt ?? 0 },
    others: others.map((p) => ({
      id: p.id,
      measure: p.measure,
      quantity: p.quantity,
      netWeightG: removed.has(p.id) ? null : (n(otherWt[p.id]) ?? p.net_weight_g),
    })),
  };

  const commit = async (updateEntries: boolean) => {
    setBusy(true);
    try {
      const res = await saveDishEdit(food.id, edit, updateEntries);
      if (res.clash) {
        setClash(res.clash);
        setAsk(null);
        return;
      }
      if (res.food) onSaved(res.food);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!ready) return;
    if (entries.length > 0) setAsk('save');
    else void commit(false);
  };

  const preview = ask === 'save' ? previewEntries(entries, edit) : null;
  const m = toMeasure(measure);

  return (
    <>
      <div className="top">
        <button className="back" onClick={onBack}>
          <Chevron />
          Back
        </button>
      </div>

      <h2 className="dish-name">Edit dish</h2>
      <div className="dish-sub">
        It&rsquo;s in the shared table, so a change here reaches both of you.
      </div>

      <div className="field-lbl">Dish</div>
      <div className="search">
        <input
          id="edit-dish-name"
          value={name}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {clash && (
        <p className="note">
          You already have <b>{clash.name}</b>. Names that differ only in
          punctuation, capitals or a plural are the same dish.
        </p>
      )}

      <div className="field-lbl">One portion</div>
      <div className="card" style={{ padding: '4px 16px' }}>
        <div className="field">
          <label htmlFor="ed-qty">Quantity</label>
          <input
            id="ed-qty"
            type="number"
            step="0.25"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ed-meas">Measure</label>
          <select id="ed-meas" value={measure} onChange={(e) => setMeasure(e.target.value)}>
            {(['volume', 'count', 'weight'] as const).map((kind) => (
              <optgroup
                key={kind}
                label={kind === 'volume' ? 'Bowls and spoons' : kind === 'count' ? 'Pieces' : 'Weight'}
              >
                {MEASURES
                  // The picker's list, plus the dish's own measure if it is
                  // one that has since been hidden — a dish recorded in roti
                  // has to be able to show it.
                  .filter((x) => x.kind === kind && (!x.hidden || x.id === m?.id))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ed-wt">
            Net weight<span className="u">g / ml</span>
          </label>
          <input
            id="ed-wt"
            type="number"
            inputMode="decimal"
            placeholder="—"
            value={weight}
            onChange={(e) => {
              setWeight(e.target.value);
              setTouched(true);
            }}
          />
        </div>
      </div>

      <div className="field-lbl">What that portion contains</div>
      <div className="card" style={{ padding: '4px 16px' }}>
        {NUMBERS.map(([key, label, unit]) => (
          <div className="field" key={key}>
            <label htmlFor={`ed-${key}`}>
              {label}
              <span className="u">{unit}</span>
            </label>
            <input
              id={`ed-${key}`}
              type="number"
              inputMode="decimal"
              placeholder="—"
              value={vals[key] ?? ''}
              onChange={(e) => {
                setVals((v) => ({ ...v, [key]: e.target.value }));
                setTouched(true);
              }}
            />
          </div>
        ))}
      </div>

      {wt !== null && wt > 0 && (
        <p className="note">
          Stored as{' '}
          <span className="num">
            {per100.energy_kcal === null ? '—' : Math.round(per100.energy_kcal)}
          </span>{' '}
          Cal per 100g
          {m && m.kind !== 'weight' && (
            <>
              , with {fmtQty(qty)} {m.label} ={' '}
              <span className="num">{fmtQty(wt)}g</span> kept as its anchor
            </>
          )}
          .
        </p>
      )}

      {others.length > 0 && (
        <>
          <div className="field-lbl">Other portions</div>
          <div className="card" style={{ padding: '4px 16px' }}>
            {others.map((p) => {
              const gone = removed.has(p.id);
              return (
                <div className="field field--portion" key={p.id}>
                  <label htmlFor={`ed-o-${p.id}`} className={gone ? 'gone' : undefined}>
                    {portionLabel(p)}
                  </label>
                  <input
                    id={`ed-o-${p.id}`}
                    type="number"
                    inputMode="decimal"
                    disabled={gone}
                    value={otherWt[p.id] ?? String(p.net_weight_g)}
                    onChange={(e) => setOtherWt((o) => ({ ...o, [p.id]: e.target.value }))}
                  />
                  <button
                    className="link link--muted"
                    onClick={() =>
                      setRemoved((r) => {
                        const next = new Set(r);
                        if (gone) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                  >
                    {gone ? 'undo' : 'remove'}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <button className="cta" disabled={!ready} onClick={save}>
        Save changes
      </button>
      <button className="cta cta--ghost" onClick={onBack}>
        Cancel
      </button>
      <button className="link link--bad dish-del" onClick={() => setAsk('delete')}>
        Delete dish
      </button>

      <Sheet open={ask === 'save'} onClose={() => setAsk(null)} label="Update past entries">
        {preview && (
          <>
            <h2 className="guard-title">Update past entries?</h2>
            <p className="guard-line">
              You&rsquo;ve logged <b>{food.name}</b>{' '}
              {preview.count === 1 ? 'once' : <><b className="num">{preview.count}</b> times</>},{' '}
              {preview.from !== null && preview.to !== null && day(preview.from) === day(preview.to)
                ? `on ${day(preview.from)}`
                : `${day(preview.from ?? 0)} – ${day(preview.to ?? 0)}`}
              . {preview.count === 1 ? 'It is' : 'They add up to'}{' '}
              <b className="num">{preview.kcalNow}</b> Cal now, and{' '}
              <b className="num">{preview.kcalNew}</b> Cal with the new data.
            </p>
            <p className="guard-hint">
              Quantities and measures stay as you logged them; the name, weight
              and calories are worked out again from the corrected dish. Only
              your entries on this phone.
            </p>
            <button className="cta" disabled={busy} onClick={() => void commit(true)}>
              {preview.count === 1 ? 'Update that entry' : `Update all ${preview.count} entries`}
            </button>
            <button className="cta cta--ghost" disabled={busy} onClick={() => void commit(false)}>
              Keep past entries as they are
            </button>
            <button className="link link--muted sheet-cancel" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </>
        )}
      </Sheet>

      <DeleteDishSheet
        open={ask === 'delete'}
        food={food}
        logged={entries.length}
        onClose={() => setAsk(null)}
        onDeleted={onDeleted}
      />
    </>
  );
}

/**
 * The one confirmation before a dish leaves the table, here and in the food
 * table. Deleting used to be a single unconfirmed tap on a plain word.
 */
export function DeleteDishSheet({
  open,
  food,
  logged,
  onClose,
  onDeleted,
}: {
  open: boolean;
  food: Food;
  /** Entries the selected person logged with it; they keep their numbers. */
  logged: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} label="Delete dish">
      <h2 className="guard-title">Delete {food.name}?</h2>
      <p className="guard-line">It leaves the shared table on both phones.</p>
      <p className="guard-hint">
        {logged === 0
          ? 'Nothing you’ve logged uses it.'
          : logged === 1
            ? 'The entry you logged keeps its name and calories.'
            : `The ${logged} entries you logged keep their name and calories.`}
      </p>
      <button
        className="cta cta--danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await deleteDish(food.id);
            onClose();
            onDeleted();
          } finally {
            setBusy(false);
          }
        }}
      >
        Delete dish
      </button>
      <button className="cta cta--ghost" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
