/**
 * The shell.
 *
 * Screens, not tabs. You come in at the grid, go one level down into what you
 * came for, and come back. Every screen is responsible for its own header, so
 * the back button always says where it goes rather than "Back".
 *
 * Two things are settled before anything renders: the database is open, and
 * we know who is logging. A first paint under the wrong profile would show one
 * person the other's day, and — worse — let them log into it.
 */

import { useCallback, useEffect, useState } from 'react';
import { initDb } from './db/client';
import {
  activeProfile,
  initProfiles,
  listProfiles,
  type Profile,
} from './profiles/store';
import { AvatarMenu } from './ui/AvatarMenu';
import { initFoodLibrary } from './domain/foods';
import { syncLibrary } from './domain/relay';
import { startLists } from './domain/refdata';
import { startFoods } from './domain/seed';
import { startReminders } from './domain/remindersync';
import { DEMO } from './lib/demo';
import { BurnScreen } from './ui/BurnScreen';
import { Day } from './ui/Day';
import { Doctor } from './ui/Doctor';
import { FoodLibrary } from './ui/FoodLibrary';
import { Home } from './ui/Home';
import { Insights } from './ui/Insights';
import { LogFlow } from './ui/LogFlow';
import { Medications } from './ui/Medications';
import { SettingsScreen } from './ui/SettingsScreen';
import { TargetsScreen } from './ui/TargetsScreen';
import { WeightScreen } from './ui/WeightScreen';
import { ToastHost } from './ui/bits';
import './styles.css';

export type Screen =
  | 'home'
  | 'day'
  | 'log'
  | 'insights'
  | 'doctor'
  | 'meds'
  | 'dev'
  | 'weight'
  | 'burn'
  | 'library'
  | 'targets'
  | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState(activeProfile());
  const [failed, setFailed] = useState<string | null>(null);
  /** Demo only: the made-up person is still being written. */
  const [settingUp, setSettingUp] = useState(__DEMO__);
  /** Which day the meal screens are looking at, as local midnight. */
  const [dayStart, setDayStart] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await initDb();
        const { profiles: list, active: id } = await initProfiles();
        // The public demo: a made-up person, written before anything is
        // drawn so no screen is seen empty first. Loaded on demand; the
        // real app's build has no such branch and no such file in it.
        if (__DEMO__ && (await (await import('./demo/seed')).seedDemo())) {
          setProfiles(await listProfiles());
        } else {
          setProfiles(list);
        }
        setSettingUp(false);
        setActive(id);
        // Slugs for any dish that predates v6. Not awaited before the app
        // renders: it touches only a column nothing reads yet, and blocking
        // the first paint on a library backfill would be a poor trade.
        void initFoodLibrary();

        // A sync on open, if this phone is paired. Also not awaited, and it
        // swallows its own failures: the app has to work on a train with no
        // signal, so a relay that cannot be reached is a line in Settings
        // rather than anything the home screen waits for or reports.
        //
        // The reference foods go first, and sync waits for them. A portion
        // the other phone saved on a USDA food travels by that food's id, and
        // sync skips one whose food it cannot find and does not look again.
        // A failure there is a missing fallback for typed meals, not a
        // reason to hold the library back, so sync runs either way.
        void startFoods()
          .catch((e) => console.warn('[foods] reference table:', e))
          // The demo has no relay, and a stranger's browser is paired with
          // nobody.
          .then(() => (DEMO ? undefined : syncLibrary().catch(() => {})));

        // Medicine lists: clear an import the app was closed during, then
        // load the bundled HSA register if this build's copy is new. Neither
        // is awaited — search simply has fewer suggestions until they finish
        // — and neither can stop the app opening.
        void startLists().catch((e) => console.warn('[meds] reference lists:', e));

        // Reminders: bring this phone's next fortnight of rings in step with
        // the record, now and after every change. Does nothing unless they
        // were turned on here, and never raises the permission prompt: only
        // the switch in settings does that.
        if (!DEMO) startReminders();
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await listProfiles());
    setActive(activeProfile());
  }, []);

  const go = useCallback((s: Screen) => {
    setScreen(s);
    window.scrollTo(0, 0);
  }, []);

  const avatar = profiles?.length ? (
    <AvatarMenu
      profiles={profiles}
      active={active}
      onChanged={refreshProfiles}
      onSettings={() => go('settings')}
      onTargets={() => go('targets')}
    />
  ) : null;

  if (failed) {
    return (
      <div className="shell">
        <div className="top">
          <h1>Mealo</h1>
        </div>
        <div className="result result--fail">
          <strong>The database would not open.</strong>
          <pre>{failed}</pre>
          <p className="small muted">
            Your settings live outside it, so a provider key is still
            reachable — but nothing can be logged until this clears.
          </p>
        </div>
      </div>
    );
  }

  // Home draws before the database has opened, which is right for the real
  // app and wrong here: a visitor would see an empty app for the two seconds
  // the person takes to write, and a reload in those seconds is what cut the
  // first run of the demo short.
  if (settingUp) {
    return (
      <div className="shell">
        <div className="demo-flag" role="note">
          Demo · made-up data · nothing leaves this browser
        </div>
        <p className="muted" style={{ marginTop: 80, textAlign: 'center' }}>
          Setting up the demo…
        </p>
      </div>
    );
  }

  return (
    <ToastHost>
      {/* Keyed on the profile: switching person remounts every screen rather
          than asking each one to notice. */}
      <div className="shell" key={active}>
        {/* On every screen, and not dismissable: someone who lands on the
            demo from a link has to be able to tell at a glance that the
            person on screen does not exist. */}
        {DEMO && (
          <div className="demo-flag" role="note">
            Demo · made-up data · nothing leaves this browser
          </div>
        )}
        {/* Home renders its own header, because the greeting in it depends on
            the time and Home is the screen that already ticks. */}
        {screen === 'home' && <Home go={go} avatar={avatar} />}

        {screen === 'day' && (
          <Day
            go={go}
            avatar={avatar}
            dayStart={dayStart}
            setDayStart={setDayStart}
          />
        )}

        {screen === 'log' && (
          <LogFlow go={go} dayStart={dayStart} />
        )}

        {screen === 'insights' && <Insights go={go} dayStart={dayStart} />}

        {screen === 'targets' && <TargetsScreen go={go} avatar={avatar} />}

        {screen === 'library' && <FoodLibrary go={go} />}

        {screen === 'doctor' && <Doctor go={go} setDayStart={setDayStart} />}

        {screen === 'meds' && <Medications go={go} avatar={avatar} />}

        {screen === 'dev' && <SettingsScreen go={go} />}
        {screen === 'weight' && <WeightScreen onBack={() => go('home')} />}
        {screen === 'burn' && <BurnScreen onBack={() => go('home')} />}

        {screen === 'settings' && <SettingsScreen go={go} />}
      </div>
    </ToastHost>
  );
}
