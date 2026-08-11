import React, { useState } from 'react';
import { api } from '../api.js';
import BotMark from './BotMark.jsx';

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const session = await api.login({ username, password });
      onLoggedIn(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-brand">
        <BotMark size={64} />
        <div className="brand-pill">Roche</div>
        <h1 className="brand-name">VS Bot</h1>
        <p className="brand-tag">Vault Support Bot · RIM Lifecycle</p>
      </div>

      <div className="login-card">
        <h2>Sign in to continue</h2>
        <p className="muted center">Enter your Vault credentials to access VS Bot.</p>

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>User ID</span>
            <div className="input-wrap">
              <svg viewBox="0 0 24 24" className="input-ico" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z"
                />
              </svg>
              <input
                type="text"
                placeholder="user@example.com"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
          </label>

          <label className="field">
            <span>Password</span>
            <div className="input-wrap">
              <svg viewBox="0 0 24 24" className="input-ico" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm3 8H9V6a3 3 0 0 1 6 0v3Z"
                />
              </svg>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </label>

          {error && <div className="alert error">{error}</div>}

          <button type="submit" className="btn-primary block" disabled={loading}>
            {loading ? 'Signing in…' : '→ Sign in'}
          </button>
        </form>
      </div>

      <p className="login-footer">
        © {new Date().getFullYear()} F. Hoffmann-La Roche Ltd. For authorized use only.
      </p>
    </div>
  );
}
