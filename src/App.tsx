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
import { Day } from './ui/Day';
import { Doctor } from './ui/Doctor';
import { FoodLibrary } from './ui/FoodLibrary';
import { Home } from './ui/Home';
import { Insights } from './ui/Insights';
import { LogFlow } from './ui/LogFlow';
import { Medications } from './ui/Medications';
import { SettingsScreen } from './ui/SettingsScreen';
import { TargetsScreen } from './ui/TargetsScreen';
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
  | 'library'
  | 'targets'
  | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState(activeProfile());
  const [failed, setFailed] = useState<string | null>(null);
  /** Which day the meal screens are looking at, as local midnight. */
  const [dayStart, setDayStart] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await initDb();
        const { profiles: list, active: id } = await initProfiles();
        setProfiles(list);
        setActive(id);
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

  return (
    <ToastHost>
      {/* Keyed on the profile: switching person remounts every screen rather
          than asking each one to notice. */}
      <div className="shell" key={active}>
        {screen === 'home' && (
          <>
            <div className="top">
              <div>
                <h1>Mealo</h1>
                <p className="small muted" style={{ margin: 0 }}>
                  Local-first · nothing leaves this device
                </p>
              </div>
              <div className="grow" />
              {avatar}
            </div>
            <Home go={go} />
          </>
        )}

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

        {screen === 'doctor' && <Doctor go={go} />}

        {screen === 'meds' && <Medications go={go} />}

        {screen === 'dev' && <SettingsScreen go={go} />}

        {screen === 'settings' && <SettingsScreen go={go} />}
      </div>
    </ToastHost>
  );
}
