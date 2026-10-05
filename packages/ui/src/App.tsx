import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useApi, useHotkey } from './hooks';
import { IncidentsPage } from './pages/IncidentsPage';
import { IncidentPage } from './pages/IncidentPage';
import { ReplaysPage } from './pages/ReplaysPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { ServicesPage } from './pages/ServicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { DiffPage } from './pages/DiffPage';
import { useRef } from 'react';

function Logo() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={8} r={7} fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M8 3v5l3.5 2" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function App() {
  const health = useApi(() => api.healthz(), []);
  const searchRef = useRef<HTMLInputElement>(null);

  useHotkey((e) => {
    if (e.key === '/' && searchRef.current) {
      e.preventDefault();
      searchRef.current.focus();
    }
  });

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          recurr
        </div>
        <nav className="nav">
          <NavLink to="/incidents">Incidents</NavLink>
          <NavLink to="/replays">Replays</NavLink>
          <NavLink to="/scenarios">Scenarios</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-right">
          {health.data?.store && <span className="store-chip" title={health.data.store}>store: {health.data.store}</span>}
          {health.data && <span>schema v{health.data.schemaVersion}</span>}
          {health.error && <span style={{ color: 'var(--err)' }}>api unreachable</span>}
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/incidents" replace />} />
          <Route path="/incidents" element={<IncidentsPage searchRef={searchRef} />} />
          <Route path="/incidents/:id" element={<IncidentPage />} />
          <Route path="/incidents/:id/diff/:rid" element={<DiffPage />} />
          <Route path="/replays" element={<ReplaysPage />} />
          <Route path="/replays/:id" element={<IncidentPage isReplay />} />
          <Route path="/scenarios" element={<ScenariosPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/services/:name" element={<ServicesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/incidents" replace />} />
        </Routes>
      </main>
    </div>
  );
}
