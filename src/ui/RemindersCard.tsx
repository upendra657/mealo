import { useEffect, useState } from 'react';
import { TIMES } from '../domain/doses';
import { SCHEDULE_DAYS, type ReminderSettings } from '../domain/reminders';
import {
  loadRelayState,
  loadReminders,
  saveReminders,
  sendTest,
  standing,
  turnOff,
  turnOn,
  type RelayState,
  type Standing,
} from '../domain/remindersync';
import { clock } from '../domain/chat';
import { Chevron } from './bits';
import { activeProfile } from '../lib/active-profile';
import { listProfiles } from '../profiles/store';

/**
 * Reminders, on the settings screen.
 *
 * The switch is the only place the permission prompt is ever raised, and it
 * is raised by the tap on it: a browser shows that prompt only in answer to
 * a tap, and an iPhone shows it once. Asking at start-up would spend the one
 * chance on someone who had not asked for anything.
 *
 * Each state the phone can be in gets its own plain sentence rather than a
 * greyed-out switch, because the three reasons a switch might not work here
 * (not installed to the Home Screen, blocked in the phone's settings, no
 * keys on this deployment) each need a different thing done by a different
 * person.
 */
const WHY: Partial<Record<Standing, string>> = {
  unsupported: 'This browser cannot show reminders.',
  'needs-install':
    'On an iPhone, reminders work once Mealo is on the Home Screen. In Safari: Share, then Add to Home Screen. Open Mealo from there and come back to this card.',
  'not-set-up':
    'Reminders are not set up on this copy of Mealo. Whoever runs it makes a key pair once and gives it to the server; the steps are at the top of scripts/vapid-keys.mjs.',
  blocked: 'Notifications are blocked for Mealo in this phone’s settings. Allow them there, then turn this on.',
};

function Switch({ on, label, note, onFlip, disabled, first }: { on: boolean; label: string; note?: string; onFlip: () => void; disabled?: boolean; first?: boolean }) {
  return (
    <button className="lt" role="switch" aria-checked={on} onClick={onFlip} disabled={disabled} style={first ? { marginTop: 0 } : undefined}>
      <span className="grow">
        <span className="nm">{label}</span>
        {note && <span className="amt">{note}</span>}
      </span>
      <span className="switch" />
    </button>
  );
}

