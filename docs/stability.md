# StoryLark 1.0 stability policy

StoryLark 1.0 freezes the contracts a publisher, deployment, content system, or
theme can reasonably depend on. A compatible minor or patch release may add
optional fields and capabilities, but it does not remove or reinterpret an
existing supported field. A breaking change requires a major package release or
a new explicitly versioned HTTP contract.

## Frozen public contracts

| Surface | Version boundary | Compatibility rule |
|---|---|---|
| `brand.json` | schema `contractVersion` | Existing valid identity and theme-token inputs remain valid. New fields are optional. |
| `presentation.json` | schema `contractVersion` | Missing keys keep the core default; unknown feature entries are tolerated. Existing supported keys keep their meaning. |
| `deployment.json` | schema `contractVersion` | Existing platform configuration remains readable; new settings are optional. Secrets never belong in the file. |
| Library manifest and chapter JSON | manifest/schema version | Existing published content remains readable. Additions are optional; a breaking reshape increments the content schema. |
| Content API | `/api/content/v1` plus body `contractVersion` | Additive fields do not move v1. A breaking request or response shape uses a new version. |
| Theme packages | package manifest version | Import validates the whole archive before activation; an unsupported format is rejected without a partial install. |
| Prebuilt engine packages | package manifest version and SHA-256 | Artifacts remain brand-free, checksum-verified, atomic, and rollback-capable. |
| Database and storage adapters | exported TypeScript interfaces | Minor releases may add optional capabilities. Existing required methods and meanings remain stable. |
| Database migrations | ordered migration set | Migrations are additive and old code must tolerate the newer schema so engine rollback remains possible. |

The JSON Schemas in `packages/contracts/schemas`, the public exports declared in
each package's `package.json`, and the versioned API documentation are the
normative machine-facing definitions. The human guides explain their intended
use but do not expand the supported surface beyond those definitions.

## Not frozen

Internal source paths that are not package exports, CSS class names, private
functions, Admin implementation details, and undocumented database queries are
not public contracts. Forks that edit core components can continue to do so,
but those edits carry their own merge and compatibility responsibility.

## Deprecation and security

When a supported surface can be retired without an immediate major release,
StoryLark documents the replacement and keeps the old behavior for at least one
minor release. Security fixes may narrow unsafe input or reject data that never
met the documented contract; that is a correction, not a compatibility promise
to preserve dangerous behavior.

See [Upgrading](upgrading.md) for package linkage, release mechanics, and the
separately versioned content API.
