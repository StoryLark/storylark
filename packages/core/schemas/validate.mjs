// StoryLark contract validation, as `storylark-core/schemas`.
//
// The implementation and the schema files moved to `storylark-contracts` in
// Phase 4 (AB#7417 — plan §0c/§0d), because the package-import endpoint runs
// inside the Worker and cannot import a frontend package. See
// packages/contracts/validate.mjs for the full reasoning.
//
// This file stays, and stays exported, for two reasons: `storylark-core/schemas`
// is the import path already written into the Vite preset, `migrate-brand`, and
// the docs; and `readContract()` — the read-parse-validate convenience the Node
// callers actually use — needs `node:fs`, which is precisely why it cannot live
// in the shared package.

import { readFileSync } from 'node:fs';
import { assertValid } from 'storylark-contracts/validate';

export {
  BRAND_SCHEMA,
  PRESENTATION_SCHEMA,
  DEPLOYMENT_SCHEMA,
  SUPPORTED_CONTRACT_VERSION,
  MIN_SUPPORTED_CONTRACT_VERSION,
  RELOCATED_BRAND_KEYS,
  DEPLOYMENT_DEFAULTS,
  validate,
  assertValid,
} from 'storylark-contracts/validate';

/** Read + parse + validate a contract file in one step. */
export function readContract(file, schema, opts = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`StoryLark contract ${file} could not be read: ${err.message}`);
  }
  return assertValid(parsed, schema, { label: file, ...opts });
}
