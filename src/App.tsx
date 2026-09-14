import { useCallback, useEffect, useState } from 'react';
import { initDb } from './db/client';
import { initProfiles, listProfiles, activeProfile, type Profile } from './profiles/store';
import { Doctor } from './ui/Doctor';
import { FoodLibrary } from './ui/FoodLibrary';
import { LogMeal } from './ui/LogMeal';
import { Medications } from './ui/Medications';
import { Playground } from './ui/Playground';
import { SettingsScreen } from './ui/SettingsScreen';
import { StatusBar } from './ui/StatusBar';
import { ProfileSwitch } from './ui/ProfileSwitch';
import { Today } from './ui/Today';
import './styles.css';

type Tab = 'today' | 'doctor' | 'food' | 'library' | 'meds' | 'settings' | 'dev';

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'food', label: 'Food' },
  { id: 'library', label: 'Library' },
  { id: 'meds', label: 'Meds' },
  { id: 'settings', label: 'Settings' },
  { id: 'dev', label: 'Dev' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [startAdding, setStartAdding] = useState(false);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState(activeProfile());

  // Settle who is logging before anything renders. Every screen reads
  // profile-filtered data, and a first paint under the wrong profile would
  // show one person the other's day for a frame — or, worse, let them log
  // into it.
  const syncProfiles = useCallback(async () => {
    await initDb();
    const { profiles: list, active: id } = await initProfiles();
    setProfiles(list);
    setActive(id);
  }, []);

  useEffect(() => {
    void syncProfiles();
  }, [syncProfiles]);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await listProfiles());
    setActive(activeProfile());
  }, []);

  const goAdd = () => {
    setStartAdding(true);
    setTab('meds');
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Mealo</h1>
            <p className="muted small">Doctor · Nutritionist · Pharmacist</p>
          </div>
        </div>
        {profiles && profiles.length > 0 && (
          <ProfileSwitch
            profiles={profiles}
            active={active}
            onChanged={refreshProfiles}
          />
        )}
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => {
                if (t.id !== 'meds') setStartAdding(false);
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <StatusBar />

      <main className="main" key={active}>
        {tab === 'today' && <Today onAdd={goAdd} />}
        {tab === 'doctor' && <Doctor />}
        {tab === 'food' && <LogMeal />}
        {tab === 'library' && <FoodLibrary />}
        {tab === 'meds' && <Medications startAdding={startAdding} />}
        {tab === 'settings' && <SettingsScreen />}
        {tab === 'dev' && <Playground />}
      </main>

      <footer className="footer">
        <p className="small muted">
          Not a medical device. Informational only — it does not diagnose, and it
          never suggests a dose.
        </p>
      </footer>
    </div>
  );
}
