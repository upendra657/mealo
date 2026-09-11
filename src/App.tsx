import { useState } from 'react';
import { Playground } from './ui/Playground';
import { SettingsScreen } from './ui/SettingsScreen';
import { StatusBar } from './ui/StatusBar';
import './styles.css';

type Tab = 'playground' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('playground');

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Mealo</h1>
            <p className="muted small">Phase 0 — skeleton, adapter, storage</p>
          </div>
        </div>
        <nav className="tabs">
          <button
            className={tab === 'playground' ? 'tab active' : 'tab'}
            onClick={() => setTab('playground')}
          >
            Playground
          </button>
          <button
            className={tab === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      <StatusBar />

      <main className="main">
        {tab === 'playground' ? (
          <Playground />
        ) : (
          <SettingsScreen onSaved={() => setTab('playground')} />
        )}
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
