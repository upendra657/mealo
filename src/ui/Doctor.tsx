/**
 * The Doctor.
 *
 * Two things make this different from a chat box with a medical system prompt:
 *
 *   1. Red-flag triage runs in plain code before any model call. Emergencies
 *      are routed by a regex that cannot be talked out of its judgement.
 *
 *   2. What crosses the network is a de-identified slice assembled from the
 *      local record — no name, no identifiers, no raw symptom text — plus a
 *      rolling summary rather than the full history.
 */

import { Chevron } from './bits';
import type { Screen } from '../App';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendMessage,
  buildContext,
  clearThread,
  loadThread,
  maybeSummarise,
  type StoredMessage,
} from '../llm/conversation';
import { chat } from '../llm/adapter';
import { LlmError } from '../llm/types';
import { isConfigured, loadSettings, type Settings } from '../settings/store';
import { triage } from '../safety/redflags';
import { filterDoses } from '../safety/dosefilter';
import { collectFacts, refreshCurrentState, renderSlice } from '../domain/state';
import { logSymptom, openSymptoms, resolveSymptom, type Symptom } from '../domain/symptoms';

const SYSTEM_PROMPT = [
  'You are the everyday-health assistant inside a personal tracking app.',
  'The person using you is not a patient in your care and you are not a clinician.',
  '',
  'Hard rules:',
  '- Never state or imply a diagnosis. Describe possibilities and what would',
  '  distinguish them.',
  '- Never suggest, calculate, adjust or confirm a dose of anything. Not on',
  '  request, not as an example, not "typically people take". Say that dosing',
  '  is for a pharmacist or prescriber.',
  '- If you are relying on general knowledge about a drug or nutrient rather',
  '  than the record you were given, say so plainly.',
  '- Recommend in-person care whenever the answer would change based on',
  '  something you cannot observe.',
  '',
  'Style: brief, concrete, no hedging padding. Ask one clarifying question when',
  'it would actually change your answer, otherwise answer.',
  '',
  'You are given the actual record below — meals eaten today by name, doses',
  'taken, open symptoms. Use it. If asked about a meal, refer to what was',
  'actually eaten rather than giving general dietary guidance. If the record is',
  'empty, say so instead of answering generically.',
].join('\n');

type Bubble = { role: 'user' | 'assistant' | 'triage'; content: string };

