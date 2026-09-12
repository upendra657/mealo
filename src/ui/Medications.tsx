/**
 * Managing what you take.
 *
 * Two ways in: type a sentence and let the model structure it, or fill the
 * fields yourself. The model's output is always shown as an editable draft
 * before anything is saved — a misread dose landing silently in a medication
 * list is precisely the error this app must never make.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  addMedicationFromText,
  deleteMedication,
  editMedication,
  listActive,
  listStopped,
  parseMedicationText,
  resumeMedication,
  stopMedication,
  type Medication,
  type MedicationDraft,
} from '../domain/medications';
import { isConfigured, loadSettings, type Settings } from '../settings/store';
import { checkInteractions, type Finding, type LabelStatus } from '../domain/interactions';
import { LlmError } from '../llm/types';

const BLANK: MedicationDraft = {
  name: '',
  dose_text: null,
  schedule: null,
  notes: null,
};

export function Medications({ startAdding = false }: { startAdding?: boolean }) {
  const [active, setActive] = useState<Medication[]>([]);
  const [stopped, setStopped] = useState<Medication[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [adding, setAdding] = useState(startAdding);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<MedicationDraft | null>(null);
  const [rawText, setRawText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(
    null,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [statuses, setStatuses] = useState<LabelStatus[]>([]);
  const [checking, setChecking] = useState(false);

  const runCheck = async (meds: Medication[]) => {
    if (meds.length === 0) return;
    setChecking(true);
    try {
      const r = await checkInteractions(meds);
      setFindings(r.findings);
      setStatuses(r.statuses);
    } catch {
      setFindings([]);
    } finally {
      setChecking(false);
    }
  };

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([listActive(), listStopped()]);
    setActive(a);
    setStopped(s);
  }, []);

  useEffect(() => {
    void refresh();
    void loadSettings().then(setSettings);
  }, [refresh]);

  const canParse = settings ? isConfigured(settings) : false;

  const parse = async () => {
    if (!settings || !text.trim()) return;
    setParsing(true);
    setError(null);
    try {
      const d = await parseMedicationText(settings, text.trim());
      setDraft(d);
      setRawText(text.trim());
    } catch (e) {
      if (e instanceof LlmError) setError({ title: e.message, detail: e.body });
      else setError({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      setParsing(false);
    }
  };

  const save = async () => {
    if (!draft?.name.trim()) return;
    await addMedicationFromText(draft, rawText || draft.name);
    setDraft(null);
    setText('');
    setRawText('');
    setAdding(false);
    await refresh();
  };

  const patchDraft = (p: Partial<MedicationDraft>) =>
    setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <div className="stack">
      {!adding && (
        <button className="primary wide" onClick={() => setAdding(true)}>
          Add a medication or supplement
        </button>
      )}

      {adding && !draft && (
        <section className="card">
          <h2>Add</h2>
          <label className="field">
            <span>Describe it in your own words</span>
            <textarea
              id="med-text"
              rows={2}
              placeholder="creatine 5g every morning"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={() => void parse()}
              disabled={!canParse || parsing || !text.trim()}
            >
              {parsing ? 'Reading…' : 'Read it'}
            </button>
            <button onClick={() => setDraft({ ...BLANK })}>
              Fill in manually
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setText('');
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          {!canParse && (
            <p className="small muted">
              No provider configured yet — use "Fill in manually", or set one up
              in Settings.
            </p>
          )}
          {error && (
            <div className="result result--fail">
              <strong>{error.title}</strong>
              {error.detail && <pre>{error.detail}</pre>}
              <p className="small">
                You can still add it manually — nothing here depends on the
                model working.
              </p>
            </div>
          )}
        </section>
      )}

      {draft && (
        <section className="card">
          <h2>Check this before saving</h2>
          <p className="muted small">
            Read the dose back carefully. It's stored exactly as written and
            never interpreted.
          </p>
          <label className="field">
            <span>Name</span>
            <input
              id="draft-name"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Dose</span>
            <input
              id="draft-dose"
              value={draft.dose_text ?? ''}
              placeholder="as written, e.g. 5g"
              onChange={(e) => patchDraft({ dose_text: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Schedule</span>
            <input
              id="draft-schedule"
              value={draft.schedule ?? ''}
              placeholder="e.g. every morning"
              onChange={(e) => patchDraft({ schedule: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <input
              id="draft-notes"
              value={draft.notes ?? ''}
              onChange={(e) => patchDraft({ notes: e.target.value })}
            />
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={() => void save()}
              disabled={!draft.name.trim()}
            >
              Save
            </button>
            <button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Back
            </button>
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section className="card">
          <div className="today-head">
            <h2>Label check</h2>
            <button
              onClick={() => void runCheck(active)}
              disabled={checking}
            >
              {checking ? 'Checking…' : findings ? 'Re-check' : 'Check labels'}
            </button>
          </div>
          <p className="muted small">
            Reads the FDA label for each item and reports whether it names
            anything else you take. It does not judge severity — that is a
            pharmacist's call. Cached for 30 days; no model involved.
          </p>

          {findings !== null && findings.length === 0 && (
            <p className="small muted">
              Nothing found. That is not the same as nothing existing — many
              products, supplements especially, have no FDA label at all.
            </p>
          )}

          {findings?.map((f, i) => (
            <div key={i} className="policy policy--warn">
              <strong>
                {f.sourceMed}'s label mentions {f.mentions}
              </strong>
              <p>"{f.excerpt}"</p>
              <p className="small muted">
                From the label for <b>{f.productName}</b> ·{' '}
                <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                  source
                </a>{' '}
                · retrieved{' '}
                {new Date(f.retrievedAt).toLocaleDateString()}
              </p>
            </div>
          ))}

          {statuses.filter((s) => s.noLabel).length > 0 && (
            <p className="small muted">
              No FDA label found for:{' '}
              {statuses.filter((s) => s.noLabel).map((s) => s.name).join(', ')}.
            </p>
          )}
        </section>
      )}

      {active.length > 0 && (
        <section className="card">
          <h2>Currently taking</h2>
          <ul className="med-list">
            {active.map((m) => (
              <MedRow
                key={m.id}
                med={m}
                editing={editing === m.id}
                onEdit={() => setEditing(editing === m.id ? null : m.id)}
                onSave={async (p) => {
                  await editMedication(m.id, p);
                  setEditing(null);
                  await refresh();
                }}
                onStop={async () => {
                  await stopMedication(m.id);
                  await refresh();
                }}
              />
            ))}
          </ul>
        </section>
      )}

      {stopped.length > 0 && (
        <section className="card">
          <h2>Stopped</h2>
          <p className="muted small">
            Kept, not deleted — the history still matters.
          </p>
          <ul className="med-list">
            {stopped.map((m) => (
              <li key={m.id} className="med med--stopped">
                <div>
                  <div className="dose-name">{m.name}</div>
                  <p className="muted small">stopped {m.ended_on}</p>
                </div>
                <div className="row">
                  <button
                    onClick={async () => {
                      await resumeMedication(m.id);
                      await refresh();
                    }}
                  >
                    Resume
                  </button>
                  <button
                    onClick={async () => {
                      await deleteMedication(m.id);
                      await refresh();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MedRow({
  med,
  editing,
  onEdit,
  onSave,
  onStop,
}: {
  med: Medication;
  editing: boolean;
  onEdit: () => void;
  onSave: (p: Partial<MedicationDraft>) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [name, setName] = useState(med.name);
  const [dose, setDose] = useState(med.dose_text ?? '');
  const [schedule, setSchedule] = useState(med.schedule ?? '');

  if (!editing) {
    return (
      <li className="med">
        <div>
          <div className="dose-name">
            {med.name}
            {med.dose_text && <span className="dose-amt">{med.dose_text}</span>}
          </div>
          {med.schedule && <p className="muted small">{med.schedule}</p>}
          {med.notes && <p className="muted small">{med.notes}</p>}
        </div>
        <div className="row">
          <button onClick={onEdit}>Edit</button>
          <button onClick={() => void onStop()}>Stop</button>
        </div>
      </li>
    );
  }

  return (
    <li className="med med--editing">
      <div className="grow">
        <label className="field">
          <span>Name</span>
          <input
            id={`edit-name-${med.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Dose</span>
          <input
            id={`edit-dose-${med.id}`}
            value={dose}
            onChange={(e) => setDose(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Schedule</span>
          <input
            id={`edit-schedule-${med.id}`}
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            className="primary"
            onClick={() =>
              void onSave({ name, dose_text: dose, schedule })
            }
          >
            Save
          </button>
          <button onClick={onEdit}>Cancel</button>
        </div>
      </div>
    </li>
  );
}
