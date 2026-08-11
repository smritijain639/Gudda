// Natural-language -> Vault search spec, using the Galileo LLM.
//
// The LLM is asked to translate a plain-English question into a structured JSON
// spec (object + term/filters) rather than raw VQL. Producing a constrained
// spec — which we then feed through buildSmartSearchVql — keeps the query safe
// (no arbitrary VQL injection from the model) and lets us validate the object
// and field names against real Vault metadata before running anything.

import { galileoComplete } from './galileoClient.js';
import { buildSmartSearchVql } from './vaultClient.js';

const SYSTEM_PROMPT = `You translate a user's plain-English request into a JSON search specification for a Veeva Vault RIM query. 
Respond with ONLY a single JSON object, no prose, no code fences.

Schema:
{
  "object": "<object api name, e.g. submission__v>",
  "term": "<optional free-text to match>",
  "termFields": ["<field api names to match the term against>"],
  "filters": [
    { "field": "<field api name>", "operator": "<one of =,!=,CONTAINS,STARTSWITH,>,<,>=,<=>", "value": "<value>" }
  ],
  "limit": <optional integer, default 25>
}

Rules:
- Choose exactly ONE object that best fits the request, using an API name from the provided catalog.
- When several objects share a concept (e.g. registration), prefer the SHORTEST, most general name (e.g. "registration__rim" or "registration__v") over a longer composite (e.g. "medicinal_product_registration__v") unless the request clearly asks for the specific variant.
- For a simple "how many / list all X" request, return just the object with no term and no filters.
- If unsure of a field, use name__v for the term.
- Dates must be ISO format YYYY-MM-DD.
- Use filters for specific field conditions (status, dates, etc.). Use term for general name text.
- Omit keys you don't need. Never invent fields that aren't plausible.`;

// Build the user message including a compact catalog of objects (and, if known,
// the fields of a hinted object) so the model uses valid API names.
function buildUserPrompt({ question, objects, hintFields, hintObject }) {
  const objectList = (objects || [])
    .slice(0, 400)
    .map((o) => `${o.name} (${o.label})`)
    .join('\n');

  let fieldBlock = '';
  if (hintObject && hintFields && hintFields.length) {
    const fields = hintFields
      .slice(0, 120)
      .map((f) => `${f.name} (${f.label}${f.type ? ', ' + f.type : ''})`)
      .join('\n');
    fieldBlock = `\n\nFields for ${hintObject}:\n${fields}`;
  }

  return `User request: "${question}"

Available objects (api_name (label)):
${objectList}${fieldBlock}

Return the JSON spec now.`;
}

// Extract a JSON object from an LLM response that may include prose or code
// fences around it.
function extractJson(text) {
  if (!text) throw new Error('Empty response from the LLM.');
  let t = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // If there's still surrounding prose, grab the outermost { ... }.
  if (!t.startsWith('{')) {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      t = t.slice(first, last + 1);
    }
  }

  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`The LLM did not return valid JSON. Raw output: ${text.slice(0, 300)}`);
  }
}

// Validate/repair the spec against known object and field names.
// - Ensures the object exists (falls back to a case-insensitive match).
// - Drops filters/termFields referencing unknown fields when a field list is
//   available, so a bad guess doesn't make the whole query fail.
function validateSpec(spec, { objectNames, knownFields }) {
  if (!spec || typeof spec !== 'object') throw new Error('LLM spec was not an object.');
  if (!spec.object) throw new Error('LLM did not choose an object.');

  const warnings = [];

  if (objectNames && objectNames.length) {
    if (!objectNames.includes(spec.object)) {
      const ci = objectNames.find((n) => n.toLowerCase() === String(spec.object).toLowerCase());
      if (ci) {
        spec.object = ci;
      } else {
        throw new Error(
          `The LLM chose object "${spec.object}", which does not exist in this Vault.`
        );
      }
    }
  }

  const fieldSet = knownFields && knownFields.length ? new Set(knownFields) : null;
  // name__v/status__v/id are always valid selectable fields.
  if (fieldSet) {
    ['name__v', 'status__v', 'id'].forEach((f) => fieldSet.add(f));
  }

  if (fieldSet) {
    if (Array.isArray(spec.termFields)) {
      const kept = spec.termFields.filter((f) => fieldSet.has(f));
      if (kept.length !== spec.termFields.length) {
        warnings.push('Some suggested search fields were unknown and were dropped.');
      }
      spec.termFields = kept.length ? kept : ['name__v'];
    }
    if (Array.isArray(spec.filters)) {
      const kept = spec.filters.filter((f) => f && f.field && fieldSet.has(f.field));
      if (kept.length !== spec.filters.length) {
        warnings.push('Some suggested filters referenced unknown fields and were dropped.');
      }
      spec.filters = kept;
    }
  }

  return { spec, warnings };
}

