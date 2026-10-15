/**
 * Show working, under an answer in Ask Mealo (domain/working.ts says what
 * is in it and why). Closed until tapped; drawn at all only when switched on
 * in Dev.
 *
 * "Exactly what was sent" is the text after R5, scrubbed by the adapter's
 * own function at the moment it is opened, so that the word "exactly" is
 * true: the app's copy from before the scrub would show a name that never
 * left the phone.
 */

import { useState } from 'react';
import type { Working } from '../domain/working';
import { asSent } from '../llm/adapter';
import { Chevron } from './bits';

const WHY: Record<'figure' | 'claim', string> = {
  figure: 'Removed · a figure in nothing Ask Mealo was given',
  claim: 'Removed · it said something was saved; only you can save',
};

function Sent({ text }: { text: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="sw-tog"
        aria-expanded={open}
        onClick={async () => {
          if (!open && shown === null) setShown(await asSent(text));
          setOpen(!open);
        }}
      >
        {open ? 'Hide exactly what was sent' : 'Exactly what was sent'}
        <Chevron dir={open ? 'down' : 'right'} size={12} />
      </button>
      {open && shown !== null && <pre className="sw-raw">{shown}</pre>}
    </>
  );
}

export function WorkingCard({ w }: { w: Working }) {
  const [open, setOpen] = useState(false);
  // A tick for each check that took nothing out.
  const passed = [
    !w.removed.some((r) => r.why === 'figure') && 'Every figure in what it was given',
    !w.removed.some((r) => r.why === 'dose') && 'No dose',
    !w.removed.some((r) => r.why === 'claim') && 'Nothing claimed as saved',
  ].filter((p): p is string => typeof p === 'string');
  let step = 0;
  return (
    <>
      <button className="sw-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide working' : 'Show working'}
        <Chevron dir={open ? 'down' : 'right'} size={13} />
      </button>
      {open && (
        <div className="sw">
          {w.lookups.map((l, i) => (
            <div className="sw-step" key={i}>
              <div className="sw-t">
                <span className="n">{++step}</span>
                <span className="grow">{l.label}</span>
                <span className="s">{l.name}</span>
              </div>
              {l.rows.map(([k, v], j) => (
                <div className="sw-r" key={j}>
                  <span className="k">{k}</span>
                  <span className="v">{v}</span>
                </div>
              ))}
              <Sent text={l.sent} />
            </div>
          ))}
          {w.lookups.length === 0 && (
            <div className="sw-step">
              <div className="sw-t">
                <span className="n">{++step}</span>
                <span className="grow">No lookups</span>
              </div>
              <div className="sw-x">
                {w.withoutTools
                  ? 'This model would not take lookups, so it answered from what it can see (the eye, top right).'
                  : 'Answered from what it can see (the eye, top right), without looking anything up.'}
              </div>
            </div>
          )}
          {w.shown.length > 0 && (
            <div className="sw-step">
              <div className="sw-t">
                <span className="n">{++step}</span>
                <span className="grow">Put on screen</span>
              </div>
              <div className="sw-x">{w.shown.join(' · ')}. Nothing is saved until you press it.</div>
            </div>
          )}
          <div className="sw-step">
            <div className="sw-t">
              <span className="n">{++step}</span>
              <span className="grow">Checked by the app</span>
            </div>
            {w.removed.map((r, i) =>
              r.why === 'dose' ? (
                <div className="sw-x" key={i}>
                  <span className="why">
                    Removed {r.count === 1 ? 'a sentence' : `${r.count} sentences`} with a dose. Not shown here: the app never puts a dose on
                    screen.
                  </span>
                </div>
              ) : (
                <div className="sw-x" key={i}>
                  <s>{r.text}</s>
                  <span className="why">{WHY[r.why]}</span>
                </div>
              ),
            )}
            {passed.length > 0 && (
              <div className="sw-x">
                {passed.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ' \u00b7 '}
                    <span className="sw-ok">{'\u2713'}</span> {p}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="sw-foot">
            {/* Each piece kept whole: the mock-up split the model's name at its hyphen. */}
            {[
              `${w.requests} ${w.requests === 1 ? 'request' : 'requests'}`,
              `${(w.ms / 1000).toFixed(1)} s`,
              w.tokens != null ? `${w.tokens.toLocaleString('en-US')} tokens` : null,
              w.model,
            ]
              .filter((x): x is string => !!x)
              .map((x, i) => (
                <span key={x}>
                  {i > 0 && ' \u00b7 '}
                  {x}
                </span>
              ))}
          </div>
        </div>
      )}
    </>
  );
}
