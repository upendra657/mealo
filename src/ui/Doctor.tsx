/**
 * Ask Mealo: the one AI chat.
 *
 * It was "Doctor" on screen until Oct 2026. The file, the component and the
 * agent id keep the old word (see the map in db/scope.ts); nothing a person
 * reads does.
 *
 * Two things make this different from a chat box with a medical system prompt:
 *
 *   1. Red-flag triage runs in plain code before any model call. Emergencies
 *      are routed by a regex that cannot be talked out of its judgement.
 *
 *   2. What crosses the network is a de-identified slice assembled from the
 *      local record — no name, no identifiers — plus a rolling summary
 *      rather than the full history. A logged symptom does travel in the
 *      person's own words, cut to 60 characters (domain/state.ts): the
 *      comment here said "no raw symptom text" for a long time and the code
 *      never agreed with it.
 *
 * The screen is a notebook, not a messenger: each question is an entry, and
 * what the model wrote under it is marked AI. No bubbles and no avatar, on
 * purpose. This is a tool for reading your own records, and the look of a
 * conversation with someone invites using it as company or as a clinician.
 */

import { ArrowUp, Bubble, Chevron, Eye } from './bits';
import type { Screen } from '../App';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendMessage,
  buildContext,
  clearThread,
  loadThread,
  maybeSummarise,
} from '../llm/conversation';
import { chat } from '../llm/adapter';
import { LlmError } from '../llm/types';
import { isConfigured, loadSettings, type Settings } from '../settings/store';
import { triage } from '../safety/redflags';
import { filterDoses } from '../safety/dosefilter';
import { entriesFrom, entryTime, PILLS, TRY_ASKING, type Entry, type Pill } from '../domain/chat';
import { collectFacts, refreshCurrentState, renderSlice } from '../domain/state';
import { logSymptom, openSymptoms, resolveSymptom, type Symptom } from '../domain/symptoms';
import { readMedsDay } from '../domain/medications';
import { DosesFlow, MealFlow, SymptomFlow } from './AskPills';

/**
 * One use of a pill, in the thread beside the questions. Held in this
 * screen's state only: see AskPills.tsx for why it is not stored.
 */
type FlowItem = {
  kind: 'flow';
  pill: Pill;
  id: number;
  at: number;
  said: string | null;
  savedId: string | null;
};
type Item = Entry | FlowItem;

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