// Full pipeline: question -> LLM -> spec -> validated spec -> VQL.
// objects: [{name,label}], getFields: async (object) => [{name,label,type}]
export async function nlToVql({ question, objects, getFields }) {
  if (!question || !question.trim()) throw new Error('question is required.');

  const objectNames = (objects || []).map((o) => o.name);

  // First pass: let the model pick the object (no field hint yet).
  const firstOutput = await galileoComplete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ question, objects }),
  });
  let spec = extractJson(firstOutput);

  // If we can load fields for the chosen object, validate against them.
  let knownFields = null;
  if (spec.object && typeof getFields === 'function') {
    try {
      const fields = await getFields(spec.object);
      knownFields = fields.map((f) => f.name);
    } catch {
      // Non-fatal: proceed without field validation.
    }
  }

  const { spec: validSpec, warnings } = validateSpec(spec, { objectNames, knownFields });

  const vql = buildSmartSearchVql({
    object: validSpec.object,
    term: validSpec.term || '',
    termFields: validSpec.termFields && validSpec.termFields.length ? validSpec.termFields : ['name__v'],
    filters: validSpec.filters || [],
    select: ['id', 'name__v', 'status__v'],
    limit: validSpec.limit || 25,
  });

  return { spec: validSpec, vql, warnings };
}

// Derive the main keyword(s) from a spec's object name, used to find sibling
// objects representing the same concept. e.g. "medicinal_product_registration__v"
// -> ["medicinal","product","registration"] with "registration" as the head.
function objectKeywords(objectName) {
  return String(objectName || '')
    .replace(/__[a-z0-9]+$/i, '') // drop the __v/__rim/__c suffix
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// Rank candidate objects by how well their name matches the target concept.
// Prefers objects whose name contains the "head" keyword (the last, most
// specific word, e.g. "registration"), then by shared-keyword count.
function rankSiblings(targetObject, allObjects) {
  const kws = objectKeywords(targetObject);
  if (kws.length === 0) return [];
  const head = kws[kws.length - 1];

  return allObjects
    .filter((o) => o.name !== targetObject)
    .map((o) => {
      const okws = objectKeywords(o.name);
      const shared = okws.filter((w) => kws.includes(w)).length;
      const hasHead = okws.includes(head);
      return { object: o, score: (hasHead ? 10 : 0) + shared, hasHead };
    })
    .filter((c) => c.hasHead || c.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.object.name);
}

// Try sibling objects (same concept) and return the first that has records.
// Runs a bare "SELECT id, name__v, status__v FROM <obj> MAXROWS n" so it works
// even when the term/filters don't apply to the sibling's schema.
export async function findPopulatedSibling(vault, allObjects, spec, question) {
  const candidates = rankSiblings(spec.object, allObjects).slice(0, 8);

  for (const object of candidates) {
    try {
      // First try with the original term (if any) for relevance; if that is
      // empty, fall back to an unfiltered listing so the user at least sees
      // the records that exist.
      const term = spec.term || '';
      const attempts = [];
      if (term) {
        attempts.push(
          buildSmartSearchVql({
            object,
            term,
            termFields: ['name__v'],
            select: ['id', 'name__v', 'status__v'],
            limit: 25,
          })
        );
      }
      attempts.push(
        buildSmartSearchVql({
          object,
          select: ['id', 'name__v', 'status__v'],
          limit: 25,
        })
      );

      for (const vql of attempts) {
        const { data, responseDetails } = await vault.query(vql);
        if (data.length > 0) {
          return { object, data, responseDetails, vql };
        }
      }
    } catch {
      // Object may lack name__v/status__v or not be queryable; skip it.
    }
  }
  return null;
}

export {
  extractJson,
  validateSpec,
  buildUserPrompt,
  SYSTEM_PROMPT,
  objectKeywords,
  rankSiblings,
};
