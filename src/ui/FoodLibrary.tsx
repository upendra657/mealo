/**
 * Your own food table.
 *
 * The reference data that ships with the app is USDA, which does not have dal
 * tadka and never will. This screen is the answer: your dishes, your portions,
 * maintained as a spreadsheet you own and re-imported whenever it changes.
 *
 * The import is deliberately re-runnable. A personal food table is never
 * finished — you add three dishes, correct a weight, import the whole file
 * again. Dishes match on name and portions on (dish, measure), so nothing
 * duplicates and nothing you fixed in the app gets undone by a stale row.
 *
 * Nothing here leaves the device. The file is read in the browser and written
 * to local SQLite; there is no upload, no parsing service, no model call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteCustomFood,
  listCustomFoods,
  type Food,
} from '../domain/foods';
import {
  exportPersonalFoods,
  importPersonalFoods,
  saveDishFromPortion,
  TEMPLATE_CSV,
  type ImportReport,
} from '../domain/import';
import { measureGroups, toMeasure } from '../domain/measures';
import {
  deletePortion,
  portionsForMany,
  resolvePortion,
  setDefaultPortion,
  upsertPortion,
  type Portion,
} from '../domain/portions';

function download(name: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function MeasureSelect({
  value,
  onChange,
  allowBlank = true,
  id,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowBlank?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {allowBlank && <option value="">—</option>}
      {measureGroups().map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.measures.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function FoodLibrary() {
  const [foods, setFoods] = useState<Food[]>([]);
  const [portions, setPortions] = useState<Map<string, Portion[]>>(new Map());
  const [report, setReport] = useState<ImportReport | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const list = await listCustomFoods();
    setFoods(list);
    setPortions(await portionsForMany(list.map((f) => f.id)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runImport = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setReport(await importPersonalFoods(text));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await runImport(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  };

  const shown = filter.trim()
    ? foods.filter((f) => f.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : foods;

  return (
    <div className="stack">
      <section className="card">
        <div className="today-head">
          <h2>My food table</h2>
          <span className="muted small">
            {foods.length} dish{foods.length === 1 ? '' : 'es'}
          </span>
        </div>

        <p className="small muted">
          A CSV with these columns, in any order:{' '}
          <b>Meal/Ingredient · Quantity · Measure · Net weight (g) · Calories ·
          Protein · Fats · Carbs · Fiber</b>. One row per portion — list a dish
          twice to record both its katori and its bowl. Re-import the whole file
          whenever you update it.
        </p>

        <div className="row">
          <button
            className="primary"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Reading…' : 'Import CSV'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            hidden
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <button onClick={() => download('mealo-food-template.csv', TEMPLATE_CSV)}>
            Template
          </button>
          <button
            disabled={foods.length === 0}
            onClick={async () =>
              download(
                `mealo-foods-${new Date().toISOString().slice(0, 10)}.csv`,
                await exportPersonalFoods(),
              )
            }
          >
            Export mine
          </button>
          <button onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : 'Add a dish'}
          </button>
        </div>

        <details style={{ marginTop: 10 }}>
          <summary className="small muted">
            Paste it instead (easier on a phone)
          </summary>
          <label className="field" style={{ marginTop: 8 }}>
            <span>CSV text</span>
            <textarea
              rows={4}
              value={paste}
              placeholder={TEMPLATE_CSV.split('\n').slice(0, 2).join('\n')}
              onChange={(e) => setPaste(e.target.value)}
            />
          </label>
          <button
            onClick={async () => {
              await runImport(paste);
              setPaste('');
            }}
            disabled={busy || !paste.trim()}
          >
            Import pasted text
          </button>
        </details>
      </section>

      {report && <ImportReportCard report={report} onDismiss={() => setReport(null)} />}

      {adding && (
        <AddDish
          onSaved={async () => {
            await refresh();
            setAdding(false);
          }}
        />
      )}

      <section className="card">
        <div className="today-head">
          <h2>Dishes</h2>
          {foods.length > 6 && (
            <input
              aria-label="Filter dishes"
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ maxWidth: 160 }}
            />
          )}
        </div>

        {foods.length === 0 ? (
          <p className="muted small">
            Nothing yet. Import your sheet, or add a dish above — after that it
            matches by name every time you log it, with no model call.
          </p>
        ) : shown.length === 0 ? (
          <p className="muted small">Nothing matches “{filter}”.</p>
        ) : (
          <ul className="med-list">
            {shown.map((f) => (
              <DishRow
                key={f.id}
                food={f}
                portions={portions.get(f.id) ?? []}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ImportReportCard({
  report,
  onDismiss,
}: {
  report: ImportReport;
  onDismiss: () => void;
}) {
  const bad = report.issues.length > 0 || report.missingColumns.length > 0;
  return (
    <section className={bad ? 'card result--warn' : 'card'}>
      <div className="today-head">
        <h2>Import</h2>
        <button className="link" onClick={onDismiss}>
          dismiss
        </button>
      </div>
      <p>
        {report.rowsRead} row{report.rowsRead === 1 ? '' : 's'} read ·{' '}
        <b>{report.dishesCreated}</b> new dish
        {report.dishesCreated === 1 ? '' : 'es'} · {report.dishesUpdated} updated ·{' '}
        {report.portionsSaved} portion{report.portionsSaved === 1 ? '' : 's'}.
      </p>

      {report.missingColumns.length > 0 && (
        <p className="small">
          <b>Columns I couldn't find:</b> {report.missingColumns.join(', ')}. Rows
          without a net weight can't be converted to per-100g.
        </p>
      )}
      {report.unmatchedColumns.length > 0 && (
        <p className="small muted">
          Ignored columns: {report.unmatchedColumns.join(', ')}.
        </p>
      )}

      {report.issues.length > 0 && (
        <>
          <p className="small">
            <b>Rows I couldn't use</b>
          </p>
          <ul className="small">
            {report.issues.slice(0, 12).map((i, n) => (
              <li key={n}>
                line {i.line}: {i.text}
              </li>
            ))}
          </ul>
          {report.issues.length > 12 && (
            <p className="small muted">…and {report.issues.length - 12} more.</p>
          )}
        </>
      )}

      {report.warnings.length > 0 && (
        <>
          <p className="small">
            <b>Worth a look</b>
          </p>
          <ul className="small muted">
            {report.warnings.slice(0, 8).map((w, n) => (
              <li key={n}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const NUMBERS = [
  ['energy', 'kcal'],
  ['protein', 'protein'],
  ['fat', 'fat'],
  ['carbs', 'carbs'],
  ['fibre', 'fibre'],
] as const;

function AddDish({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [measure, setMeasure] = useState<string | null>('katori');
  const [weight, setWeight] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const n = (s: string | undefined) =>
    s === undefined || s.trim() === '' ? null : Number(s);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await saveDishFromPortion({
        name,
        quantity: Number(quantity) || 1,
        measure,
        netWeightG: n(weight),
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
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Add a dish</h2>
      <p className="small muted">
        Describe one portion you actually eat. Everything else — half of it,
        three of them, the same dish in a bowl — is worked out from this.
      </p>

      <label className="field">
        <span>Dish</span>
        <input
          value={name}
          placeholder="dal tadka"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="portion-row">
        <label>
          <span>quantity</span>
          <input
            type="number"
            step="0.25"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          <span>measure</span>
          <MeasureSelect value={measure} onChange={setMeasure} allowBlank={false} />
        </label>
        <label>
          <span>weighs (g)</span>
          <input
            type="number"
            value={weight}
            placeholder="150"
            onChange={(e) => setWeight(e.target.value)}
          />
        </label>
      </div>

      <p className="small muted" style={{ margin: '4px 0 8px' }}>
        Macros for that portion, exactly as your sheet has them — not per 100g.
      </p>
      <div className="macro-inputs">
        {NUMBERS.map(([k, lbl]) => (
          <label key={k}>
            <span>{lbl}</span>
            <input
              type="number"
              value={vals[k] ?? ''}
              placeholder="—"
              onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
            />
          </label>
        ))}
      </div>

      {problem && <p className="small bad">{problem}</p>}

      <div className="row">
        <button
          className="primary"
          disabled={busy || !name.trim() || !weight}
          onClick={() => void save()}
        >
          Save dish
        </button>
      </div>
    </section>
  );
}

function DishRow({
  food,
  portions,
  onChanged,
}: {
  food: Food;
  portions: Portion[];
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [measure, setMeasure] = useState<string | null>('katori');
  const [weight, setWeight] = useState('');

  const anchors = portions.map((p) => ({
    measure: p.measure,
    quantity: p.quantity,
    net_weight_g: p.net_weight_g,
    is_default: p.is_default,
  }));

  const per = (p: Portion) =>
    Math.round((p.net_weight_g / (p.quantity || 1)) * 10) / 10;

  const kcalFor = (grams: number) =>
    food.energy_kcal === null
      ? null
      : Math.round((food.energy_kcal * grams) / 100);

  return (
    <li className="med">
      <div className="grow">
        <div className="dose-name">
          {food.name}
          <span className="dose-amt">
            {food.energy_kcal ?? '?'} kcal/100g
          </span>
        </div>

        <p className="muted small" style={{ margin: '2px 0' }}>
          {portions.length === 0 ? (
            <>no portion recorded — logged by weight, or 100g assumed</>
          ) : (
            portions.map((p, i) => {
              const m = toMeasure(p.measure);
              return (
                <span key={p.id}>
                  {i > 0 && ' · '}
                  <b>{m?.label ?? p.measure}</b> {per(p)}g
                  {kcalFor(per(p)) !== null && <> ({kcalFor(per(p))} kcal)</>}
                  {p.is_default ? ' ★' : ''}
                  {p.source === 'derived' ? ' ~' : ''}
                </span>
              );
            })
          )}
        </p>

        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? 'done' : 'portions'}
        </button>

        {open && (
          <div className="portions-edit">
            {portions.length > 0 && (
              <ul className="small">
                {portions.map((p) => (
                  <li key={p.id} className="portion-line">
                    <span>
                      {p.quantity === 1 ? '' : `${p.quantity} `}
                      {toMeasure(p.measure)?.label ?? p.measure} = {p.net_weight_g}g
                      {p.source === 'derived' && (
                        <span className="muted"> · learned while logging</span>
                      )}
                    </span>
                    <span>
                      {!p.is_default && (
                        <button
                          className="link"
                          onClick={async () => {
                            await setDefaultPortion(food.id, p.id);
                            await onChanged();
                          }}
                        >
                          make default
                        </button>
                      )}
                      <button
                        className="link"
                        onClick={async () => {
                          await deletePortion(p.id);
                          await onChanged();
                        }}
                      >
                        remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="portion-row">
              <label>
                <span>1 of</span>
                <MeasureSelect
                  value={measure}
                  onChange={setMeasure}
                  allowBlank={false}
                />
              </label>
              <label>
                <span>weighs (g)</span>
                <input
                  type="number"
                  value={weight}
                  placeholder={
                    measure
                      ? String(resolvePortion(1, measure, anchors).grams)
                      : ''
                  }
                  onChange={(e) => setWeight(e.target.value)}
                />
              </label>
              <button
                disabled={!measure || !weight}
                onClick={async () => {
                  await upsertPortion({
                    foodId: food.id,
                    measure: measure as string,
                    quantity: 1,
                    netWeightG: Number(weight),
                    source: 'user',
                  });
                  setWeight('');
                  await onChanged();
                }}
              >
                Record
              </button>
            </div>
            {measure && !weight && (
              <p className="small muted">
                {(() => {
                  const r = resolvePortion(1, measure, anchors);
                  return r.measured
                    ? `Right now 1 ${toMeasure(measure)?.label} works out to ${r.grams}g — ${r.note}.`
                    : `Nothing recorded for this yet, so it would use ${r.grams}g.`;
                })()}
              </p>
            )}
          </div>
        )}
      </div>

      <button
        title="Remove this dish"
        onClick={async () => {
          await deleteCustomFood(food.id);
          await onChanged();
        }}
      >
        Delete
      </button>
    </li>
  );
}
