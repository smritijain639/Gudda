import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import BotMark from './BotMark.jsx';
import RecordCard from './RecordCard.jsx';
import { detectSmallTalk, detectActionIntent, actionPromptFor } from '../intent.js';

let idSeq = 0;
const nextId = () => `m${Date.now()}_${idSeq++}`;

const SUGGESTIONS = [
  'Show submissions in draft state',
  'Find registrations for my product',
  'List records ready for review',
];

export default function Chat({ username }) {
  const [messages, setMessages] = useState([]); // {id, role, text, records?, object?, ok?}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  function push(msg) {
    setMessages((m) => [...m, { id: nextId(), ...msg }]);
  }

  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    push({ role: 'user', text: q });

    // Conversational messages (greetings, thanks, help) get a chat reply
    // instead of being run as a Vault search.
    const smallTalk = detectSmallTalk(q, { username });
    if (smallTalk) {
      push({ role: 'bot', text: smallTalk.reply });
      inputRef.current?.focus();
      return;
    }

    // Does the user want to act on a record (delete/obsolete/edit/lifecycle)?
    const actionIntent = detectActionIntent(q);

    setBusy(true);
    try {
      const res = await api.nlSearch(q);
      const count = res.records?.length || 0;
      const notes = (res.warnings || []).join(' ');
      let text;
      if (count === 0) {
        text = actionIntent
          ? `I couldn't find any ${res.object} records to ${actionIntent}. Try naming the record (e.g. its number), or rephrase your request.`
          : `I couldn't find any records for that in ${res.object}. Try rephrasing, or ask for a different object.`;
      } else if (actionIntent) {
        // Frame the results as a pick-list for the requested action.
        text = actionPromptFor(actionIntent, res.object, count);
        if (notes) text += ` ${notes}`;
      } else {
        text = `Found ${count} record${count === 1 ? '' : 's'} in ${res.object}.`;
        if (notes) text += ` ${notes}`;
      }
      push({
        role: 'bot',
        text,
        object: res.object,
        records: res.records || [],
        intent: actionIntent,
      });
    } catch (err) {
      const msg =
        err.status === 403
          ? err.message
          : `Sorry, I ran into a problem: ${err.message}`;
      push({ role: 'bot', text: msg, ok: false });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onActivity(evt) {
    push({ role: 'bot', text: evt.text, ok: evt.ok });
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {empty ? (
          <div className="chat-welcome">
            <BotMark size={72} />
            <h1 className="hello">Hello, {username}</h1>
            <p className="hello-sub">How can I help you with Veeva Vault today?</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            {messages.map((m) => (
              <Message key={m.id} m={m} onActivity={onActivity} />
            ))}
            {busy && (
              <div className="msg bot">
                <div className="avatar">
                  <BotMark size={28} />
                </div>
                <div className="bubble typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Message VS Bot"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={busy}
          />
          <button
            type="button"
            className="send-btn"
            onClick={() => send()}
            disabled={busy || !input.trim()}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="currentColor" d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z" />
            </svg>
          </button>
        </div>
        <p className="composer-note">
          VS Bot validates permissions, lifecycle state, and justification before any change.
          Actions are audited.
        </p>
      </div>
    </div>
  );
}

function Message({ m, onActivity }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="msg bot">
      <div className="avatar">
        <BotMark size={28} />
      </div>
      <div className="bubble-group">
        <div className={`bubble ${m.ok === false ? 'bubble-error' : ''}`}>{m.text}</div>
        {m.records?.length > 0 && (
          <div className="rec-list">
            {m.records.map((r) => (
              <RecordCard
                key={r.id}
                object={m.object}
                record={r}
                intent={m.intent}
                onActivity={onActivity}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
