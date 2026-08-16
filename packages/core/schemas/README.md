# StoryLark contract schemas

The three files a StoryLark deployment is described by, one JSON Schema each
(draft 2020-12), plus the validator that reads them.

> **The schema files and the validator live in `storylark-contracts`**
> (`packages/contracts/`) since Phase 4. They moved because the package-import
> endpoint validates uploads inside the Worker, and a Worker cannot import a
> frontend package — see `packages/contracts/validate.mjs` for the full
> reasoning. `storylark-core/schemas` re-exports all of it and adds
> `readContract()`, so every import path in this repo is unchanged.

| Schema | Describes | Lives at |
|---|---|---|
| `brand.schema.json` | Identity + look — names, tagline, author, manifest colours, default theme, fonts | `brands/<id>/brand.json` |
| `presentation.schema.json` | Shape — `layout`, `nouns`, and the rest of the presentation contract | `presentation/<id>/presentation.json` |
| `deployment.schema.json` | Where it lives and how it publishes — origins, VAPID public key, TTS | `deployment/<id>/deployment.json`, or `STORYLARK_*` env vars |

**Why three files and not one.** A core update must never touch a customer's
brand or presentation, and a brand must be portable between deployments. That
is only true if identity, shape and deployment config are separate artifacts:
a brand package ships `brand.json` + `theme.css` + `assets/icons/` and nothing
that names a server; deployment config is set at install and never travels.

## `contractVersion`

Every file carries `contractVersion`, an integer starting at 1. There is no
dotted minor, so **the integer is the major**. The engine reads
`MIN_SUPPORTED_CONTRACT_VERSION`..`SUPPORTED_CONTRACT_VERSION` (both `1` today)
and refuses anything outside that range.

The version does **not** move when the contract gains a key — the two
compatibility rules already cover that:

1. **A missing key takes the core default, permanently.** A template written
   today keeps working on every future engine.
2. **An unknown key is ignored with a warning.** A template written for a newer
   engine loads on an older one without exploding.

It moves only on a genuinely breaking reshape.

## Using the validator

```js
import { readContract, BRAND_SCHEMA } from 'storylark-core/schemas';

const brand = readContract('brands/storylark/brand.json', BRAND_SCHEMA);
```

`validate()` returns `{ errors, warnings }`; `assertValid()` prints the warnings
and throws on errors; `readContract()` does read + parse + assert.

**Severity depends on who's calling.** By default only a `contractVersion`
mismatch is an error — a build never dies over a field it can ignore. Pass
`{ strict: true }` from tooling that *produces* a file (the migration script,
and later the packaging tool and the import endpoint) so every finding is an
error and a bad file is caught by whatever emits it.

## Where these are used

- `packages/core/vite/index.mjs` — validates brand + presentation + deployment
  as it loads them for a build (non-strict).
- `packages/core/bin/migrate-brand.mjs` — validates the files it writes (strict).
- `packages/core/bin/package-theme.mjs` — validates a brand folder before it
  emits a theme package (strict).
- `packages/worker/src/lib/theme-store.ts` — validates an uploaded theme package
  before the deployment adopts it (strict), through the same
  `storylark-contracts/theme-package` module the packager uses.

The schema files are plain JSON Schema, published at
`storylark-contracts/schemas/*.json`, so they can be handed to `ajv` unchanged.
