import { useState } from 'react';
import { Doctor } from './ui/Doctor';
import { LogMeal } from './ui/LogMeal';
import { Medications } from './ui/Medications';
import { Playground } from './ui/Playground';
import { SettingsScreen } from './ui/SettingsScreen';
import { StatusBar } from './ui/StatusBar';
import { Today } from './ui/Today';
import './styles.css';

type Tab = 'today' | 'doctor' | 'food' | 'meds' | 'settings' | 'dev';

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'food', label: 'Food' },
  { id: 'meds', label: 'Meds' },
  { id: 'settings', label: 'Settings' },
  { id: 'dev', label: 'Dev' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [startAdding, setStartAdding] = useState(false);

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

      <main className="main">
        {tab === 'today' && <Today onAdd={goAdd} />}
        {tab === 'doctor' && <Doctor />}
        {tab === 'food' && <LogMeal />}
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
