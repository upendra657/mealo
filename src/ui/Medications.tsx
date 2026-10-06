/**
 * Track meds.
 *
 * The screen answers one question first — what do I take today, and what have
 * I taken — and puts the mode it is in above that, because sick mode changes
 * the answer. Everything else is one level down: a medicine's own page, the
 * form, history, the label check.
 *
 * Ticking a dose is the one thing that writes from here without a Save. It is
 * the logging this screen exists for, a tick undoes with a second tap, and a
 * confirm step in front of it would cost more than a mistaken tick ever does.
 * Everything that changes what is taken — adding, editing, starting or ending
 * a sickness — goes through a form or a sheet with its own button.
 *
 * Its own small router rather than more App screens: these pages share the
 * day's plan and hand each other a medicine or a sickness, and threading that
 * through App would be state App has no use for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Screen } from '../App';
import {
  DURATION_UNITS,
  durationLabel,
  addDays,
  describeDose,
  fmtDay as shortDay,
  isRunning,
  lastDayOf,
  medDay,
  progress,
  TIMES,
  type DurationUnit,
  type Episode,
  type TimeOfDay,
} from '../domain/doses';
import {
  addMedicine,
  blankMedForm,
  draftFromMedicine,
  editMedicine,
  extendSickness,
  listEpisodes,
  listStopped,
  medicineDetail,
  readMedsDay,
  recoverSickness,
  setLongTerm,
  startSickness,
  unaskedLongTerm,
  type MedDetail,
  type MedForm,
  type Medication,
  type MedsDay,
} from '../domain/medications';
import { Chevron, Plus, Sheet, useToast, Wheel } from './bits';
import { MedFormScreen, Toggle } from './MedForm';
import {
  EpisodePage,
  HistoryPage,
  LabelCheckPage,
  MedDetailPage,
  StoppedPage,
} from './MedPages';
import { DayLogPage, DoseGroups, LogPage } from './MedLog';

type View =
  | { kind: 'main' }
  | { kind: 'add' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; detail: MedDetail }
  | { kind: 'history' }
  | { kind: 'episode'; episode: Episode }
  | { kind: 'labels' }
  | { kind: 'stopped' }
  | { kind: 'log' }
  | { kind: 'logday'; day: string };

export function Medications({
  go,
  avatar,
}: {
  go: (s: Screen) => void;
  avatar?: React.ReactNode;
}) {
  const [view, setView] = useState<View>({ kind: 'main' });
  const [plan, setPlan] = useState<MedsDay | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [stoppedCount, setStoppedCount] = useState(0);
  const toast = useToast();

  const refresh = useCallback(async () => {
    const [p, e, s] = await Promise.all([readMedsDay(), listEpisodes(), listStopped()]);
    setPlan(p);
    setEpisodes(e);
    setStoppedCount(s.length);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };
  const home = () => {
    open({ kind: 'main' });
    void refresh();
  };

  const day = plan?.day ?? medDay();
  const past = episodes.filter((e) => !isRunning(e, day) && e.started_on <= day);

  if (view.kind === 'add') {
    return (
      <MedFormScreen
        mode="add"
        initial={blankMedForm()}
        sickness={plan?.episode ?? null}
        backLabel="Meds"
        onBack={home}
        onSave={async (f: MedForm) => {
          await addMedicine(f, plan?.episode?.id ?? null);
          toast(`${f.name.trim()} added`);
          home();
        }}
      />
    );
  }
  if (view.kind === 'detail') {
    return (
      <MedDetailPage
        id={view.id}
        onBack={home}
        onEdit={async () => {
          const d = await medicineDetail(view.id);
          if (d) open({ kind: 'edit', detail: d });
        }}
      />
    );
  }
  if (view.kind === 'edit') {
    const d = view.detail;
    return (
      <MedFormScreen
        mode="edit"
        initial={draftFromMedicine(d)}
        sickness={d.episode}
        sharedEntry={!!d.product && !d.product.private}
        backLabel="Cancel"
        onBack={() => open({ kind: 'detail', id: d.med.id })}
        onSave={async (f: MedForm) => {
          await editMedicine(d.med.id, f);
          toast('Saved');
          open({ kind: 'detail', id: d.med.id });
        }}
      />
    );
  }
  if (view.kind === 'history') {
    return (
      <HistoryPage
        episodes={past}
        onBack={home}
        onOpen={(episode) => open({ kind: 'episode', episode })}
      />
    );
  }
  if (view.kind === 'episode') {
    return <EpisodePage episode={view.episode} onBack={() => open({ kind: 'history' })} />;
  }
  if (view.kind === 'labels') return <LabelCheckPage onBack={home} />;
  if (view.kind === 'log') {
    return <LogPage onBack={home} onDay={(day) => open({ kind: 'logday', day })} />;
  }
  if (view.kind === 'logday') {
    return <DayLogPage day={view.day} onBack={() => open({ kind: 'log' })} />;
  }
  if (view.kind === 'stopped') return <StoppedPage onBack={home} />;

  return (
    <MainView
      go={go}
      avatar={avatar}
      plan={plan}
      pastCount={past.length}
      stoppedCount={stoppedCount}
      refresh={refresh}
      open={open}
    />
  );
}

// -------------------------------------------------------------- the screen

function MainView({
  go,
  avatar,
  plan,
  pastCount,
  stoppedCount,
  refresh,
  open,
}: {
  go: (s: Screen) => void;
  avatar?: React.ReactNode;
  plan: MedsDay | null;
  pastCount: number;
  stoppedCount: number;
  refresh: () => Promise<void>;
  open: (v: View) => void;
}) {
  const [sheet, setSheet] = useState<null | 'start' | 'extend' | 'recover'>(null);
  const toast = useToast();

  const episode = plan?.episode ?? null;
  const all = useMemo(() => plan?.groups.flatMap((g) => g.doses) ?? [], [plan]);
  const taken = all.filter((p) => p.state === 'taken').length;

  return (
    <>
      <span className="mwash" />
      <div className="top">
        <button className="back" onClick={() => go('home')}>
          <Chevron />
          Home
        </button>
        <div className="grow" />
        {avatar}
      </div>

      <section className="mcard" data-mode={episode ? 'sick' : 'regular'}>
        <div className="mswitch">
          <button aria-pressed={!episode} onClick={() => episode && setSheet('recover')}>
            <i />
            Regular
          </button>
          <button aria-pressed={!!episode} onClick={() => !episode && setSheet('start')}>
            <i />
            Sick
          </button>
        </div>

        {episode && plan ? (
          <SickBody
            episode={episode}
            day={plan.day}
            onRecover={() => setSheet('recover')}
            onExtend={() => setSheet('extend')}
          />
        ) : (
          <>
            <div className="mk">Today</div>
            <div className="mbig">
              <span className="n num">{taken}</span>
              <span className="of">
                of {all.length} {all.length === 1 ? 'dose' : 'doses'} taken
              </span>
            </div>
            <div className="mmeter">
              <i style={{ width: all.length ? `${(taken / all.length) * 100}%` : 0 }} />
            </div>
          </>
        )}
      </section>

      {plan && plan.groups.length === 0 && plan.unscheduled.length === 0 && (
        <>
          <div className="section-h">Today</div>
          <p className="empty-note">
            {episode ? 'Nothing for this sickness yet.' : 'Nothing to take today.'}
          </p>
        </>
      )}

      {plan && (
        <DoseGroups plan={plan} onOpen={(id) => open({ kind: 'detail', id })} onChanged={refresh} />
      )}

      {plan && plan.unscheduled.length > 0 && (
        <>
          <div className="section-h">Times not set</div>
          {plan.unscheduled.map((m) => (
            <MedLine key={m.id} med={m} line={m.schedule || 'no schedule recorded'}
              onOpen={() => open({ kind: 'detail', id: m.id })} />
          ))}
        </>
      )}

      {plan && plan.paused.length > 0 && (
        <>
          <div className="section-h">
            Paused while sick
            <span className="k num">{plan.paused.length}</span>
          </div>
          {plan.paused.map(({ med, doses }) => (
            <MedLine
              key={med.id}
              med={med}
              paused
              line={
                doses.length
                  ? doses.map((d) => `${describeDose({ ...d, meal: null })} · ${label(d.time_of_day)}`).join(', ')
                  : med.schedule || 'no schedule recorded'
              }
              onOpen={() => open({ kind: 'detail', id: med.id })}
            />
          ))}
        </>
      )}

      <button className="cta cta--meds" onClick={() => open({ kind: 'add' })}>
        <Plus size={17} />
        Add meds
        {episode && <small>for {episode.name}</small>}
      </button>

      <div className="linkrows">
        <LinkRow name="Medicine log" note="taken · skipped · missed" onClick={() => open({ kind: 'log' })} />
        <LinkRow name="Label check" note="FDA labels" onClick={() => open({ kind: 'labels' })} />
        <LinkRow
          name="Sickness history"
          note={pastCount ? `${pastCount} past` : 'none yet'}
          onClick={() => open({ kind: 'history' })}
        />
        {stoppedCount > 0 && (
          <LinkRow name="Stopped" note={String(stoppedCount)} onClick={() => open({ kind: 'stopped' })} />
        )}
      </div>

      <div className="foot">Mealo never suggests a dose.</div>

      <StartSheet
        open={sheet === 'start'}
        day={plan?.day ?? medDay()}
        onClose={() => setSheet(null)}
        onStarted={async (name) => {
          setSheet(null);
          toast(`Sick mode on: ${name}`);
          await refresh();
        }}
      />
      {episode && (
        <>
          <ExtendSheet
            open={sheet === 'extend'}
            episode={episode}
            onClose={() => setSheet(null)}
            onDone={async (last) => {
              setSheet(null);
              toast(`Extended to ${shortDay(last)}`);
              await refresh();
            }}
          />
          <Sheet open={sheet === 'recover'} onClose={() => setSheet(null)} label="Recovered">
            <h2 className="guard-title">Recovered?</h2>
            <p className="guard-line">Ends {episode.name} today and goes back to Regular.</p>
            <button
              className="cta"
              onClick={async () => {
                await recoverSickness(episode, plan!.day);
                setSheet(null);
                toast('Back to Regular');
                await refresh();
              }}
            >
              Recovered
            </button>
            <button className="cta cta--ghost" onClick={() => setSheet(null)}>
              Not yet
            </button>
          </Sheet>
        </>
      )}
    </>
  );
}

const label = (t: TimeOfDay | null) => (TIMES.find((x) => x.id === t)?.label ?? '').toLowerCase();

function SickBody({
  episode,
  day,
  onRecover,
  onExtend,
}: {
  episode: Episode;
  day: string;
  onRecover: () => void;
  onExtend: () => void;
}) {
  const p = progress(episode, day);
  return (
    <>
      <div className="mk">
        Day {p.day} of {p.total}
      </div>
      <div className="mname">{episode.name}</div>
      <div className="mbig">
        <span className="n num">{p.toGo}</span>
        <span className="of">{p.toGo === 1 ? 'day to go' : 'days to go'}</span>
      </div>
      <div className="mmeter">
        <i style={{ width: `${((p.day - 1) / p.total) * 100}%` }} />
      </div>
      <div className="mdates">
        started {shortDay(episode.started_on)} · last day {shortDay(episode.last_day)}
      </div>
      <div className="macts">
        <button className="well" onClick={onRecover}>
          Recovered
        </button>
        <button onClick={onExtend}>Extend</button>
      </div>
    </>
  );
}

function MedLine({
  med,
  line,
  paused = false,
  onOpen,
}: {
  med: Medication;
  line: string;
  paused?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="row dose" data-state={paused ? 'paused' : undefined}>
      <button className="row-tap" onClick={onOpen}>
        <span className="grow">
          <span className="nm" style={{ display: 'block' }}>
            {med.name}
            {med.dose_text && <span className="str num">{med.dose_text}</span>}
          </span>
          <span className="amt">{line}</span>
        </span>
        <Chevron dir="right" />
      </button>
    </div>
  );
}

function LinkRow({ name, note, onClick }: { name: string; note: string; onClick: () => void }) {
  return (
    <div className="row linkrow">
      <button className="row-tap" onClick={onClick}>
        <span className="grow nm">{name}</span>
        <span className="k num">{note}</span>
        <Chevron dir="right" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------- the sheets

const NUMS = Array.from({ length: 30 }, (_, i) => i + 1);

/** The two wheels — how many, of what — and the last day they come to. */
function Duration({
  n,
  unit,
  setN,
  setUnit,
}: {
  n: number;
  unit: DurationUnit;
  setN: (n: number) => void;
  setUnit: (u: DurationUnit) => void;
}) {
  return (
    <div className="sk-wheels">
      <Wheel values={NUMS} value={n} render={(v) => String(v)} onChange={(v) => setN(v as number)} />
      <Wheel
        values={[...DURATION_UNITS]}
        value={unit}
        render={(v) => {
          const u = String(v);
          return n === 1 ? u.charAt(0).toUpperCase() + u.slice(1, -1) : u.charAt(0).toUpperCase() + u.slice(1);
        }}
        onChange={(v) => setUnit(v as DurationUnit)}
      />
    </div>
  );
}

