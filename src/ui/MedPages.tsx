/**
 * The pages one level below the Meds screen: one medicine, the history of
 * sicknesses and one of them, the FDA label check, and what has been stopped.
 *
 * Each draws its own header and says where Back goes, the same as every other
 * screen. None of them writes anything without a button that says so.
 */

import { useEffect, useState } from 'react';
import {
  FORMS,
  describeDose,
  describeSchedule,
  medDay,
  nextDue,
  scheduleOfDose,
  durationLabel,
  endedOn,
  fmtDay as shortDay,
  lengths,
  timeLabel,
  TIMES,
  type Episode,
} from '../domain/doses';
import { checkInteractions, type Finding, type LabelStatus } from '../domain/interactions';
import {
  hideFromLibrary,
  listStopped,
  medicineDetail,
  readMedsDay,
  resumeMedication,
  sicknessRecord,
  stopMedication,
  type MedDetail,
  type Medication,
  type PastMed,
} from '../domain/medications';
import { Chevron, useToast } from './bits';
import { SlotIcon } from './SlotIcon';

function Top({ back, label, right }: { back: () => void; label: string; right?: React.ReactNode }) {
  return (
    <>
      <span className="mwash" />
      <div className="top">
        <button className="back" onClick={back}>
          <Chevron />
          {label}
        </button>
        <div className="grow" />
        {right}
      </div>
    </>
  );
}

// ------------------------------------------------------------ one medicine