export function Doctor({ go }: { go: (s: Screen) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [thread, setThread] = useState<Item[]>([]);
  /** The pill whose question the bar is answering, if any. */
  const [awaiting, setAwaiting] = useState<number | null>(null);
  /** Whether "Tick my doses" has anything to offer right now. */
  const [dueNow, setDueNow] = useState(false);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  /** The stored thread has been read. Until then "empty" is not yet known. */
  const [loaded, setLoaded] = useState(false);
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
    const plan = await readMedsDay();
    setDueNow(plan.groups.some((g) => g.doses.some((p) => p.state === 'due')));
    await refreshCurrentState();
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void (async () => {
      setThread(entriesFrom(await loadThread('doctor')));
      setLoaded(true);
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    // Not on an empty thread: the first page should open at its top, with
    // the name and "What this is not" in view, not scrolled to the bar.
    if (thread.length === 0 && !busy) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread, busy]);

  // A card grows after it is drawn: the meal is matched, the doses are read.
  // Watching the thread's height keeps the end in view without every card
  // having to say when it changed.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.querySelector('.am-entry, .am-q, .am-rcpt')) {
        endRef.current?.scrollIntoView({ block: 'end' });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = settings ? isConfigured(settings) : false;

  const patchFlow = (id: number, patch: Partial<FlowItem>) =>
    setThread((t) => t.map((x) => (x.kind === 'flow' && x.id === id ? { ...x, ...patch } : x)));

  const startPill = (pill: Pill) => {
    const id = nextId.current++;
    const typed = pill !== 'doses';
    setThread((t) => [
      // A question the person walked away from is dropped, not left hanging
      // above the one they actually chose.
      ...t.filter((x) => !(x.kind === 'flow' && x.id === awaiting)),
      { kind: 'flow', pill, id, at: Date.now(), said: null, savedId: null },
    ]);
    setAwaiting(typed ? id : null);
    if (typed) inputRef.current?.focus();
  };

  const send = async (typed = input) => {
    const text = typed.trim();
    if (!text || !settings || busy) return;
    setInput('');
    setError(null);

    // The bar is answering a pill's question: the words go to its card, and
    // to no model. A symptom still passes the red flags first, and an
    // emergency is saved here, in the tap, before its card is drawn.
    const flow = thread.find((x): x is FlowItem => x.kind === 'flow' && x.id === awaiting);
    if (flow) {
      setAwaiting(null);
      const urgent = flow.pill === 'symptom' && triage(text).triggered;
      const savedId = urgent ? await logSymptom(text) : null;
      patchFlow(flow.id, { said: text, savedId });
      if (urgent) void refresh();
      return;
    }

    // R1: this runs before anything else, and can end the turn on its own.
    const flagged = triage(text);
    if (flagged.triggered) {
      setThread((t) => [
        ...t,
        { kind: 'asked', text, at: Date.now() },
        { kind: 'stop', text: flagged.message, at: Date.now() },
      ]);
      await appendMessage('doctor', 'user', text);
      await appendMessage('doctor', 'assistant', flagged.message);
      return;
    }

    // Past the red flags, nothing can be answered without a provider. The
    // check sits here and not above triage so that a stop still reaches
    // someone who never set one up.
    if (!ready) {
      setInput(text);
      return;
    }

    setThread((t) => [...t, { kind: 'asked', text, at: Date.now() }]);
    setBusy(true);
    try {
      await appendMessage('doctor', 'user', text);
      // Rebuild the slice now rather than trusting what was loaded on mount.
      // Logging a meal in another tab and coming back here must not leave
      // Ask Mealo answering from stale facts — which is exactly how it ends up
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
      setThread((t) => [...t, { kind: 'answer', text: reply, at: Date.now() }]);
      void maybeSummarise('doctor', settings).catch(() => {});
    } catch (e) {
      if (e instanceof LlmError) setError({ title: e.message, detail: e.body });
      else setError({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const empty = loaded && thread.length === 0;
  const waiting = thread.find((x): x is FlowItem => x.kind === 'flow' && x.id === awaiting);
  const ask = waiting ? PILLS[waiting.pill] : null;

  return (
    <div className="am">
      <div className="top">
        <button className="back" onClick={() => go('home')}>
          <Chevron />
          Home
        </button>
        <div className="grow" />
        {/* The first page carries the name in its own body; once there is a
            thread the header takes it over. */}
        {!empty && <span className="am-ttl">Ask Mealo</span>}
        <div className="grow" />
        {/* In words on the first page, where nobody yet knows what an eye
            would mean here; the icon once there is a title to make room for. */}
        {empty ? (
          <button className="am-see-link" onClick={() => setShowSlice((v) => !v)}>
            What it can see
          </button>
        ) : (
          <button
            className="icon-btn am-eye"
            aria-label="What it can see"
            aria-pressed={showSlice}
            onClick={() => setShowSlice((v) => !v)}
          >
            <Eye />
          </button>
        )}
      </div>

      {showSlice && (
        <div className="am-see">
          <div className="am-eyeb">Exactly what leaves this device</div>
          <pre>{slice || '(nothing yet)'}</pre>
          <p>
            No name and no identifiers. A symptom you logged appears in your
            own words, cut to 60 characters. Assembled fresh each time you ask,
            from your records.
          </p>
          {symptoms.length > 0 && (
            <>
              <div className="am-eyeb">Open symptoms</div>
              {symptoms.map((s) => (
                <div key={s.id} className="am-sym">
                  <span>{s.label ?? s.raw_text}</span>
                  <button
                    className="link"
                    onClick={async () => {
                      await resolveSymptom(s.id);
                      await refresh();
                    }}
                  >
                    Resolved
                  </button>
                </div>
              ))}
            </>
          )}
          {thread.length > 0 && (
            <button
              className="link link--muted am-clear"
              onClick={async () => {
                await clearThread('doctor');
                setThread([]);
                setShowSlice(false);
              }}
            >
              Clear this conversation
            </button>
          )}
        </div>
      )}

      <div ref={threadRef} className={`am-thread${empty ? ' am-thread--first' : ''}`}>
        {/* Until the first message, and then gone. It has to be read before
            someone starts talking; in every conversation after that it would
            be a notice nobody sees any more. Waits for the stored thread, so
            it does not flash up over a conversation that is about to load. */}
        {empty && (
          <>
            <div className="am-hello">
              <div className="am-orb">
                <Bubble />
              </div>
              <h1>Ask Mealo</h1>
              <p>
                Ask about what you have tracked: your meals, medicines, weight
                and symptoms.
              </p>
              <div className="am-not">
                <strong>What this is not</strong>
                <p>
                  <b>Not a doctor.</b> It does not diagnose, and it never gives a
                  dose.
                </p>
                <p>
                  <b>Not for emergencies.</b> If something feels serious, see a
                  doctor or call your local emergency number.
                </p>
                <p>
                  <b>Not always right.</b> It is an AI. Check anything that
                  matters with a professional.
                </p>
              </div>
            </div>
            <div>
              <div className="am-eyeb am-try-h">Try asking</div>
              {TRY_ASKING.map((q) => (
                <button key={q} className="am-try" onClick={() => void send(q)}>
                  {q}
                  <Chevron dir="right" />
                </button>
              ))}
            </div>
          </>
        )}

        {thread.map((e, i) =>
          e.kind === 'flow' ? (
            (() => {
              const Flow = e.pill === 'meal' ? MealFlow : e.pill === 'doses' ? DosesFlow : SymptomFlow;
              return (
                <Flow
                  key={`f${e.id}`}
                  at={e.at}
                  said={e.said}
                  savedId={e.savedId}
                  onRetype={() => {
                    setInput(e.said ?? '');
                    patchFlow(e.id, { said: null });
                    setAwaiting(e.id);
                    inputRef.current?.focus();
                  }}
                  onCancel={() => {
                    setThread((t) => t.filter((x) => x !== e));
                    if (awaiting === e.id) setAwaiting(null);
                  }}
                  onWrote={() => void refresh()}
                  onAddDish={() => go('log')}
                />
              );
            })()
          ) : e.kind === 'asked' ? (
            <div key={i} className="am-q">
              <div className="am-q-t">{entryTime(e.at)}</div>
              <div className="am-q-x">{e.text}</div>
            </div>
          ) : e.kind === 'stop' ? (
            <div key={i} className="am-entry">
              <div className="am-eyeb am-eyeb--bad">
                <i />
                Stopped by the app · not sent to any AI
              </div>
              <div className="am-stop">
                <div className="am-stop-t">Seek care now</div>
                <p>{e.text}</p>
              </div>
            </div>
          ) : (
            <div key={i} className="am-entry">
              <div className="am-src">
                <span className="am-ai">AI</span>
                <span className="am-eyeb">Ask Mealo</span>
              </div>
              <p className="am-a">{e.text}</p>
            </div>
          ),
        )}
        {busy && <p className="am-wait">Reading your records…</p>}

        {error && (
          <div className="result result--fail">
            <strong>{error.title}</strong>
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="am-dock">
        {settings && !ready && (
          <p className="am-nokey">
            Ask Mealo needs a model provider.{' '}
            <button className="link" onClick={() => go('dev')}>
              Set one up in Dev
            </button>
          </p>
        )}
        <div className="am-pills">
          <button onClick={() => startPill('meal')}>{PILLS.meal.label}</button>
          {/* Only while a dose is waiting. A pill that opens onto "nothing is
              due" most of the day teaches people not to press it. */}
          {dueNow && <button onClick={() => startPill('doses')}>{PILLS.doses.label}</button>}
          <button onClick={() => startPill('symptom')}>{PILLS.symptom.label}</button>
        </div>
        <div className="am-bar">
          <textarea
            id="doctor-input"
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={ask?.asks ?? 'Ask about your records'}
            aria-label={ask?.asks ?? 'Ask about your records'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="am-send"
            aria-label="Send"
            onClick={() => void send()}
            disabled={busy || !input.trim()}
          >
            <ArrowUp />
          </button>
        </div>
      </div>
    </div>
  );
}
