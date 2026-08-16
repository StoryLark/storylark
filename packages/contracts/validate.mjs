// StoryLark contract validation — brand.json, presentation.json, deployment.json.
//
// ── Why this lives in its own package ───────────────────────────────────────
// It started in `storylark-core/schemas` with one consumer, the Vite preset.
// Phase 4 (plan §0c/§0d — brand & presentation packages) gave it three, and the
// third one changed where it can live: the packaging CLI validates a package
// before emitting it, the **deployment's import endpoint** validates one before
// accepting it, and the build validates what it loads. The import endpoint runs
// inside the Worker, so this code has to be bundleable by wrangler and runnable
// by tsx on the Node platform entry — which rules out a home inside
// `storylark-core` (a frontend package: preact, six font packages, two Vite
// plugins) and equally rules out a copy in `storylark-worker`, because a second
// copy is a second answer to "is this file valid" and the day they disagreed,
// the packager would emit packages the deployment rejects.
//
// So: one zero-dependency package, three consumers, one answer. `storylark-core`
// and `storylark-worker` both depend on it; `storylark-core/schemas` re-exports
// everything here so existing imports keep working unchanged.
//
// ── Why a hand-rolled validator instead of ajv/zod ──────────────────────────
// This repo has no validation library anywhere, and one of the consumers is the
// Vite preset (storylark-core/vite/index.mjs), which Node loads at config time
// with no TS compile and no bundling. Pulling a validator in would put a
// dependency on every downstream site's build for ~200 lines of work — and now
// also on every Worker bundle. The schema FILES are real JSON Schema (draft
// 2020-12), so anything later can feed them straight to ajv without rewriting
// them. This module implements the subset those schemas actually use: type
// (incl. unions), enum, const, required, properties, additionalProperties
// (false or a sub-schema), items, pattern, minimum, maximum.
//
// ── The two compatibility rules (plan §0b) ──────────────────────────────────
//  1. A missing key takes the core default, permanently. So almost nothing is
//     `required`, and a missing optional key is never even a warning.
//  2. An unknown key is ignored with a warning. A file written for a NEWER
//     engine loads on an older one without exploding.
//
// ── What "wrong contractVersion major" means here ───────────────────────────
// `contractVersion` is a bare integer — there is no dotted minor — so THE
// INTEGER IS THE MAJOR. A file is compatible iff its contractVersion is within
// [MIN_SUPPORTED_CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSION]; today both are
// 1, so anything other than 1 is a hard failure. When the contract gains a
// backwards-compatible key, the version does NOT move (rules 1 and 2 already
// cover that case); it moves only on a genuinely breaking reshape, and then
// MIN_SUPPORTED tells you how many old majors the engine still reads.
//
// ── Severity ────────────────────────────────────────────────────────────────
// Non-strict (the build): only a contractVersion mismatch is an error. Unknown
// keys warn; a known key with a bad type/enum value warns too, so a build never
// dies over a field it can ignore. Strict (tooling that PRODUCES or ACCEPTS a
// file — the migration script, the packaging CLI, the import endpoint): every
// finding is an error, because a bad file should be caught by whatever emits it
// rather than by the customer's build.

import BRAND from './schemas/brand.schema.json' with { type: 'json' };
import PRESENTATION from './schemas/presentation.schema.json' with { type: 'json' };
import DEPLOYMENT from './schemas/deployment.schema.json' with { type: 'json' };

export const BRAND_SCHEMA = BRAND;
export const PRESENTATION_SCHEMA = PRESENTATION;
export const DEPLOYMENT_SCHEMA = DEPLOYMENT;

/** Highest contract major this engine understands. */
export const SUPPORTED_CONTRACT_VERSION = 1;
/** Lowest contract major this engine still reads. */
export const MIN_SUPPORTED_CONTRACT_VERSION = 1;

/**
 * Keys that used to live in brand.json and moved elsewhere in the Phase 0
 * split. Finding one is technically just an unknown key, but a generic
 * "unknown key" warning would be useless here — the operator wants to be told
 * where it went, and that the value is being ignored.
 */
export const RELOCATED_BRAND_KEYS = {
  appOrigin: 'deployment config (deployment/<id>/deployment.json or STORYLARK_APP_ORIGIN)',
  contentOrigin: 'deployment config (deployment/<id>/deployment.json or STORYLARK_CONTENT_ORIGIN)',
  vapidPublicKey: 'deployment config (deployment/<id>/deployment.json or STORYLARK_VAPID_PUBLIC_KEY)',
  tts: 'deployment config (deployment/<id>/deployment.json or STORYLARK_TTS_*)',
  layout: 'presentation (presentation/<id>/presentation.json)',
  nouns: 'presentation (presentation/<id>/presentation.json)',
};

// Presentation defaults deliberately do NOT live here (AB#7416 — plan §0d
// Phase 3). They are DEFAULT_PRESENTATION in storylark-core/src/presentation.ts,
// because presentation is resolved in the FRONTEND now: the build ships the
// file as the operator stated it (dist/presentation.json) and the browser fills
// in everything absent. Keeping a second copy of the defaults here would mean
// two answers to "what does an absent key mean", and the day they disagreed,
// rule 1 above would quietly stop being true. Nothing in the Node build needs
// them any more, so nothing keeps them.