export function Doctor({ go }: { go: (s: Screen) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [thread, setThread] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [slice, setSlice] = useState<string>('');
  const [symptoms, setSymptoms] = useState<Symptom[]>([]);
  const [showSlice, setShowSlice] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const facts = await collectFacts();
    setSlice(renderSlice(facts));
    setSymptoms(await openSymptoms());
    await refreshCurrentState();
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void (async () => {
      const stored = await loadThread('doctor');
      setThread(
        stored
          .filter((m): m is StoredMessage & { role: 'user' | 'assistant' } =>
            m.role === 'user' || m.role === 'assistant',
          )
          .map((m) => ({ role: m.role, content: m.content })),
      );
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread]);

  const ready = settings ? isConfigured(settings) : false;

  const send = async () => {
    const text = input.trim();
    if (!text || !settings) return;
    setInput('');
    setError(null);

    // R1: this runs before anything else, and can end the turn on its own.
    const flagged = triage(text);
    if (flagged.triggered) {
      setThread((t) => [
        ...t,
        { role: 'user', content: text },
        { role: 'triage', content: flagged.message },
      ]);
      await appendMessage('doctor', 'user', text);
      await appendMessage('doctor', 'assistant', flagged.message);
      return;
    }

    setThread((t) => [...t, { role: 'user', content: text }]);
    setBusy(true);
    try {
      await appendMessage('doctor', 'user', text);
      // Rebuild the slice now rather than trusting what was loaded on mount.
      // Logging a meal in another tab and coming back here must not leave the
      // Doctor answering from stale facts — which is exactly how it ends up
      // giving textbook advice about a dinner it cannot see.
      const freshFacts = await collectFacts();
      const freshSlice = renderSlice(freshFacts);
      setSlice(freshSlice);
      const messages = await buildContext({
        agent: 'doctor',
        systemPrompt: SYSTEM_PROMPT,
        stateSlice: freshSlice || null,
        userMessage: text,
      });
      const result = await chat(settings, {
        messages,
        temperature: 0.3,
        maxTokens: 700,
      });
      // R2 on the way out. The domain layer cannot produce a dose; this covers
      // the model, which can say anything.
      const filtered = filterDoses(result.text.trim());
      const reply = filtered.text || '(empty response)';
      if (filtered.blocked) {
        console.warn('[R2] stripped dosing sentences:', filtered.removed);
      }
      await appendMessage('doctor', 'assistant', reply);
      setThread((t) => [...t, { role: 'assistant', content: reply }]);
      void maybeSummarise('doctor', settings).catch(() => {});
    } catch (e) {
      if (e instanceof LlmError) setError({ title: e.message, detail: e.body });
      else setError({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const noteSymptom = async () => {
    const text = input.trim();
    if (!text) return;
    await logSymptom(text);
    setInput('');
    await refresh();
  };

  return (
    <>
      <BackHome go={go} label="Doctor" />
      <div className="stack">
      {symptoms.length > 0 && (
        <section className="card">
          <h2>Open symptoms</h2>
          <ul className="med-list">
            {symptoms.map((s) => (
              <li key={s.id} className="med">
                <div>
                  <div className="dose-name">{s.label ?? s.raw_text}</div>
                  <p className="muted small">
                    noted{' '}
                    {new Date(s.noted_at).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    await resolveSymptom(s.id);
                    await refresh();
                  }}
                >
                  Resolved
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="today-head">
          <h2>Doctor</h2>
          <button className="link" onClick={() => setShowSlice((v) => !v)}>
            {showSlice ? 'hide' : 'what it can see'}
          </button>
        </div>

        {showSlice && (
          <div className="policy">
            <strong>Exactly what leaves this device</strong>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{slice || '(nothing yet)'}</pre>
            <p className="small">
              No name, no identifiers, no raw symptom text — assembled fresh each
              turn from the local record.
            </p>
          </div>
        )}

        {thread.length === 0 && (
          <p className="muted small">
            Ask about how your week has gone, an interaction you're unsure of, or
            something that's been bothering you. It reads your logs; it does not
            diagnose and it will not give you a dose.
          </p>
        )}

        <div className="chat">
          {thread.map((m, i) => (
            <div key={i} className={`bubble bubble--${m.role}`}>
              {m.role === 'triage' && <strong>Seek care now</strong>}
              <p>{m.content}</p>
            </div>
          ))}
          {busy && <p className="muted small">thinking…</p>}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="result result--fail">
            <strong>{error.title}</strong>
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        )}

        <label className="field" style={{ marginTop: 12 }}>
          <span>Message</span>
          <textarea
            id="doctor-input"
            rows={2}
            value={input}
            placeholder="how has my week looked?"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
        </label>
        <div className="row">
          <button
            className="primary"
            onClick={() => void send()}
            disabled={busy || !ready || !input.trim()}
          >
            Send
          </button>
          <button onClick={() => void noteSymptom()} disabled={!input.trim()}>
            Log as symptom
          </button>
          {thread.length > 0 && (
            <button
              onClick={async () => {
                await clearThread('doctor');
                setThread([]);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {!ready && (
          <p className="small muted">
            Configure a provider in Settings first.
          </p>
        )}
      </section>
    </div>
    </>
  );
}

/** Header for a screen reached from the home grid. */
function BackHome({ go, label }: { go: (s: Screen) => void; label: string }) {
  return (
    <div className="top">
      <button className="back" onClick={() => go('home')}>
        <Chevron />
        Home
      </button>
      <div className="grow" />
      <span className="small muted">{label}</span>
    </div>
  );
}
