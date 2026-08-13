import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import BotMark from './BotMark.jsx';
import RecordCard from './RecordCard.jsx';
import {
  detectSmallTalk,
  detectActionIntent,
  actionPromptFor,
  detectTargetState,
  matchTargetState,
} from '../intent.js';
import {
  isExplainableExecuteFailure,
  missingRequiredFields,
  cleanExecuteMessage,
} from '../executeErrors.js';

let idSeq = 0;
const nextId = () => `m${Date.now()}_${idSeq++}`;

// Where users can raise a support ticket when the assistant can't complete a
// request (e.g. an unexpected error or a Vault-side block it can't resolve).
const SUPPORT_URL = 'https://roche.service-now.com/now/nav/ui/home';

const SUGGESTIONS = [
  'Show submissions in draft state',
  'Find registrations for my product',
  'List records ready for review',
];

export default function Chat({ username, messages = [], onMessagesChange }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  // Keep a live ref to the current messages so async handlers append to the
  // latest list even after awaits, without stale closures.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  function push(msg) {
    const next = [...messagesRef.current, { id: nextId(), ...msg }];
    messagesRef.current = next;
    onMessagesChange?.(next);
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
    // Did they name a target state to move to?
    const targetState = actionIntent === 'lifecycle' ? detectTargetState(q) : null;

    // Submission state changes go exclusively through the 4-agent compliance
    // pipeline. Route any lifecycle request that mentions a submission there.
    if (actionIntent === 'lifecycle' && /\bsubmission\b/i.test(q)) {
      setBusy(true);
      try {
        const result = await api.changeSubmissionState(q);
        renderPipelineResult(result);
      } catch (err) {
        push({
          role: 'bot',
          text:
            `Sorry — I couldn't process that request right now. Please try again in a moment.`,
        });
        push({ role: 'bot', kind: 'support' });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
      return;
    }

    setBusy(true);
    try {
      const res = await api.nlSearch(q);
      const count = res.records?.length || 0;
      const notes = (res.warnings || []).join(' ');

      // Direct execution: user named a target state and exactly one record
      // matched. Apply the transition without asking them to pick from a list.
      if (targetState && count === 1) {
        const applied = await applyStateDirect(res.object, res.records[0], targetState);
        if (applied) {
          setBusy(false);
          inputRef.current?.focus();
          return;
        }
        // If direct apply couldn't proceed it falls through to showing the
        // record card so the user can choose manually.
      }

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

  // Attempt to move a record straight to the named state. Returns true when it
  // handled the request (success OR a clear, actionable message) and false when
  // the caller should fall back to showing the record card.
  async function applyStateDirect(object, record, targetState) {
    const label = record.name__v || record.id;

    // Submissions must go through the compliance pipeline — never apply directly.
    if (object === 'submission__v') {
      const result = await api.changeSubmissionState(
        `Change lifecycle state of submission ${label} to ${targetState}`
      );
      renderPipelineResult(result);
      return true;
    }
    let overview;
    try {
      overview = await api.getLifecycle(object, record.id);
    } catch {
      return false; // couldn't load lifecycle — fall back to the card
    }

    const target = matchTargetState(overview.states, targetState);

    // The named state isn't part of this object's lifecycle at all.
    if (!target) {
      push({
        role: 'bot',
        object,
        records: [record],
        intent: 'lifecycle',
        text: `“${targetState}” isn’t a lifecycle state for ${object}. Open the record to see the available states.`,
      });
      return true;
    }

    // Already there.
    if (target.current) {
      push({ role: 'bot', text: `${label} is already in “${target.label}”.` });
      return true;
    }

    // The state exists but Vault doesn't offer a transition to it from the
    // record's current state. Show the card so the user can see what's possible.
    if (!target.action) {
      push({
        role: 'bot',
        object,
        records: [record],
        intent: 'lifecycle',
        text:
          `I can’t move ${label} to “${target.label}” — Vault doesn’t allow that ` +
          `transition from its current state (${overview.currentStateLabel}). ` +
          `Open the record to see which states are available.`,
      });
      return true;
    }

    // Apply it directly.
    try {
      await api.executeAction(object, record.id, target.action);
      push({
        role: 'bot',
        ok: true,
        text: `Moved ${label} to “${target.label}”.`,
      });
    } catch (err) {
      push({
        role: 'bot',
        ok: false,
        text: `Couldn’t move ${label} to “${target.label}”: ${err.message}`,
      });
    }
    return true;
  }

  // Render the outcome of the 4-agent compliance pipeline as chat messages:
  // the decision line plus the GxP audit narrative.
  function renderPipelineResult(result) {
    const { status, agent1, verify, execute } = result || {};

    const submission = verify?.document?.submission_id || agent1?.document_id || 'that submission';

    if (status === 'out_of_scope') {
      // The assistant can only change submission lifecycle states. Anything
      // else is outside what it can do — point the user to support rather than
      // guessing at a rephrase.
      push({
        role: 'bot',
        text:
          `That's outside what I can help with here — I can only change a submission's ` +
          `lifecycle state. For anything else, our support team can assist.`,
      });
      push({ role: 'bot', kind: 'support' });
      return;
    }

    if (status === 'already_in_state') {
      const stateLabel = agent1?.target_state || prettyState(execute?.confirmed_status);
      push({
        role: 'bot',
        text: `${submission} is already in “${stateLabel}”, so there's nothing to change.`,
      });
      push({ role: 'bot', kind: 'trace', trace: result });
      return;
    }

    if (status === 'denied') {
      // A denial is a normal, expected outcome — keep it conversational, not an error.
      push({
        role: 'bot',
        text:
          `I'm not able to make that change. ${humanizeReason(verify?.reason) || ''}`.trim(),
      });
      // If it's a permission issue the user can request access via a support
      // ticket (with the justification already explained above).
      if (isPermissionDenial(verify?.reason)) {
        push({ role: 'bot', kind: 'support', supportLabel: 'Request access via support ticket ↗' });
      }
    } else if (status === 'executed') {
      // Prefer the human-friendly state the user asked for; fall back to a
      // prettified version of the confirmed technical state name.
      const stateLabel = agent1?.target_state || prettyState(execute?.confirmed_status);
      push({
        role: 'bot',
        ok: true,
        text: `✅ Approved successfully — ${submission} is now in “${stateLabel || 'the requested state'}”.`,
      });
    } else {
      // Execution didn't complete. Prefer showing the user the real reason:
      //  1. Missing mandatory fields — list the exact field names Vault named.
      //  2. A known/explainable transition problem (invalid transition, etc.).
      //  3. Otherwise, an unexpected error — point them to support.
      const missing = missingRequiredFields(execute);
      const known = isExplainableExecuteFailure(execute?.message);
      if (missing.length) {
        push({
          role: 'bot',
          text:
            `I couldn't change ${submission} because some mandatory ` +
            `${missing.length === 1 ? 'field is' : 'fields are'} missing: ` +
            `${missing.join(', ')}. Please fill ${missing.length === 1 ? 'it' : 'them'} in ` +
            `on the submission and try again.`,
        });
      } else if (known) {
        push({
          role: 'bot',
          text: humanizeExecuteMessage(execute?.message, submission),
        });
      } else {
        // No structured field info, but still show the exact reason Vault gave
        // rather than a vague "unexpected problem" message.
        const detail = cleanExecuteMessage(execute?.message);
        push({
          role: 'bot',
          text: detail
            ? `I couldn't change ${submission}: ${detail}`
            : `I ran into an unexpected problem while updating ${submission}, so the ` +
              `change didn't go through. Please try again in a moment.`,
        });
        push({ role: 'bot', kind: 'support' });
      }
    }

    // Note: the GxP audit narrative is shown inside the "Agent details & logs"
    // trace (Agent 4), so we don't push a separate audit bubble here.

    // Expandable per-agent trace: what each of the 4 agents decided and did.
    push({ role: 'bot', kind: 'trace', trace: result });
  }

  function onActivity(evt) {
    // A record card can hand back a full compliance-pipeline result to render.
    if (evt?.pipeline) {
      renderPipelineResult(evt.pipeline);
      return;
    }
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
        {m.kind === 'trace' ? (
          <AgentTrace result={m.trace} />
        ) : m.kind === 'support' ? (
          <div className="bubble support-bubble">
            <span>{m.supportText || 'Our support team can help with this.'}</span>
            <a
              className="support-link"
              href={SUPPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {m.supportLabel || 'Raise a support ticket ↗'}
            </a>
          </div>
        ) : (
          <div
            className={`bubble ${m.ok === false ? 'bubble-error' : ''} ${
              m.kind === 'audit' ? 'bubble-audit' : ''
            }`}
          >
            {m.kind === 'audit' && <span className="audit-tag">Compliance audit</span>}
            {m.text}
          </div>
        )}
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

// Icon + status pill for an agent step.
function agentStep(name, subtitle, state, body) {
  return { name, subtitle, state, body };
}

// Expandable trace of the 4-agent compliance pipeline. Shows each agent's
// decision/output so users can see the reasoning behind an execution.
function AgentTrace({ result }) {
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const { status, agent1, verify, execute, audit } = result;

  // Build a step list reflecting how far the pipeline got.
  const steps = [];

  // Agent 1 — Interpret
  steps.push(
    agentStep(
      'Agent 1 · Interpret',
      'Neural Processing (LLM)',
      agent1?.intent === 'change_submission_state' ? 'ok' : 'stop',
      [
        ['Intent', agent1?.intent],
        ['Submission', agent1?.document_id || '—'],
        ['Target state', agent1?.target_state || '—'],
        ['Confidence', agent1?.confidence != null ? `${Math.round(agent1.confidence * 100)}%` : '—'],
        ['Reasoning', agent1?.reasoning || '—'],
      ]
    )
  );

  // Agent 2 — Verify
  if (verify) {
    const c = verify.checks || {};
    steps.push(
      agentStep(
        'Agent 2 · Verify',
        'Compliance (GxP guardrails)',
        verify.execution_approved ? 'ok' : 'deny',
        [
          ['Intent permitted', bool(c.intent_permitted)],
          ['Submission exists', bool(c.submission_exists)],
          ['Affiliate Manager', bool(c.is_affiliate_manager)],
          ['Requesting user', verify.requesting_user?.federated_id || '—'],
          ['Vault user id', verify.requesting_user?.resolved_vault_user_id || '—'],
          ['Current state', prettyState(verify.document?.current_state) || '—'],
          ['Decision', verify.reason || '—'],
        ]
      )
    );
  } else if (status === 'out_of_scope') {
    steps.push(agentStep('Agent 2 · Verify', 'Compliance', 'skip', [['Skipped', 'Intent out of scope']]));
  }

  // Agent 3 — Execute
  if (execute) {
    steps.push(
      agentStep(
        'Agent 3 · Execute',
        'Lifecycle action',
        execute.execution_status === 'SUCCESS' ? 'ok' : 'deny',
        [
          ['Status', execute.execution_status],
          ['Action invoked', execute.action_invoked || '—'],
          ['Confirmed state', prettyState(execute.confirmed_status) || '—'],
          ['Message', execute.message || '—'],
        ]
      )
    );
  } else {
    steps.push(
      agentStep('Agent 3 · Execute', 'Lifecycle action', 'skip', [
        ['Skipped', status === 'denied' ? 'Not approved by compliance' : 'Not reached'],
      ])
    );
  }

  // Agent 4 — Audit
  steps.push(
    agentStep('Agent 4 · Audit', 'GxP narrative', audit ? 'ok' : 'skip', [
      ['Narrative', audit || '—'],
    ])
  );

  return (
    <div className="trace">
      <button type="button" className="trace-toggle" onClick={() => setOpen((o) => !o)}>
        <span className={`trace-caret ${open ? 'open' : ''}`}>▸</span>
        Agent details &amp; logs
        <span className="trace-count">{steps.length} agents</span>
      </button>
      {open && (
        <div className="trace-body">
          {steps.map((s) => (
            <div key={s.name} className={`trace-step ${s.state}`}>
              <div className="trace-head">
                <span className={`trace-dot ${s.state}`} />
                <span className="trace-name">{s.name}</span>
                <span className="trace-sub">{s.subtitle}</span>
                <span className={`trace-badge ${s.state}`}>{stateLabel(s.state)}</span>
              </div>
              <dl className="trace-kv">
                {s.body.map(([k, v]) => (
                  <div className="trace-row" key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v == null ? '—' : v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function bool(v) {
  return v ? 'Pass' : 'Fail';
}

// True when a denial is specifically about the user lacking the required role.
function isPermissionDenial(reason) {
  return /affiliate_manager__c|affiliate manager|does not hold/i.test(reason || '');
}

// A denial reason from Agent 2 can mention a missing role. Soften the phrasing
// for the end user without changing the underlying meaning.
function humanizeReason(reason) {
  if (!reason) return '';
  if (/affiliate_manager__c|affiliate manager/i.test(reason)) {
    return `You don't have the Affiliate Manager permission on this submission, which is required to change its state. If you believe you should, please contact your Vault administrator.`;
  }
  if (/not found/i.test(reason)) {
    return `I couldn't find that submission — please double-check the name or ID.`;
  }
  if (/could not resolve/i.test(reason)) {
    return `I couldn't confirm your Vault account for this request. Please try signing out and back in.`;
  }
  return reason;
}



// Rephrase a known execution message conversationally, listing the states the
// user can actually move to.
function humanizeExecuteMessage(message, submission) {
  const m = String(message || '');
  const match = m.match(/Available transitions:\s*([^.]+)\.?/i);
  const options = match
    ? match[1]
        .split(',')
        .map((s) => s.replace(/^\s*change state to\s*/i, '').trim())
        .filter(Boolean)
    : [];
  const base = `That state change isn't available for ${submission} from its current state.`;
  if (options.length) {
    return `${base} Right now you can move it to: ${options.join(', ')}.`;
  }
  return `${base} There are no state changes available right now.`;
}

// Turn a Vault state name (e.g. "in_progress_state__c") into a readable label
// ("In Progress"). Best-effort fallback when a friendly label isn't available.
function prettyState(name) {
  if (!name) return '';
  return String(name)
    .replace(/_state__[cv]$/i, '')
    .replace(/__[cv]$/i, '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function stateLabel(state) {
  return (
    { ok: 'Pass', deny: 'Blocked', stop: 'Stopped', skip: 'Skipped' }[state] || state
  );
}