function StartSheet({
  open,
  day,
  onClose,
  onStarted,
}: {
  open: boolean;
  day: string;
  onClose: () => void;
  onStarted: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [n, setN] = useState(7);
  const [unit, setUnit] = useState<DurationUnit>('days');
  /**
   * Regular medicines nobody has said yes or no to, with the answer being
   * given here. Every one existed before the Long-Term switch did. They are
   * asked about now, before Start, because the alternative is a thyroid
   * tablet quietly paused for a fortnight by a default nobody chose.
   */
  const [unasked, setUnasked] = useState<Medication[]>([]);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void unaskedLongTerm().then((list) => {
      setUnasked(list);
      setKeep({});
    });
  }, [open]);

  const last = lastDayOf(day, n, unit);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const m of unasked) await setLongTerm(m.id, !!keep[m.id]);
      await startSickness(name, n, unit, day);
      const said = name.trim();
      setName('');
      setN(7);
      setUnit('days');
      await onStarted(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} label="Start sick mode">
      <h3>Start sick mode</h3>
      <div className="field-lbl">Sickness</div>
      <div className="search">
        <input
          id="sick-name"
          value={name}
          placeholder="e.g. Viral fever"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field-lbl">How long</div>
      <Duration n={n} unit={unit} setN={setN} setUnit={setUnit} />
      <div className="sk-ends">
        {durationLabel(n, unit)} · last day <b>{shortDay(last)}</b>
      </div>

      {unasked.length > 0 && (
        <div className="sk-ask">
          <div className="field-lbl">Keep taking while sick?</div>
          {unasked.map((m) => (
            <Toggle
              key={m.id}
              on={!!keep[m.id]}
              onFlip={() => setKeep((k) => ({ ...k, [m.id]: !k[m.id] }))}
              name={m.name}
              hint={keep[m.id] ? 'Long-Term — keeps going' : 'Pauses until you recover'}
            />
          ))}
        </div>
      )}

      {error && <p className="small bad-text">{error}</p>}
      <button className="done sick" disabled={busy || !name.trim()} onClick={() => void start()}>
        Start sick mode
      </button>
    </Sheet>
  );
}

function ExtendSheet({
  open,
  episode,
  onClose,
  onDone,
}: {
  open: boolean;
  episode: Episode;
  onClose: () => void;
  onDone: (last: string) => Promise<void>;
}) {
  const [n, setN] = useState(3);
  const [unit, setUnit] = useState<DurationUnit>('days');
  const last = lastDayOf(addDays(episode.last_day, 1), n, unit);

  return (
    <Sheet open={open} onClose={onClose} label="Extend">
      <h3>Extend {episode.name}</h3>
      <div className="field-lbl">By</div>
      <Duration n={n} unit={unit} setN={setN} setUnit={setUnit} />
      <div className="sk-ends">
        last day {shortDay(episode.last_day)} → <b>{shortDay(last)}</b>
      </div>
      <button
        className="done sick"
        onClick={async () => {
          const l = await extendSickness(episode, n, unit);
          await onDone(l);
        }}
      >
        Extend
      </button>
    </Sheet>
  );
}
