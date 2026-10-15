/**
 * "Check this model", in Dev's Ask Mealo card, from the mock-up he approved
 * on 15 Oct 2026. Runs domain/modelcheck.ts on the fields as they stand,
 * saved or not, only when tapped, and keeps each model's last result on the
 * phone so models can be compared.
 */

import { useEffect, useState } from 'react';
import { checksSoFar, rememberCheck, runCheck, summaryOf, type CheckResult, type QuestionResult } from '../domain/modelcheck';
import type { ProviderConfig } from '../llm/types';

const VERDICT: Record<CheckResult['verdict'], string> = {
  good: 'good for Ask Mealo',
  partly: 'partly reliable for Ask Mealo',
  poor: 'not reliable for Ask Mealo',
  failed: 'could not be checked',
};

/** What each question looks up, in words: "yesterday's meals". */
const WHAT: Record<QuestionResult['id'], string> = { meals: 'yesterday’s meals', meds: 'the week’s doses' };

const trim = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** An answer as words in a quote: no list marks or bold, lines run together. */
const plain = (s: string) => s.replace(/\*\*|__/g, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\s*\n+\s*/g, ' ').trim();

function Row({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="mc-row">
      <span className="mc-mark" data-ok={ok ? '1' : undefined}>{ok ? '✓' : '✗'}</span>
      <span>
        <span className="mc-t">{title}</span>
        <span className="small muted mc-d">{detail}</span>
      </span>
    </div>
  );
}

function Result({ r }: { r: CheckResult }) {
  const qs = r.questions;
  const failed = r.verdict === 'failed';
  const missed = qs.filter((q) => !q.rightLookup);
  const silent = qs.filter((q) => !q.answered);
  const invented = qs.flatMap((q) => q.invented);
  const quote = qs.find((q) => q.answered)?.answer;
  const err = qs.find((q) => q.error)?.error ?? '';
  return (
    <div className="bk-box mc-box" data-tone={r.verdict === 'good' ? 'ok' : 'warn'}>
      <strong>
        {r.model}: {VERDICT[r.verdict]}
      </strong>
      {failed ? (
        <p>
          {/429|rate/i.test(err)
            ? 'The provider’s per-minute limit was reached. Wait a minute and check again.'
            : /401|403|key/i.test(err)
              ? 'The provider refused the key. Check it above, then Test connection.'
              : 'The provider could not be reached or refused the request.'}{' '}
          <span className="muted">({trim(err, 90)})</span>
        </p>
      ) : (
        <div className="mc-rows">
          <Row
            ok={missed.length === 0}
            title={missed.length === 0 ? 'Looks things up' : 'Does not look things up'}
            detail={
              missed.length === 0
                ? `Asked for ${qs.map((q) => WHAT[q.id]).join(' and ')} before answering`
                : `Answered without asking for ${missed.map((q) => WHAT[q.id]).join(' or ')}`
            }
          />
          {missed.length === qs.length ? (
            // It never looked, so there is no "after looking" to judge; what
            // it said instead is quoted below, if it made anything up.
            <Row ok={false} title="Answers without the record" detail="Words came back, but from no lookup" />
          ) : (
            <Row
              ok={silent.length === 0}
              title={silent.length === 0 ? 'Answers after looking' : 'Goes quiet after looking'}
              detail={silent.length === 0 ? (quote ? `“${trim(plain(quote))}”` : '') : 'Came back with no words after a lookup'}
            />
          )}
          <Row
            ok={invented.length === 0}
            title={invented.length === 0 ? 'Sticks to the figures' : 'Made up figures'}
            detail={
              invented.length === 0
                ? 'Every number in its answers was in what it was given'
                : `“${trim(plain(invented[0]), 110)}” was in nothing it was given; Ask Mealo would remove that sentence`
            }
          />
        </div>
      )}
      {r.verdict === 'poor' && (
        <p className="small">
          With this model Ask Mealo works from the day’s summary alone, and logging by chat still works, because the app reads those
          sentences itself.
        </p>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {r.requests} requests · {r.tokens ? `${r.tokens.toLocaleString('en-US')} tokens` : 'tokens not reported'} · {(r.ms / 1000).toFixed(1)} s
        {r.limits?.tokensPerMinute
          ? `. On this key: ${r.limits.tokensPerMinute.toLocaleString('en-US')} tokens a minute${r.limits.requestsPerDay ? `, ${r.limits.requestsPerDay.toLocaleString('en-US')} requests a day` : ''}.`
          : r.provider === 'groq'
            ? '. Groq did not share its limits with the browser; they are under Settings, Limits, in Groq’s console.'
            : '.'}
      </p>
    </div>
  );
}

export function ModelCheck({ cfg, needsKey }: { cfg: ProviderConfig; needsKey: boolean }) {
  const [state, setState] = useState<{ question: number; waitingMs?: number } | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [past, setPast] = useState<CheckResult[]>([]);

  useEffect(() => {
    void checksSoFar().then(setPast);
  }, []);

  const noKey = needsKey && !cfg.apiKey.trim();
  const running = state !== null;

  const go = async () => {
    setResult(null);
    setState({ question: 1 });
    try {
      const r = await runCheck(cfg, setState);
      await rememberCheck(r);
      setResult(r);
      setPast(await checksSoFar());
    } finally {
      setState(null);
    }
  };

  return (
    <>
      <button className="bk-btn" disabled={running || noKey || !cfg.model.trim()} onClick={() => void go()}>
        {!running
          ? 'Check this model'
          : state.waitingMs
            ? `Second question in ${Math.ceil(state.waitingMs / 1000)} s`
            : `Checking: question ${state.question} of 2`}
      </button>
      {!result && (
        <p className="small muted" style={{ margin: '8px 2px 0' }}>
          {noKey
            ? 'Add the key above first.'
            : 'Two made-up questions, a minute apart, with Ask Mealo’s own instructions; never your record. Uses about 10,000 tokens of your allowance.'}
        </p>
      )}
      {result && <Result r={result} />}
      {past.length > 0 && (
        <>
          <div className="section-h" style={{ marginTop: 16 }}>
            Checked on this phone
          </div>
          {past.map((p) => (
            <div className="dv-kv" key={`${p.provider}|${p.model}`}>
              <span className="k">{p.model}</span>
              <span className="v" data-tone={p.verdict === 'good' ? 'ok' : 'warn'}>
                {summaryOf(p)}
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
