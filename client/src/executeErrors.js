// Helpers for turning a failed lifecycle-change execution (Agent 3) into a
// clear, user-facing explanation.
//
// When Veeva Vault blocks a state change because entry criteria aren't met, it
// returns responseStatus FAILURE with errors[] of shape { type, message }. It
// does NOT expose a structured field name — the field is referenced inside the
// free-text message, typically in [brackets] (e.g. "Required field
// [approval_date__c] is missing"). These helpers mine both the structured
// errors[] and the message text so the UI can name the exact missing fields
// instead of showing a generic "unexpected problem".

const REQUIRED_HINT =
  /(required|mandatory|missing|cannot be (?:blank|omitted|empty)|must be (?:set|provided))/i;

// True when an execution failure is a normal, explainable transition problem we
// can guide the user through (rather than an unexpected system error).
export function isExplainableExecuteFailure(message) {
  if (!message) return false;
  return /No lifecycle action|No target state|ambiguous|Available transitions/i.test(message);
}

// Extract the names of mandatory fields Vault reported as missing/blank.
// Returns a de-duplicated list of human-readable field labels (may be empty).
export function missingRequiredFields(execute) {
  const errors = (execute && execute.errors) || [];
  const texts = [
    ...errors.map((e) => (e && (e.message || '')) || ''),
    (execute && execute.message) || '',
  ];
  const names = new Set();
  for (const t of texts) {
    if (!t || !REQUIRED_HINT.test(t)) continue;
    const matches = t.match(/\[([^\]]+)\]/g) || [];
    for (const raw of matches) {
      const token = raw.slice(1, -1).trim();
      // Bracketed tokens are sometimes value lists (e.g. "[501,502]"); keep only
      // things that look like field API names.
      if (/^[a-z][a-z0-9_]*(__[a-z]{1,3})?$/i.test(token)) {
        names.add(prettyFieldName(token));
      }
    }
  }
  return [...names];
}

// Turn a Vault field API name ("approval_date__c") into a readable label
// ("Approval Date"). Best-effort; leaves already-friendly labels intact.
export function prettyFieldName(name) {
  return String(name)
    .replace(/__[a-z]{1,3}$/i, '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Trim internal prefixes/noise from a raw execute message so it reads cleanly
// when shown directly to the user.
export function cleanExecuteMessage(message) {
  const m = String(message || '').trim();
  if (!m) return '';
  return m.replace(/^Execution error:\s*/i, '').trim();
}
