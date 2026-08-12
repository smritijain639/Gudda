import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './components/Login.jsx';
import Chat from './components/Chat.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import BotMark from './components/BotMark.jsx';

let chatSeq = 0;
const newChatId = () => `c${Date.now()}_${chatSeq++}`;
const emptyChat = () => ({ id: newChatId(), title: 'New chat', messages: [] });

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState('chat'); // chat | audit
  // Chat sessions live here (not inside <Chat/>) so they survive view toggles
  // and starting new chats. Persisted per user in localStorage.
  const [chats, setChats] = useState([emptyChat()]);
  const [activeId, setActiveId] = useState(() => chats[0].id);
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

  // Load persisted chats for this user once the session is known.
  const username = session?.user?.username || null;
  useEffect(() => {
    if (!username) return;
    try {
      const raw = localStorage.getItem(`vsbot-chats-${username}`);
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved) && saved.length) {
        setChats(saved);
        setActiveId(saved[0].id);
        return;
      }
    } catch {
      /* ignore corrupt storage */
    }
    const fresh = emptyChat();
    setChats([fresh]);
    setActiveId(fresh.id);
  }, [username]);

  // Persist chats whenever they change.
  useEffect(() => {
    if (!username) return;
    try {
      localStorage.setItem(`vsbot-chats-${username}`, JSON.stringify(chats));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [username, chats]);

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

  const displayName = session.user?.username || 'there';
  const initials = displayName.slice(0, 2).toUpperCase();
  const activeChat = chats.find((c) => c.id === activeId) || chats[0];

  function newChat() {
    setView('chat');
    // Reuse an existing empty chat instead of stacking blank ones.
    const existingEmpty = chats.find((c) => c.messages.length === 0);
    if (existingEmpty) {
      setActiveId(existingEmpty.id);
      return;
    }
    const fresh = emptyChat();
    setChats((cs) => [fresh, ...cs]);
    setActiveId(fresh.id);
  }

  function selectChat(id) {
    setView('chat');
    setActiveId(id);
  }

  // Called by <Chat/> whenever its message list changes. Updates the active
  // chat's messages and derives a title from the first user message.
  function updateActiveChat(messages) {
    setChats((cs) =>
      cs.map((c) => {
        if (c.id !== activeChat.id) return c;
        const firstUser = messages.find((m) => m.role === 'user');
        const title =
          c.title !== 'New chat'
            ? c.title
            : firstUser
              ? firstUser.text.slice(0, 40) + (firstUser.text.length > 40 ? '…' : '')
              : 'New chat';
        return { ...c, messages, title };
      })
    );
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
          {chats.map((c) => (
            <button
              type="button"
              key={c.id}
              className={c.id === activeChat.id && view === 'chat' ? 'recent active' : 'recent'}
              onClick={() => selectChat(c.id)}
              title={c.title}
            >
              <ChatIcon /> <span className="recent-title">{c.title}</span>
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div className="user-row">
            <div className="avatar-circle">{initials}</div>
            <div className="user-lines">
              <strong>{displayName}</strong>
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
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <BotMark size={22} />
            <span className="topbar-title">
              {view === 'chat' ? activeChat.title : 'Activity log'}
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
            <Chat
              key={activeChat.id}
              username={displayName}
              messages={activeChat.messages}
              onMessagesChange={updateActiveChat}
            />
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
