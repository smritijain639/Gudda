import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './components/Login.jsx';
import Chat from './components/Chat.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import BotMark from './components/BotMark.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState('chat'); // chat | audit
  const [chatKey, setChatKey] = useState(0); // bump to start a new chat
  const [theme, setTheme] = useState(
    () => localStorage.getItem('vsbot-theme') || 'dark'
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vsbot-theme', theme);
  }, [theme]);

  useEffect(() => {
    api
      .me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setSession(null);
    }
  }

  if (checking) {
    return (
      <div className="app-center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return <Login onLoggedIn={setSession} />;
  }

  const username = session.user?.username || 'there';
  const initials = username.slice(0, 2).toUpperCase();

  function newChat() {
    setView('chat');
    setChatKey((k) => k + 1);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <div className="brand-pill sm">Roche</div>
          <div className="brand-lines">
            <strong>VS Bot</strong>
            <span className="muted">Vault Support Bot</span>
          </div>
        </div>

        <button type="button" className="new-chat" onClick={newChat}>
          <span className="plus">+</span> New chat
        </button>

        <div className="side-section">RECENT</div>
        <nav className="recents">
          <button type="button" className="recent active">
            <ChatIcon /> Current session
          </button>
        </nav>

        <div className="side-foot">
          <div className="user-row">
            <div className="avatar-circle">{initials}</div>
            <div className="user-lines">
              <strong>{username}</strong>
              <span className="muted">
                {session.objectCount != null
                  ? `${session.objectCount} objects available`
                  : 'Business Admin scope'}
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
            >
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  fill="currentColor"
                  d="M16 17v-3H9v-4h7V7l5 5-5 5M14 2a2 2 0 0 1 2 2v2h-2V4H5v16h9v-2h2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9Z"
                />
              </svg>
            </button>
          </div>
          <div className="conn-pill">● Business Admin connected</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <BotMark size={22} />
            <span className="topbar-title">
              {view === 'chat' ? 'New chat' : 'Activity log'}
            </span>
          </div>
          <div className="topbar-right">
            <div className="seg">
              <button
                type="button"
                className={view === 'chat' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setView('chat')}
              >
                Chat
              </button>
              <button
                type="button"
                className={view === 'audit' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setView('audit')}
              >
                Audit
              </button>
            </div>
            <span className="conn-dot">● Connected</span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </header>

        <main className="main-content">
          {view === 'chat' ? (
            <Chat key={chatKey} username={username} />
          ) : (
            <div className="audit-wrap">
              <ActivityLog />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16">
      <path
        fill="currentColor"
        d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2Z"
      />
    </svg>
  );
}
