/**
 * The Phase 0 exit criterion, made clickable.
 *
 * "A message typed into a bare page reaches Ollama on the Mac and renders a
 * reply, and the same adapter reaches Groq from the deployed origin with no
 * CORS error." This screen is that test, nothing more. It is scaffolding — the
 * real agent screens replace it from Phase 1.
 */

import { useEffect, useState } from 'react';
import { chat, getOutboundLog } from '../llm/adapter';
import { LlmError, type ChatResult } from '../llm/types';
import { isConfigured, loadSettings, type Settings } from '../settings/store';

export function Playground() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [prompt, setPrompt] = useState('In one sentence: what is fibre?');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChatResult | null>(null);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(
    null,
  );
  const [showOutbound, setShowOutbound] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return <p className="muted">Loading…</p>;

  const ready = isConfigured(settings);

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await chat(settings, {
        messages: [
          {
            role: 'system',
            content:
              'You are a plain, accurate assistant. Answer briefly. Never give a dose.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        maxTokens: 512,
      });
      setResult(r);
    } catch (e) {
      if (e instanceof LlmError) {
        setError({ title: e.message, detail: e.body });
      } else {
        setError({ title: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Adapter playground</h2>
        {!ready && (
          <div className="result result--fail">
            <strong>Not configured yet.</strong>
            <p className="small">
              Set a provider, model and key in Settings first.
            </p>
          </div>
        )}
        <label className="field">
          <span>Message</span>
          <textarea
            id="prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="row">
          <button className="primary" onClick={send} disabled={busy || !ready}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <span className="muted small">
            {settings.provider} · {settings.model}
          </span>
        </div>

        {result && (
          <div className="result result--ok">
            <p className="reply">{result.text || '(empty response)'}</p>
            <p className="small muted">
              {result.ms} ms
              {result.usage.totalTokens !== undefined && (
                <>
                  {' · '}
                  {result.usage.promptTokens ?? '?'} in /{' '}
                  {result.usage.completionTokens ?? '?'} out ={' '}
                  {result.usage.totalTokens} tokens
                </>
              )}
              {result.model && ` · ${result.model}`}
            </p>
            {result.usage.totalTokens !== undefined && (
              <p className="small muted">
                At 200,000 tokens/day that is roughly{' '}
                {Math.floor(200000 / Math.max(result.usage.totalTokens, 1))}{' '}
                calls of this size.
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="result result--fail">
            <strong>{error.title}</strong>
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Outbound payloads</h2>
        <p className="muted small">
          Exactly what left this device, newest first. Kept in memory only. This
          is how R5 gets verified later — the de-identification boundary belongs
          at the adapter, and the only way to know it holds is to look.
        </p>
        <div className="row">
          <button onClick={() => setShowOutbound((v) => !v)}>
            {showOutbound ? 'Hide' : 'Show'} ({getOutboundLog().length})
          </button>
        </div>
        {showOutbound && (
          <pre className="outbound">
            {JSON.stringify(getOutboundLog(), null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}
