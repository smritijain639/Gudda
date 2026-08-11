// Lightweight client-side intent detection so conversational messages
// (greetings, thanks, help, etc.) get a conversational reply instead of being
// treated as a Vault search. Anything not recognised as small-talk falls
// through to the NL search pipeline.

const GREETINGS = [
  'hi',
  'hii',
  'hiii',
  'hey',
  'heya',
  'hello',
  'helo',
  'hello there',
  'hey there',
  'yo',
  'hola',
  'howdy',
  'good morning',
  'good afternoon',
  'good evening',
  'gm',
  'ge',
];

const THANKS = ['thanks', 'thank you', 'thankyou', 'thx', 'ty', 'cheers', 'appreciate it'];

const HOW_ARE_YOU = [
  'how are you',
  'how are you doing',
  'how r u',
  'hru',
  'whats up',
  "what's up",
  'sup',
  'how is it going',
  "how's it going",
];

const HELP = [
  'help',
  'what can you do',
  'what can i do',
  'what can you help with',
  'how do you work',
  'how does this work',
  'what do you do',
  'who are you',
  'what are you',
];

const BYE = ['bye', 'goodbye', 'see you', 'see ya', 'cya'];

// Normalize: lowercase, strip surrounding punctuation/whitespace.
function norm(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/^[!.,?\s]+|[!.,?\s]+$/g, '');
}

function matches(text, phrases) {
  return phrases.includes(text);
}

// Returns { type, reply } for small-talk, or null to fall through to search.
export function detectSmallTalk(rawText, { username } = {}) {
  const text = norm(rawText);
  if (!text) return null;

  // Very short messages only, so we don't swallow real queries that happen to
  // contain a greeting word (e.g. "hi, show me submissions").
  const wordCount = text.split(/\s+/).length;

  if (wordCount <= 4 && matches(text, HELP)) {
    return {
      type: 'help',
      reply:
        `I'm VS Bot — I help you work with Veeva Vault RIM records. ` +
        `Ask me in plain English to find records and I'll list them with their ` +
        `available lifecycle actions. For example:\n\n` +
        `• “Show submissions in draft state”\n` +
        `• “Find registrations for my product”\n` +
        `• “List records ready for review”`,
    };
  }

  if (wordCount <= 3 && matches(text, HOW_ARE_YOU)) {
    return {
      type: 'howareyou',
      reply: `I'm doing well, thanks! Ready to help you with Veeva Vault. What would you like to look up?`,
    };
  }

  if (wordCount <= 3 && matches(text, GREETINGS)) {
    const who = username ? ` ${username}` : '';
    return {
      type: 'greeting',
      reply: `Hi${who}! 👋 How can I help you with Veeva Vault today? You can ask me to find records — for example, “Show submissions in draft state”.`,
    };
  }

  if (wordCount <= 3 && matches(text, THANKS)) {
    return {
      type: 'thanks',
      reply: `You're welcome! Anything else you'd like to look up?`,
    };
  }

  if (wordCount <= 3 && matches(text, BYE)) {
    return { type: 'bye', reply: `Goodbye! You can sign out from the sidebar when you're done.` };
  }

  return null;
}

// Detect what the user wants to DO with records, so the search results can be
// framed as a pick-list and the right action is surfaced on each record.
// Returns 'delete' | 'obsolete' | 'edit' | 'lifecycle' | null.
export function detectActionIntent(rawText) {
  const text = norm(rawText);
  if (!text) return null;
  if (/\b(delete|remove|erase|purge|get rid of)\b/.test(text)) return 'delete';
  if (/\b(obsolete|obsoletion|make obsolete|retire|withdraw)\b/.test(text)) return 'obsolete';
  // Lifecycle before edit so "change the status" resolves to lifecycle, not edit.
  if (/\b(lifecycle|state|status|transition|move to|promote|approve)\b/.test(text))
    return 'lifecycle';
  if (/\b(edit|update|change|modify|correct|rename|set)\b/.test(text)) return 'edit';
  return null;
}

// Framing text shown above the record pick-list for a given action intent.
export function actionPromptFor(intent, object, count) {
  const noun = count === 1 ? 'record' : 'records';
  switch (intent) {
    case 'delete':
      return `Which one would you like to delete? Here ${count === 1 ? 'is' : 'are'} ${count} ${object} ${noun} — open a record and choose **Delete**. Deletions are permanent and cascade to child records.`;
    case 'obsolete':
      return `Which one would you like to make obsolete? Here ${count === 1 ? 'is' : 'are'} ${count} ${object} ${noun} — open a record and pick the obsolete action.`;
    case 'edit':
      return `Which ${object} record would you like to edit? Here ${count === 1 ? 'is' : 'are'} ${count} ${noun}. (Editing from chat is coming soon — for now you can apply lifecycle actions.)`;
    case 'lifecycle':
      return `Here ${count === 1 ? 'is' : 'are'} ${count} ${object} ${noun}. Open a record to see and apply its lifecycle actions.`;
    default:
      return null;
  }
}
