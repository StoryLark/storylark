---
'storylark-contracts': minor
'storylark-core': minor
'storylark-worker': minor
---

Theme packages: install a brand from a zip, from the portal or the CLI, with versions and one-click rollback (AB#7417 — plan §0c / §0d Phase 4)

Phases 2 and 3 made brand, stylesheet and presentation into files the deployment
serves and re-reads per request, so swapping one changes a live site with no
rebuild. This is the piece that let anyone actually perform the swap — on
Cloudflare there was no filesystem to swap files on at all.

**The format** is what a brand folder already is: `<id>.storylark-theme.zip`
holding `package.json`, `brand.json`, `theme.css`, `icons/` and optionally
`presentation.json`.

**The tool's value is validation, not zipping.** `npm run package-theme` refuses
to emit a package the deployment would refuse to install, using the same module
the deployment uses — missing or wrongly-sized icons, missing design tokens, a
dark-first theme with a dark alternate block, an unknown `contractVersion`. Output
is deterministic, so packaging an unchanged brand produces an unchanged file.

**Two doors, one implementation.** `npm run import-theme` posts the same zip to
the same `POST /api/admin/themes/import` the portal's upload button posts to —
authenticated by an admin session or the `ADMIN_KEY` the publish pipeline already
uses. Also: `--check`, `--list`, `--rollback previous`, `--revert`.

**An installed theme lives in the deployment's own storage**, on the same seam
content editing already binds on both platforms; the build's assets stay the
fallback, so an engine update cannot change how an existing site looks until
somebody imports something. Validation happens before any write, and `active.json`
is written last, so a package that fails is a pure no-op — the endpoint answers
`422` with every problem found and `applied: false`.

**Versions and rollback**: the last five (`THEME_VERSIONS` overrides), the live
one never aged out, rollback restoring exactly the bytes that were installed.

**The portal gets a Brand & themes card** — install, check-first, version history,
one-click rollback, download any version, revert to the built-in brand, and a
brand form for changing a colour or a font without a package at all. A form edit
is a version like any other, so it can be downloaded as a package and moved to
another deployment.

`storylark-contracts` is a new zero-dependency package holding the three JSON
Schemas, their validator, the theme package format and a dependency-free zip
codec — because the import endpoint validates inside the Worker, which can import
neither a frontend package nor a second copy of the rules. `storylark-core/schemas`
re-exports all of it, so every existing import path is unchanged.

Cloudflare's `run_worker_first` loses its `!/icons/*` exclusion, so an imported
package's icons can be served at all.
