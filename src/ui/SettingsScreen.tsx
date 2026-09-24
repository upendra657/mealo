import { useEffect, useState } from 'react';
import { Chevron } from './bits';
import { StatusBar } from './StatusBar';
import type { Screen } from '../App';
import {
  loadSettings,
  saveSettings,
  withProvider,
  type Settings,
} from '../settings/store';
import { PROVIDERS, getProvider, policyLabel } from '../llm/providers';
import { listModels } from '../llm/adapter';
import { LlmError } from '../llm/types';
import { downloadDatabase } from '../db/client';

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; models: string[] }
  | { kind: 'fail'; title: string; detail?: string; status?: number };

export function SettingsScreen({
  go,
  onSaved,
}: {
  go: (s: Screen) => void;
  onSaved?: (s: Settings) => void;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    loadSettings().then(setS);
  }, []);

  if (!s) return <p className="muted">Loading settings…</p>;

  const provider = getProvider(s.provider);

  const patch = (next: Partial<Settings>) => {
    const merged = { ...s, ...next };
    setS(merged);
    setTest({ kind: 'idle' });
  };

  const save = async () => {
    await saveSettings(s);
    setSavedAt(Date.now());
    onSaved?.(s);
  };

  const runTest = async () => {
    setTest({ kind: 'running' });
    try {
      const models = await listModels(s);
      setTest({ kind: 'ok', models });
    } catch (e) {
      if (e instanceof LlmError) {
        setTest({
          kind: 'fail',
          title: e.message,
          detail: e.body,
          status: e.status,
        });
      } else {
        setTest({
          kind: 'fail',
          title: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  return (
    <>
      <div className="top">
        <button className="back" onClick={() => go('home')}>
          <Chevron />
          Home
        </button>
        <div className="grow" />
        <span className="small muted">Dev</span>
      </div>
      <StatusBar />
      <button className="row" style={{ width: '100%' }} onClick={() => go('library')}>
        <span className="grow" style={{ textAlign: 'left' }}>
          <span className="nm" style={{ display: 'block' }}>My food table</span>
          <span className="amt" style={{ display: 'block' }}>
            Import your sheet, add a dish, check what the app derived
          </span>
        </span>
        <Chevron dir="right" />
      </button>
    <div className="stack">
      <section className="card">
        <h2>Model provider</h2>

        <label className="field">
          <span>Provider</span>
          <select
            id="provider"
            value={s.provider}
            onChange={(e) => patch(withProvider(s, e.target.value))}
          >
            {PROVIDERS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <div className={`policy policy--${provider.trains === 'free' ? 'warn' : 'good'}`}>
          <strong>{policyLabel(provider.trains)}</strong>
          <p>{provider.policy}</p>
          {provider.limits && <p className="muted small">{provider.limits}</p>}
          {provider.note && <p className="note small">{provider.note}</p>}
        </div>

        <label className="field">
          <span>Base URL</span>
          <input
            id="baseUrl"
            type="url"
            value={s.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            id="model"
            type="text"
            value={s.model}
            placeholder="model-name"
            onChange={(e) => patch({ model: e.target.value })}
          />
        </label>

        <label className="field">
          <span>
            API key{' '}
            {!provider.needsKey && <em className="muted">— not needed</em>}
          </span>
          <input
            id="apiKey"
            type="password"
            autoComplete="off"
            value={s.apiKey}
            placeholder={provider.needsKey ? 'sk-…' : 'leave empty'}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </label>

        <p className="muted small">
          The key is stored in this browser only, on this device. It identifies
          you to the provider and carries no data — rotating it never touches
          your logs.
        </p>

        <div className="row">
          <button onClick={runTest} disabled={test.kind === 'running'}>
            {test.kind === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          <button className="primary" onClick={save}>
            Save
          </button>
          {savedAt && <span className="muted small">Saved</span>}
        </div>

        {test.kind === 'ok' && (
          <div className="result result--ok">
            <strong>Reachable — no CORS problem from this origin.</strong>
            <p className="small">
              {test.models.length} model{test.models.length === 1 ? '' : 's'}{' '}
              available.
              {test.models.length > 0 &&
                !test.models.includes(s.model) &&
                ` Note: "${s.model}" is not in the list.`}
            </p>
            {test.models.length > 0 && (
              <details>
                <summary className="small">Show models</summary>
                <ul className="models">
                  {test.models.map((m) => (
                    <li key={m}>
                      <button className="link" onClick={() => patch({ model: m })}>
                        {m}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {test.kind === 'fail' && (
          <div className="result result--fail">
            <strong>
              {test.status ? `HTTP ${test.status} — ` : ''}
              {test.title}
            </strong>
            {test.detail && <pre>{test.detail}</pre>}
            <p className="small muted">
              Raw response shown deliberately. "Invalid key" can mean a wrong
              project, a disabled API, a region block or CORS — guessing between
              them costs an evening.
            </p>
          </div>
        )}
      </section>

      <section className="card">
        <h2>What may be sent to a training-enabled provider</h2>
        <p className="muted small">
          Only applies when the selected provider trains on free-tier data.
          Recorded now; enforced at the adapter in Phase 4.
        </p>
        {(['nutrition', 'medications', 'symptoms'] as const).map((k) => (
          <label key={k} className="check">
            <input
              id={`allow-${k}`}
              type="checkbox"
              checked={s.allowTrainingProviderFor[k]}
              onChange={(e) =>
                patch({
                  allowTrainingProviderFor: {
                    ...s.allowTrainingProviderFor,
                    [k]: e.target.checked,
                  },
                })
              }
            />
            <span>{k}</span>
          </label>
        ))}
      </section>

      <section className="card">
        <h2>Your data</h2>
        <p className="muted small">
          Everything you log lives in this browser. Download a copy now and
          again — browsers are allowed to evict storage, and a health log is not
          something you can regenerate.
        </p>
        <div className="row">
          <button onClick={() => void downloadDatabase()}>
            Download database
          </button>
        </div>
      </section>
    </div>
    </>
  );
}
