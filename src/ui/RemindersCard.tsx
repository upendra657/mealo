import { useEffect, useState } from 'react';
import { TIMES } from '../domain/doses';
import { SCHEDULE_DAYS, type ReminderSettings } from '../domain/reminders';
import { loadReminders, saveReminders, standing, turnOff, turnOn, type Standing } from '../domain/remindersync';
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

function Switch({ on, label, note, onFlip, disabled }: { on: boolean; label: string; note?: string; onFlip: () => void; disabled?: boolean }) {
  return (
    <button className="lt" role="switch" aria-checked={on} onClick={onFlip} disabled={disabled}>
      <span className="grow">
        <span className="nm">{label}</span>
        {note && <span className="amt">{note}</span>}
      </span>
      <span className="switch" />
    </button>
  );
}

const readAll = () => Promise.all([standing(), loadReminders(), listProfiles()]);

export function RemindersCard() {
  const [where, setWhere] = useState<Standing | null>(null);
  const [s, setS] = useState<ReminderSettings | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = ([st, settings, people]: Awaited<ReturnType<typeof readAll>>) => {
    setWhere(st);
    setS(settings);
    setOwner(people.find((p) => p.id === (settings.on ? settings.profileId : activeProfile()))?.name ?? null);
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
  const set = async (patch: Partial<ReminderSettings>) => setS(await saveReminders(patch));

  return (
    <section className="card">
      <h2>Reminders</h2>
      {WHY[where] ? (
        <p className="small muted">{WHY[where]}</p>
      ) : (
        <>
          <Switch
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