/** Core defaults for deployment config — an unconfigured deployment, not a broken one. */
export const DEPLOYMENT_DEFAULTS = Object.freeze({
  appOrigin: '',
  contentOrigin: '',
  vapidPublicKey: '',
});

// ── validation ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ errors: string[], warnings: string[] }} ValidationResult
 */

/**
 * Validate a parsed contract document against one of the schemas above.
 *
 * @param {unknown} doc     Parsed JSON.
 * @param {object}  schema  One of BRAND_SCHEMA / PRESENTATION_SCHEMA / DEPLOYMENT_SCHEMA.
 * @param {object}  [opts]
 * @param {boolean} [opts.strict]  Promote every warning to an error (for tooling that emits or accepts files).
 * @param {string}  [opts.label]   Human name for messages, e.g. 'brands/storylark/brand.json'.
 * @returns {ValidationResult}
 */
export function validate(doc, schema, opts = {}) {
  const { strict = false, label = schema.title ?? 'document' } = opts;
  /** @type {ValidationResult} */
  const result = { errors: [], warnings: [] };
  const warn = (msg) => (strict ? result.errors : result.warnings).push(`${label}: ${msg}`);
  const fail = (msg) => result.errors.push(`${label}: ${msg}`);

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('not a JSON object.');
    return result;
  }

  // The one hard gate, in both modes.
  const version = /** @type {any} */ (doc).contractVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    fail(
      'no integer `contractVersion`. This looks like a pre-split file from before the brand/presentation/deployment split — run `npm run migrate-brand` to convert it.'
    );
  } else if (version > SUPPORTED_CONTRACT_VERSION) {
    fail(
      `contractVersion ${version} was written for a newer StoryLark engine (this one reads up to ${SUPPORTED_CONTRACT_VERSION}). Update storylark-core.`
    );
  } else if (version < MIN_SUPPORTED_CONTRACT_VERSION) {
    fail(
      `contractVersion ${version} is no longer supported (this engine reads ${MIN_SUPPORTED_CONTRACT_VERSION} and up). Run \`npm run migrate-brand\`.`
    );
  }

  walk(doc, schema, '', { warn, fail, relocated: schema === BRAND_SCHEMA ? RELOCATED_BRAND_KEYS : null });
  return result;
}

/** Recursive schema walk. Everything it reports is advisory except via `fail`. */
function walk(value, schema, path, ctx) {
  const at = path || '(root)';

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    ctx.warn(`\`${at}\` should be ${[].concat(schema.type).join(' or ')}, got ${describe(value)}.`);
    return; // further checks would only echo the same problem
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    ctx.warn(`\`${at}\` should be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}, got ${describe(value)}.`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    ctx.warn(`\`${at}\` should be ${JSON.stringify(schema.const)}, got ${describe(value)}.`);
    return;
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    ctx.warn(`\`${at}\` ${JSON.stringify(value)} does not match ${schema.pattern}.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) ctx.warn(`\`${at}\` must be >= ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) ctx.warn(`\`${at}\` must be <= ${schema.maximum}.`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, ctx));
    return;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      // contractVersion has its own hard check in validate() — don't say it twice.
      if (path === '' && key === 'contractVersion') continue;
      if (!(key in value)) ctx.warn(`missing required key \`${join(path, key)}\`.`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) {
        walk(child, props[key], join(path, key), ctx);
      } else if (schema.additionalProperties === false) {
        // Rule 2: unknown keys are ignored with a warning, never fatal.
        const moved = path === '' ? ctx.relocated?.[key] : null;
        ctx.warn(
          moved
            ? `\`${key}\` no longer belongs here — it moved to ${moved}. The value in this file is ignored.`
            : `unknown key \`${join(path, key)}\` — ignored. (Written for a newer engine, or a typo.)`
        );
      } else if (typeof schema.additionalProperties === 'object') {
        walk(child, schema.additionalProperties, join(path, key), ctx);
      }
    }
  }
}

const join = (path, key) => (path ? `${path}.${key}` : key);

function matchesType(value, type) {
  const types = [].concat(type);
  return types.some((t) => {
    switch (t) {
      case 'object':
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      case 'null':
        return value === null;
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'string':
      case 'boolean':
        return typeof value === t; // eslint-disable-line valid-typeof
      default:
        return true; // unknown type keyword — don't invent a failure
    }
  });
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} ${JSON.stringify(value)}`.slice(0, 80);
}

/**
 * Validate and either throw (errors) or print (warnings). The shape every
 * caller wants: the build fails loudly on an incompatible contract and keeps
 * going — noisily — on anything else.
 *
 * @template T
 * @param {T} doc
 * @param {object} schema
 * @param {{ strict?: boolean, label?: string, onWarn?: (msg: string) => void }} [opts]
 * @returns {T}
 */
export function assertValid(doc, schema, opts = {}) {
  const { errors, warnings } = validate(doc, schema, opts);
  const onWarn = opts.onWarn ?? ((msg) => console.warn(`  warning  ${msg}`));
  for (const w of warnings) onWarn(w);
  if (errors.length) {
    throw new Error(`StoryLark contract validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return doc;
}
