import { useEffect, useState } from 'react';
import { SyncCard } from './SyncCard';
import { MedListsCard } from './MedListsCard';
import { Chevron } from './bits';
import type { Screen } from '../App';
import {
  loadSettings,
  saveSettings,
  withProvider,
  type Settings,
} from '../settings/store';
import { PROVIDERS, getProvider, policyLabel } from '../llm/providers';
import {
  OUTBOUND_LOG_LIMIT,
  clearOutboundLog,
  getOutboundLog,
  listModels,
  type OutboundEntry,
} from '../llm/adapter';
import { describeRedactions } from '../safety/deidentify';
import { LlmError } from '../llm/types';
import { BackupCard } from './BackupCard';
import { RemindersCard } from './RemindersCard';
import { DEMO } from '../lib/demo';

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
  const [showOutbound, setShowOutbound] = useState(false);
  const [outbound, setOutbound] = useState<OutboundEntry[]>([]);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<null | 'told' | 'left' | 'meds'>(null);
  const flip = (k: NonNullable<typeof open>) => setOpen((o) => (o === k ? null : k));

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

  const allowed = (['nutrition', 'medications', 'symptoms'] as const)
    .map((k) => `${k === 'nutrition' ? 'meals' : k} ${s.allowTrainingProviderFor[k] ? 'yes' : 'no'}`)
    .join(' · ');
  const sent = getOutboundLog().length;

  // The order is the order of how much it matters: the record's safety
  // first, then what rings, what is shared, the AI, and the lists. Reworked
  // on 15 Oct 2026 from the mock-up he approved; see the Dev block in
  // styles.css for what it replaced.
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
      <div className="stack">
        <div className="section-h">This phone</div>
        <BackupCard />

        {/* Neither exists in the demo: there is no relay behind it. Said, not
            just hidden, so nobody looks for them. */}
        {DEMO ? (
          <>
            <div className="section-h">Reminders and household</div>
            <section className="card">
              <p className="small muted" style={{ margin: 0 }}>
                Switched off in the demo. In the real app two phones share a food table through an encrypted relay, and a phone can be
                reminded of due medicines.
              </p>
            </section>
          </>
        ) : (
          <>
            <div className="section-h">Reminders</div>
            <RemindersCard />
            <div className="section-h">Household</div>
            <SyncCard />
          </>
        )}

        <div className="section-h">Ask Mealo</div>
        <section className="card">
          <label className="dv-f">
            <span>Provider</span>
            <select id="provider" value={s.provider} onChange={(e) => patch(withProvider(s, e.target.value))}>
              {PROVIDERS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <span className="dv-tag" data-tone={provider.trains === 'free' ? 'warn' : undefined}>
            {policyLabel(provider.trains).replace(/^./, (c) => c.toUpperCase())}
          </span>
          {provider.note && <p className="note small">{provider.note}</p>}

          <label className="dv-f">
            <span>Base URL</span>
            <input
              id="baseUrl"
              type="url"
              value={s.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </label>
          <label className="dv-f">
            <span>Model</span>
            <input id="model" type="text" value={s.model} placeholder="model-name" onChange={(e) => patch({ model: e.target.value })} />
          </label>
          <label className="dv-f">
            <span>{provider.needsKey ? 'API key, kept in this browser only' : 'API key, not needed'}</span>
            <input
              id="apiKey"
              type="password"
              autoComplete="off"
              value={s.apiKey}
              placeholder={provider.needsKey ? 'sk-…' : 'leave empty'}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
          </label>

          <div className="dv-two">
            <button className="bk-btn" onClick={runTest} disabled={test.kind === 'running'}>
              {test.kind === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="bk-btn bk-btn--go" onClick={save}>
              {savedAt ? 'Saved' : 'Save'}
            </button>
          </div>

          {test.kind === 'ok' && (
            <div className="result result--ok">
              <strong>Reachable — no CORS problem from this origin.</strong>
              <p className="small">
                {test.models.length} model{test.models.length === 1 ? '' : 's'} available.
                {test.models.length > 0 && !test.models.includes(s.model) && ` Note: "${s.model}" is not in the list.`}
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
                Raw response shown deliberately. "Invalid key" can mean a wrong project, a disabled API, a region block or CORS — guessing
                between them costs an evening.
              </p>
            </div>
          )}

          <button className="dv-go" aria-expanded={open === 'told'} onClick={() => flip('told')}>
            <span className="grow">
              What it may be told
              <span className="amt">{provider.trains === 'free' ? allowed : 'This provider does not train on it'}</span>
            </span>
            <Chevron dir={open === 'told' ? 'down' : 'right'} />
          </button>
          {open === 'told' && (
            <div className="dv-in">
              <p className="small">{provider.policy}</p>
              {provider.limits && <p className="muted small">{provider.limits}</p>}
              <p className="muted small">
                The switches below apply only when the provider trains on free-tier data. Whatever they let through, identifiers are not:
                the de-identification boundary in the adapter runs on every payload regardless.
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
            </div>
          )}

          {/* R5's verification view. It used to live in Playground.tsx, which
              nothing imports — a check nobody can reach is not a check. */}
          <button
            className="dv-go"
            aria-expanded={open === 'left'}
            onClick={() => {
              // Read on open rather than held in state, because the log fills
              // from the adapter while this screen is mounted and nothing
              // notifies React when it does.
              setOutbound(getOutboundLog());
              setShowOutbound(open !== 'left');
              flip('left');
            }}
          >
            <span className="grow">
              What left this phone
              <span className="amt">The last {OUTBOUND_LOG_LIMIT} requests, as sent, this session</span>
            </span>
            <span className="n">{sent}</span>
            <Chevron dir={open === 'left' ? 'down' : 'right'} />
          </button>
          {open === 'left' && showOutbound && (
            <div className="dv-in">
              <p className="muted small">
                Every model payload passes the de-identification boundary on its way out, and this is what it sent afterwards, newest
                first, in memory and never saved. Redactions should read none; anything else means something upstream put an identifier
                in a payload and the boundary caught it.
              </p>
              {outbound.length === 0 && <p className="muted small">Nothing sent yet this session. Ask Mealo something and come back.</p>}
              {outbound.map((e, i) => (
                <div key={`${e.at}-${i}`} className="outbound-entry">
                  <div className="small">
                    <span className="num">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                    <span className={e.redactions.length ? 'bad-text' : 'muted'}>
                      {describeRedactions(e.redactions) || 'no redactions'}
                    </span>
                  </div>
                  <pre className="outbound">{JSON.stringify(e.body, null, 2)}</pre>
                </div>
              ))}
              {outbound.length > 0 && (
                <button
                  className="link"
                  onClick={() => {
                    clearOutboundLog();
                    setOutbound([]);
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </section>

        <div className="section-h">Lists</div>
        <section className="card">
          <button className="dv-go" onClick={() => go('library')}>
            <span className="grow">
              My food table
              <span className="amt">Import your sheet, add a dish, check what the app derived</span>
            </span>
            <Chevron dir="right" />
          </button>
          <button className="dv-go" aria-expanded={open === 'meds'} onClick={() => flip('meds')}>
            <span className="grow">
              Medicine lists
              <span className="amt">What Add meds can fill a medicine in from</span>
            </span>
            <Chevron dir={open === 'meds' ? 'down' : 'right'} />
          </button>
          {open === 'meds' && <MedListsCard embedded />}
        </section>
      </div>
    </>
  );
}