export function MedDetailPage({
  id,
  onBack,
  onEdit,
}: {
  id: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [d, setD] = useState<MedDetail | null | undefined>(undefined);
  const toast = useToast();

  useEffect(() => {
    void medicineDetail(id).then(setD);
  }, [id]);

  if (d === undefined) return <Top back={onBack} label="Meds" />;
  if (d === null) {
    return (
      <>
        <Top back={onBack} label="Meds" />
        <p className="empty-note">That medicine is no longer here.</p>
      </>
    );
  }

  const { med, product, ingredients, doses, episode } = d;
  const type = FORMS.find((f) => f.id === product?.form)?.label;
  const inSickness = episode
    ? `for ${episode.name}`
    : med.long_term === 1
      ? 'continues in sick mode'
      : 'pauses in sick mode';

  const stop = async () => {
    await stopMedication(med.id);
    toast('Stopped');
    onBack();
  };

  return (
    <>
      <Top
        back={onBack}
        label="Meds"
        right={
          med.ended_on === null && (
            <button className="edit-btn" onClick={onEdit}>
              Edit
            </button>
          )
        }
      />

      <div className="dish-name">{med.name}</div>
      <div className="dish-sub">
        {[type, med.dose_text, inSickness].filter(Boolean).join(' · ')}
        {med.long_term === 1 && !episode && (
          <>
            {' '}
            <span className="tag tag--life">Long-Term</span>
          </>
        )}
      </div>

      <div className="section-h">Schedule</div>
      {doses.length > 0 ? (
        <div className="readout dt">
          <div className="mlist">
            <div className="mrow">
              <span className="k">How often</span>
              <span className="v">
                {describeSchedule(scheduleOfDose(doses[0]))}
                {scheduleOfDose(doses[0]).freq !== 'daily' && med.ended_on === null && (() => {
                  const next = nextDue(scheduleOfDose(doses[0]), medDay());
                  if (!next) return null;
                  return (
                    <span className="muted">
                      {' · '}
                      {next === medDay() ? 'due today' : `next ${shortDay(next)}`}
                    </span>
                  );
                })()}
              </span>
            </div>
            {doses.map((x) => (
              <div className="mrow" key={x.id}>
                <span className="k ic">
                  <SlotIcon slot={TIMES.find((t) => t.id === x.time_of_day)?.slot ?? 'other'} size={17} />
                  {timeLabel(x.time_of_day)}
                </span>
                <span className="v">{describeDose(x)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // A medicine from before dose slots. Its words are shown as they were
        // typed and never turned into slots by guessing.
        <div className="readout dt">
          <div className="mlist">
            <div className="mrow">
              <span className="k">As written</span>
              <span className="v">{med.schedule || 'no schedule recorded'}</span>
            </div>
          </div>
          <div className="basis">Edit to set its times, so it can be ticked off each day.</div>
        </div>
      )}

      <div className="section-h">Active pharmaceutical ingredients</div>
      {ingredients.length > 0 ? (
        <div className="readout dt">
          <div className="mlist">
            {ingredients.map((i, n) => (
              <div className="mrow" key={n}>
                <span className="k">{i.name}</span>
                <span className="v num">{i.strength_text ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="empty-note">None listed.</p>
      )}

      <div className="section-h">Since</div>
      <div className="readout dt">
        <div className="mlist">
          {med.started_on && (
            <div className="mrow">
              <span className="k">Started</span>
              <span className="v num">{shortDay(med.started_on)}</span>
            </div>
          )}
          {med.ended_on && (
            <div className="mrow">
              <span className="k">Stopped</span>
              <span className="v num">{shortDay(med.ended_on)}</span>
            </div>
          )}
          {episode && (
            <div className="mrow">
              <span className="k">Sickness</span>
              <span className="v">
                {episode.name}, {shortDay(episode.started_on)} – {shortDay(endedOn(episode))}
              </span>
            </div>
          )}
          {product && (
            <div className="mrow">
              <span className="k">Library</span>
              <span className="v">
                {product.private ? 'Private to this phone' : product.hidden ? 'Removed from search' : 'Shared with the household'}
              </span>
            </div>
          )}
        </div>
      </div>

      {med.ended_on === null && (
        <button className="cta cta--ghost stop" onClick={() => void stop()}>
          Stop taking
        </button>
      )}
      {product && !product.private && !product.hidden && (
        // The rare path, so a plain text button and not a third control of the
        // same weight — the same reasoning as the burn screen's correction link.
        <button
          className="wfix"
          style={{ marginTop: 12 }}
          onClick={async () => {
            await hideFromLibrary(product.id);
            toast('Removed from the library');
            setD(await medicineDetail(id));
          }}
        >
          Remove from the household library
        </button>
      )}
      <div className="foot">Stopping keeps it in your history.</div>
    </>
  );
}

// ----------------------------------------------------------------- history

export function HistoryPage({
  episodes,
  onBack,
  onOpen,
}: {
  /** Sicknesses that have ended, newest first. */
  episodes: Episode[];
  onBack: () => void;
  onOpen: (e: Episode) => void;
}) {
  return (
    <>
      <Top back={onBack} label="Meds" />
      <div className="dish-name">Sickness history</div>
      {episodes.length === 0 ? (
        <p className="empty-note">Nothing yet. A sickness lands here once it is over.</p>
      ) : (
        <div style={{ marginTop: 14 }}>
          {episodes.map((e) => {
            const { lasted } = lengths(e);
            return (
              <div className="row linkrow" key={e.id}>
                <button className="row-tap" onClick={() => onOpen(e)}>
                  <span className="grow">
                    <span className="nm" style={{ display: 'block' }}>{e.name}</span>
                    <span className="amt num" style={{ display: 'block' }}>
                      {shortDay(e.started_on)} – {shortDay(endedOn(e))} · {durationLabel(lasted, 'days')}
                    </span>
                  </span>
                  <Chevron dir="right" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function EpisodePage({ episode, onBack }: { episode: Episode; onBack: () => void }) {
  const [meds, setMeds] = useState<PastMed[] | null>(null);
  useEffect(() => {
    void sicknessRecord(episode).then(setMeds);
  }, [episode]);

  const { planned, lasted } = lengths(episode);
  const how = episode.recovered_on && episode.recovered_on <= episode.last_day
    ? `Recovered on ${shortDay(episode.recovered_on)}`
    : 'Ran its course';

  return (
    <>
      <Top back={onBack} label="History" />
      <div className="dish-name">{episode.name}</div>
      <div className="dish-sub">
        {shortDay(episode.started_on)} – {shortDay(endedOn(episode))}
      </div>

      <div className="section-h">How it went</div>
      <div className="readout dt">
        <div className="mlist">
          <div className="mrow">
            <span className="k">Planned</span>
            <span className="v num">{durationLabel(planned, 'days')}</span>
          </div>
          <div className="mrow">
            <span className="k">Lasted</span>
            <span className="v num">{durationLabel(lasted, 'days')}</span>
          </div>
          <div className="mrow">
            <span className="k">Ended</span>
            <span className="v">{how}</span>
          </div>
        </div>
      </div>

      <div className="section-h">What was taken for it</div>
      {meds === null ? null : meds.length === 0 ? (
        <p className="empty-note">No medicines were added for it.</p>
      ) : (
        meds.map((m) => (
          <div className="row" key={m.med.id}>
            <span className="grow">
              <span className="nm" style={{ display: 'block' }}>
                {m.med.name}
                {m.med.dose_text && <span className="muted small"> {m.med.dose_text}</span>}
              </span>
              <span className="amt" style={{ display: 'block' }}>
                {m.doses.map((d) => `${timeLabel(d.time_of_day)}: ${describeDose(d)}`).join(' · ') ||
                  m.med.schedule ||
                  'no schedule recorded'}
              </span>
            </span>
            <span className="kc num">
              {m.taken} taken{m.skipped ? ` · ${m.skipped} skipped` : ''}
            </span>
          </div>
        ))
      )}
    </>
  );
}

// ------------------------------------------------------------- label check

export function LabelCheckPage({ onBack }: { onBack: () => void }) {
  const [meds, setMeds] = useState<Medication[]>([]);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [statuses, setStatuses] = useState<LabelStatus[]>([]);
  const [checking, setChecking] = useState(false);

  // What is being taken now, paused ones included — a medicine set aside for a
  // fever is still in the cupboard and comes back. Not a finished course.
  useEffect(() => {
    void readMedsDay().then((plan) => {
      const all = new Map<string, Medication>();
      for (const g of plan.groups) for (const p of g.doses) all.set(p.med.id, p.med);
      for (const p of plan.paused) all.set(p.med.id, p.med);
      for (const m of plan.unscheduled) all.set(m.id, m);
      setMeds([...all.values()]);
    });
  }, []);

  const run = async () => {
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

  const noLabel = statuses.filter((s) => s.noLabel).map((s) => s.name);

  return (
    <>
      <Top back={onBack} label="Meds" />
      <div className="dish-name">Label check</div>
      <div className="dish-sub">
        Reads the FDA label for each medicine and reports whether it names anything else you
        take. It does not judge severity — that is a pharmacist's call. Cached for 30 days; no
        model involved.
      </div>

      <button
        className="cta cta--meds"
        disabled={checking || meds.length === 0}
        onClick={() => void run()}
      >
        {checking ? 'Checking…' : findings ? 'Check again' : 'Check labels'}
      </button>
      {meds.length === 0 && <p className="empty-note">Nothing to check until a medicine is added.</p>}

      {findings !== null && findings.length === 0 && (
        <p className="note">
          Nothing found. That is not the same as nothing existing — many products, supplements
          especially, have no FDA label at all.
        </p>
      )}

      {findings?.map((f, i) => (
        <div key={i} className="result result--warn" style={{ marginTop: 12 }}>
          <strong>
            {f.sourceMed}'s label mentions {f.mentions}
          </strong>
          <p>"{f.excerpt}"</p>
          <p className="small muted">
            From the label for <b>{f.productName}</b> ·{' '}
            <a href={f.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>{' '}
            · retrieved {new Date(f.retrievedAt).toLocaleDateString()}
          </p>
        </div>
      ))}

      {noLabel.length > 0 && (
        <p className="note">No FDA label found for: {noLabel.join(', ')}.</p>
      )}
    </>
  );
}

// ----------------------------------------------------------------- stopped

export function StoppedPage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Medication[]>([]);
  const toast = useToast();
  const load = () => void listStopped().then(setRows);
  useEffect(load, []);

  return (
    <>
      <Top back={onBack} label="Meds" />
      <div className="dish-name">Stopped</div>
      <div className="dish-sub">Kept, not deleted — the history still matters.</div>
      <div style={{ marginTop: 14 }}>
        {rows.length === 0 && <p className="empty-note">Nothing stopped.</p>}
        {rows.map((m) => (
          <div className="row" key={m.id}>
            <span className="grow">
              <span className="nm" style={{ display: 'block' }}>
                {m.name}
                {m.dose_text && <span className="muted small"> {m.dose_text}</span>}
              </span>
              <span className="amt num" style={{ display: 'block' }}>
                stopped {m.ended_on ? shortDay(m.ended_on) : ''}
              </span>
            </span>
            {m.episode_id === null && (
              <button
                className="edit-btn"
                onClick={async () => {
                  await resumeMedication(m.id);
                  toast('Resumed');
                  load();
                }}
              >
                Resume
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
