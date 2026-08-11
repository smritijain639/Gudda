// Configurable client for the Roche Galileo LLM.
//
// Because Galileo is a custom Roche endpoint, everything about the wire format
// is driven by environment variables so it can be adapted without code changes:
//
//   GALILEO_API_KEY        (required) the API key
//   GALILEO_URL            (required) full endpoint URL, e.g.
//                          https://galileo.roche.com/api/v1/chat/completions
//   GALILEO_AUTH_HEADER    header name for the key. Default: "Authorization"
//   GALILEO_AUTH_PREFIX    value prefix. Default: "Bearer " (note trailing space)
//                          For an api-key style header set AUTH_HEADER=api-key
//                          and AUTH_PREFIX="" (empty).
//   GALILEO_MODEL          model / deployment name, if the endpoint needs one
//   GALILEO_BODY_STYLE     "chat" (default) -> { model, messages:[...] }
//                          "prompt"          -> { model, prompt: "..." }
//   GALILEO_RESPONSE_PATH  dot-path to the generated text in the JSON response.
//                          Default: "choices.0.message.content"
//                          (OpenAI chat). For a prompt-style API you might use
//                          "choices.0.text" or a custom path like "result.output".
//   GALILEO_EXTRA_HEADERS  optional JSON object of extra headers, e.g.
//                          {"api-version":"2024-02-01"}

function getConfig() {
  return {
    apiKey: process.env.GALILEO_API_KEY || '',
    url: process.env.GALILEO_URL || '',
    authHeader: process.env.GALILEO_AUTH_HEADER || 'Authorization',
    authPrefix:
      process.env.GALILEO_AUTH_PREFIX != null ? process.env.GALILEO_AUTH_PREFIX : 'Bearer ',
    model: process.env.GALILEO_MODEL || '',
    bodyStyle: process.env.GALILEO_BODY_STYLE || 'chat',
    responsePath: process.env.GALILEO_RESPONSE_PATH || 'choices.0.message.content',
    extraHeaders: safeJson(process.env.GALILEO_EXTRA_HEADERS) || {},
  };
}

function safeJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Read a value from an object by a dot-path like "choices.0.message.content".
function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

export function isGalileoConfigured() {
  const { apiKey, url } = getConfig();
  return Boolean(apiKey && url);
}

// Build the request body for the configured style.
function buildBody({ system, user }, cfg) {
  if (cfg.bodyStyle === 'prompt') {
    const prompt = [system, user].filter(Boolean).join('\n\n');
    return { ...(cfg.model ? { model: cfg.model } : {}), prompt, temperature: 0 };
  }
  // chat (default)
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return { ...(cfg.model ? { model: cfg.model } : {}), messages, temperature: 0 };
}

// Send a completion request and return the raw text output.
export async function galileoComplete({ system, user }) {
  const cfg = getConfig();
  if (!cfg.apiKey || !cfg.url) {
    const err = new Error(
      'Galileo is not configured. Set GALILEO_URL and GALILEO_API_KEY on the server.'
    );
    err.status = 503;
    throw err;
  }

  // Some .env loaders trim a trailing space from the prefix (e.g. "Bearer "),
  // which would produce an invalid "Bearer<key>" header. Ensure a separating
  // space when the prefix is a bare word without its own trailing whitespace.
  let prefix = cfg.authPrefix;
  if (prefix && !/\s$/.test(prefix)) prefix = `${prefix} `;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    [cfg.authHeader]: `${prefix}${cfg.apiKey}`,
    ...cfg.extraHeaders,
  };

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody({ system, user }, cfg)),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Some endpoints may return plain text.
    if (!res.ok) {
      throw new Error(`Galileo error (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    return text;
  }

  if (!res.ok) {
    const message =
      getByPath(json, 'error.message') || json.message || `Galileo error (HTTP ${res.status})`;
    throw new Error(message);
  }

  const output = getByPath(json, cfg.responsePath);
  if (output == null) {
    throw new Error(
      `Could not find the LLM output at path "${cfg.responsePath}". ` +
        `Adjust GALILEO_RESPONSE_PATH. Response keys: ${Object.keys(json).join(', ')}`
    );
  }
  return String(output);
}

export { getByPath };
