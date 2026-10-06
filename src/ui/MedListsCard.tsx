/**
 * Dev → Medicine lists: what this phone can suggest medicines from, and the
 * way to add more.
 *
 * Importing is built to be impossible to half-do: nothing is written until
 * the preview has been seen and Import pressed, the list stays invisible until
 * its last row is in, and a failure removes everything it wrote (refdata.ts).
 * The preview runs the same parser the import does, on the file's first rows,
 * so what it shows is what will be stored.
 *
 * A list imported here stays on this phone. It is never synced and never
 * shared; only a medicine somebody saves from one of its suggestions goes into
 * the household library, as their own entry.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteSet,
  importList,
  listSets,
  peek,
  type ImportProgress,
  type ImportResult,
  type RefSet,
} from '../domain/refdata';
import { emptySkips, presetFor, rowsToItems, type Mapping, type Preset } from '../lib/tabular';
import { useToast } from './bits';

type Draft = {
  file: File;
  header: string[];
  rows: string[][];
  preset: Preset | null;
  mapping: Mapping;
  name: string;
  tag: string;
  source_url: string;
  licence: string;
};

const NONE = '';

export function MedListsCard() {
  /** null until read: "No lists yet" flashed up while the query was in flight. */
  const [sets, setSets] = useState<RefSet[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = () => void listSets().then(setSets).catch(() => setSets([]));
  useEffect(load, []);

  const choose = async (file: File) => {
    setError(null);
    setDone(null);
    try {
      const { header, rows } = await peek({ kind: 'file', file });
      const preset = presetFor(header);
      setDraft({
        file,
        header,
        rows,
        preset,
        mapping: preset?.mapping ?? { name: header[0] ?? '', ingredients: [] },
        name: preset?.name ?? file.name.replace(/\.(csv|xlsx)$/i, ''),
        tag: preset?.tag ?? '',
        source_url: preset?.source_url ?? '',
        licence: preset?.licence ?? '',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The preview: the import's own parser over the first rows.
  const preview = useMemo(() => {
    if (!draft) return [];
    return rowsToItems(draft.header, draft.rows, draft.mapping, emptySkips(), new Set()).slice(0, 4);
  }, [draft]);

  const replacing = draft ? sets?.find((s) => !s.builtin && s.name === draft.name.trim()) : undefined;

  const run = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setProgress({ read: 0, imported: 0, skips: emptySkips(), fraction: 0 });
    try {
      const result = await importList(
        { kind: 'file', file: draft.file },
        { name: draft.name, tag: draft.tag, source_url: draft.source_url, licence: draft.licence },
        draft.mapping,
        setProgress,
        replacing?.id ?? null,
      );
      setDone(result);
      setDraft(null);
      toast(`${result.imported.toLocaleString()} medicines imported`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const setMap = (p: Partial<Mapping>) => setDraft((d) => (d ? { ...d, mapping: { ...d.mapping, ...p } } : d));

  return (
    <>
      <div className="section-h">Medicine lists</div>
      <div className="card mlists">
        <p className="small muted" style={{ marginTop: 0 }}>
          What Add meds can fill a medicine in from. Lists stay on this phone — never synced, never
          shared. Only a medicine you save from one goes into the household library.
        </p>

        {sets?.map((s) => (
          <div className="mlist-row" key={s.id}>
            <span className="grow">
              <span className="nm">{s.name}</span>
              <span className="amt num">
                {s.row_count.toLocaleString()} medicines
                {s.builtin ? ' · built in' : s.imported_at ? ` · imported ${new Date(s.imported_at).toLocaleDateString()}` : ''}
              </span>
              {s.licence && <span className="amt">{s.licence}</span>}
            </span>
            <span className="srctag" data-src={s.tag}>{s.tag}</span>
            {!s.builtin && (
              <button
                className="bin"
                aria-label={`Delete ${s.name}`}
                onClick={async () => {
                  await deleteSet(s.id);
                  toast('List deleted');
                  load();
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {sets?.length === 0 && <p className="empty-note">No lists yet.</p>}

        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void choose(f);
          }}
        />
        {!draft && !busy && (
          <button className="cta cta--ghost" onClick={() => fileRef.current?.click()}>
            Import a list (CSV or Excel)
          </button>
        )}

        {draft && !busy && (
          <div className="mimport">
            <div className="field-lbl">
              {draft.preset ? `Recognised: ${draft.preset.name}` : 'Choose its columns'}
            </div>
            {!draft.preset && (
              <>
                <ColumnSelect label="Medicine name" value={draft.mapping.name} header={draft.header}
                  onChange={(v) => setMap({ name: v })} />
                <div className="mcols-lbl">Ingredients — one or more columns</div>
                <div className="chips chips--meds">
                  {draft.header.map((h) => (
                    <button key={h} className="chip" aria-pressed={draft.mapping.ingredients.includes(h)}
                      onClick={() => setMap({
                        ingredients: draft.mapping.ingredients.includes(h)
                          ? draft.mapping.ingredients.filter((x) => x !== h)
                          : [...draft.mapping.ingredients, h],
                      })}>
                      {h}
                    </button>
                  ))}
                </div>
                <ColumnSelect label="Strength (optional)" value={draft.mapping.strength ?? NONE} header={draft.header}
                  optional onChange={(v) => setMap({ strength: v || null })} />
                <ColumnSelect label="Type or pack (optional)" value={draft.mapping.form ?? NONE} header={draft.header}
                  optional onChange={(v) => setMap({ form: v || null })} />
                <ColumnSelect label="Discontinued flag (optional)" value={draft.mapping.discontinued?.column ?? NONE}
                  header={draft.header} optional
                  onChange={(v) => setMap({ discontinued: v ? { column: v, values: ['TRUE', 'true', 'Yes', 'yes', '1'] } : null })} />
              </>
            )}

            <div className="mcols-lbl">How the first rows will be stored</div>
            {preview.length === 0 ? (
              <p className="empty-note">Nothing readable yet — check the name and ingredient columns.</p>
            ) : (
              preview.map((it, i) => (
                <div className="mpreview" key={i}>
                  <b>{it.name}</b> → {it.ingredients.map((x) => (x.strength ? `${x.name} ${x.strength}` : x.name)).join(' + ')}
                </div>
              ))
            )}

            <label className="mfield">
              <span>List name</span>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="mfield">
              <span>Tag on suggestions</span>
              <input value={draft.tag} placeholder="e.g. India, Thailand" maxLength={16}
                onChange={(e) => set({ tag: e.target.value })} />
            </label>
            <label className="mfield">
              <span>Source link</span>
              <input value={draft.source_url} placeholder="where it came from" onChange={(e) => set({ source_url: e.target.value })} />
            </label>
            <label className="mfield">
              <span>Licence</span>
              <input value={draft.licence} placeholder="e.g. CC BY-SA 4.0" onChange={(e) => set({ licence: e.target.value })} />
            </label>

            {replacing && <p className="mnote">Replaces the list of the same name, once this one is fully in.</p>}
            {/\.xlsx$/i.test(draft.file.name) && draft.file.size > 8_000_000 && (
              <p className="mnote">A large Excel file reads slowly on a phone; the same list as CSV imports faster.</p>
            )}

            <button className="cta cta--meds" disabled={!draft.name.trim() || !draft.tag.trim() || preview.length === 0}
              onClick={() => void run()}>
              Import {(draft.file.size / 1_000_000).toFixed(1)} MB
            </button>
            <button className="cta cta--ghost" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        )}

        {progress && (
          <div className="mimport">
            <div className="mmeter mprog"><i style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
            <p className="small muted num">
              {progress.read.toLocaleString()} rows read · {progress.imported.toLocaleString()} medicines so far
            </p>
          </div>
        )}

        {done && (
          <div className="result" style={{ marginTop: 12 }}>
            <strong>{done.imported.toLocaleString()} medicines imported from {done.read.toLocaleString()} rows.</strong>
            {Object.entries(done.skips).some(([, n]) => n > 0) && (
              <p className="small muted">
                Left out:{' '}
                {Object.entries(done.skips).filter(([, n]) => n > 0).map(([why, n]) => `${n.toLocaleString()} ${why}`).join(', ')}.
              </p>
            )}
          </div>
        )}
        {error && (
          <div className="result result--fail" style={{ marginTop: 12 }}>
            <strong>{error}</strong>
            <p className="small muted">Nothing from this file was kept.</p>
          </div>
        )}
      </div>
    </>
  );
}

function ColumnSelect({
  label,
  value,
  header,
  optional = false,
  onChange,
}: {
  label: string;
  value: string;
  header: string[];
  optional?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mfield">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {optional && <option value={NONE}>None</option>}
        {header.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </label>
  );
}