const readAll = () => Promise.all([standing(), loadReminders(), listProfiles(), loadRelayState()]);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "today at 07:00", "tomorrow at 21:00", "Sat 17 Oct at 08:00". */
function whenOf(at: number, now = new Date()): string {
  const d = new Date(at);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(now)) / 86_400_000);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} at ${clock(at)}`;
}
const dayOf = (at: number) => {
  const d = new Date(at);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/**
 * What the last hand-over to the relay came to, in a line. Built from what
 * the relay answered, not from the switch: the switch said "on" all the
 * night of 14 Oct while the relay had no keys and nothing could ring.
 */
function StateLine({ state }: { state: RelayState | null }) {
  if (!state) return <div className="dv-state">Setting up. Open Mealo again in a moment to see what is set.</div>;
  if (!state.ok) {
    return (
      <div className="dv-state" data-tone="warn">
        <b>Not set up on the relay.</b> It did not take this phone’s list at {clock(state.at)} (
        {state.status ? `it answered ${state.status}` : 'it could not be reached'}). Nothing will ring until it does; Mealo tries again
        each time it is opened.
      </div>
    );
  }
  if (!state.next || state.count === 0) {
    return (
      <div className="dv-state" data-tone="ok">
        <b>Working.</b> Nothing is due to ring in the next {SCHEDULE_DAYS} days.
      </div>
    );
  }
  return (
    <div className="dv-state" data-tone="ok">
      <b>Working.</b> Next: {whenOf(state.next.at)}, {state.next.title}.
      {state.count > 1 && state.until ? ` ${state.count - 1} more set, up to ${dayOf(state.until)}.` : ''}
    </div>
  );
}

export function RemindersCard() {
  const [where, setWhere] = useState<Standing | null>(null);
  const [s, setS] = useState<ReminderSettings | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<RelayState | null>(null);
  const [open, setOpen] = useState(false);
  const [tested, setTested] = useState<string | null>(null);

  const show = ([st, settings, people, relay]: Awaited<ReturnType<typeof readAll>>) => {
    setWhere(st);
    setS(settings);
    setOwner(people.find((p) => p.id === (settings.on ? settings.profileId : activeProfile()))?.name ?? null);
    setState(relay);
  };
  const read = async () => show(await readAll());
  useEffect(() => {
    let live = true;
    void readAll().then((all) => live && show(all));
    return () => {
      live = false;
    };
    // Once, on arrival: `show` only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!where || !s) return null;

  const on = where === 'on';
  // Turned on by someone else on this phone: theirs to change, not this person's.
  const others = on && s.profileId !== activeProfile();
  const set = async (patch: Partial<ReminderSettings>) => {
    setS(await saveReminders(patch));
    setState(await loadRelayState());
  };

  const test = async () => {
    setBusy(true);
    try {
      const at = await sendTest();
      setState(await loadRelayState());
      setTested(at === null ? 'The test could not be set: the relay did not take the list.' : `Set for ${clock(at)}. Lock the phone to see it arrive.`);
    } finally {
      setBusy(false);
    }
  };

  const doseTimes = TIMES.map((t) => s.times[t.id]).join(', ');
  const summary = [s.doses ? `Medicines ${doseTimes}` : 'No medicines', s.meals ? `meals ${s.mealTime}` : 'no meals', s.week ? `week Sun ${s.weekTime}` : 'no week'].join(' · ');

  return (
    <section className="card">
      {WHY[where] ? (
        <p className="small muted" style={{ margin: 0 }}>{WHY[where]}</p>
      ) : (
        <>
          <Switch
            first
            on={on}
            disabled={busy || others}
            label="Reminders on this phone"
            note={
              others
                ? `These are ${owner ?? 'someone else'}’s. Switch to that person to change them.`
                : owner
                  ? `For ${owner}’s medicines and meals.`
                  : undefined
            }
            onFlip={async () => {
              setBusy(true);
              try {
                if (on) await turnOff();
                else await turnOn();
                await read();
              } finally {
                setBusy(false);
              }
            }}
          />
          {on && !others && (
            <>
              <StateLine state={state} />
              <button className="bk-btn" disabled={busy} onClick={() => void test()}>
                Send a test reminder
              </button>
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                {tested ?? 'Rings within a minute or two. Lock the phone to see it arrive.'}
              </p>
              <button className="dv-go" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                <span className="grow">
                  Times and what rings
                  <span className="amt">{summary}</span>
                </span>
                <Chevron dir={open ? 'down' : 'right'} />
              </button>
            </>
          )}
          {on && !others && open && (
            <>
              <Switch on={s.doses} label="Medicines that are due" note="One reminder for each part of the day with something still to take." onFlip={() => void set({ doses: !s.doses })} />
              {s.doses && (
                <>
                  {TIMES.map((t) => (
                    <label className="field" key={t.id}>
                      <span>{t.label} at</span>
                      <input type="time" value={s.times[t.id]} onChange={(e) => e.target.value && void set({ times: { ...s.times, [t.id]: e.target.value } })} />
                    </label>
                  ))}
                  <Switch
                    on={s.names}
                    label="Show medicine names"
                    note={s.names ? 'The lock screen names each medicine. Never an amount.' : 'The lock screen says only "Morning medicines".'}
                    onFlip={() => void set({ names: !s.names })}
                  />
                </>
              )}
              <Switch on={s.meals} label="Meals, in the evening" note="Only on a day with nothing logged." onFlip={() => void set({ meals: !s.meals })} />
              {s.meals && (
                <label className="field">
                  <span>Meals at</span>
                  <input type="time" value={s.mealTime} onChange={(e) => e.target.value && void set({ mealTime: e.target.value })} />
                </label>
              )}
              <Switch on={s.week} label="Your week, on Sunday" note="Sunday to Saturday, ready in Ask Mealo. The lock screen gives no figures." onFlip={() => void set({ week: !s.week })} />
              {s.week && (
                <label className="field">
                  <span>Sunday at</span>
                  <input type="time" value={s.weekTime} onChange={(e) => e.target.value && void set({ weekTime: e.target.value })} />
                </label>
              )}
            </>
          )}
          <p className="small muted" style={{ marginTop: 14 }}>
            What leaves this phone is the times to ring, and nothing else. The words are written here, on the phone. Reminders are set
            for the next {SCHEDULE_DAYS} days each time you open Mealo.
          </p>
        </>
      )}
    </section>
  );
}
