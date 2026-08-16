# Theme packages

*Design note — the format, where an installed theme lives, and why it is stored
somewhere other than where the build put it. Plan §0c / §0d Phase 4 (AB#7417).*

## What Phases 2 and 3 left open

[Runtime Brand](runtime-brand.md) and the
[Presentation Contract](presentation-contract.md) made a site's identity, look
and arrangement into **files the deployment serves and re-reads on every
request** — `dist/brand.json`, `dist/theme.css`, `dist/presentation.json`.
Replace one and the live site changes, with no rebuild. Proven twice.

Which left one problem: *who replaces them?* "Overwrite the file on the deployed
site" is a real answer on a Node host, where the files are on disk. On
Cloudflare it is not an answer at all — `env.ASSETS` is an immutable snapshot of
the build and a Worker cannot write to it. The swap was possible and nobody
could perform it without a rebuild and a redeploy, which is the exact thing the
whole layer model exists to delete.

So the missing piece was never the format. It was a **writable place to put a
theme, and a door to put it through**.

## The format is what a brand folder already is

```
<id>.storylark-theme.zip
  package.json        formatVersion, id, name, version, contractVersion, engine
  brand.json          identity + look          (brand.schema.json)
  theme.css           the design tokens
  presentation.json   optional                 (presentation.schema.json)
  icons/…             favicon.svg, favicon-32/180.png, icon-192/512.png,
                      icon-maskable-512.png, logo.svg
```

`icons/` rather than `assets/icons/` because that is where the files land in a
built site and where every document already points. A package should be the
shape of the thing being installed, not the shape of the source tree it was
authored in.

`package.json` is optional to *read* — a hand-assembled folder is a legitimate
way to make one — but if present it must agree with `brand.json`, because a
manifest that disagrees is worse than no manifest.

## The tool's value is validation, not zipping

Zipping four files is not a feature. What is: catching, before upload, the
problems that would otherwise surface as a subtly broken live site.

`npm run package-theme` refuses to emit a package that the import endpoint would
refuse to accept, **using the same module to decide**
(`storylark-contracts/theme-package`). "It packaged fine but the upload failed"
is not a state that can exist.

What it catches that a build does not:

| Check | Why it is not a schema check |
|---|---|
| Missing / unknown `contractVersion` | It is, and it is the one hard gate — but strict mode makes an unknown *key* an error too, so a typo is caught by the person making the theme rather than the person installing it |
| A missing icon | Icons are files, not JSON |
| An icon at the wrong pixel size | Reads the PNG's IHDR. This is the failure discovered weeks later, on someone else's phone |
| `theme.css` missing tokens the app reads | An absent custom property renders as invalid-at-computed-value-time — unreadable text, not an error anyone sees |
| No alternate colour scheme, **or the wrong one** | A dark-first brand needs `:root[data-theme="light"]`. Backwards, the theme toggle silently does nothing |
| A font outside the curated set | A warning, never fatal: the runtime already falls back to the theme's own `--font-*`, which is the honest behaviour |

## Where an installed theme lives

In the deployment's own writable storage — the same `ContentStore` seam
[content editing](admin-content-editing.md) already binds on both platforms (R2
on Cloudflare, Azure Blob or a local directory on Node). No new binding, no new
credential, nothing platform-specific:

```
themes/active.json                       what this deployment is wearing
themes/index.json                        the version history
themes/versions/<vid>/package.json       the manifest, as imported
themes/versions/<vid>/brand.json
themes/versions/<vid>/theme.css
themes/versions/<vid>/presentation.json  when the package carried one
themes/versions/<vid>/icons/<name>
```

**The build's assets remain the fallback.** With nothing installed, a deployment
behaves exactly as it did before any of this existed — which is what makes the
phase additive: an engine update cannot change how an existing site looks until
somebody imports something.

### Why `active.json` carries the brand rather than pointing at it

`themes/active.json` is read on the way out of every HTML and `sw.js` response,
so its cost is the hot path. Holding the (small, already-validated) brand and
presentation objects inline makes that **one** storage read; pointing at the
version directory would make it three.

The version directory is not a second source of truth — it is the archive
rollback reads from, and both writers derive `active.json` from a version
directory at the moment they write it, so the two cannot drift.

`theme.css` and the icons are *not* inlined: they are needed only by
`/theme.css` and `/icons/*`, which are their own requests, and putting 2KB of
CSS plus 70KB of PNG into every HTML response would be a strange way to save a
lookup.

### `/icons/*` now reaches the Worker

Phase 2 deliberately left icon *files* as build assets, noting that swapping
them "needs no code, only a file". A package import is that file arriving
without shell access — so Cloudflare's `run_worker_first` lost its `!/icons/*`
exclusion. With nothing installed the handler falls straight through to the
asset router's own bytes; the cost is one invocation for the two or three icon
requests a cold page load makes, and the alternative is a brand whose pictures
can only be changed by rebuilding.

## Write order, so a bad import cannot half-apply

Validation happens before any write at all. Then: **version files first, then
the index, then `active.json` last** — the same rule `content.ts` follows when
it writes a chapter before the manifest that points at it.

- A package that fails validation is a pure no-op. The endpoint answers `422`
  with `applied: false` and *every* problem found, not the first.
- A package that passes and then hits a storage error leaves an orphaned version
  directory and a deployment still wearing what it wore.

Both failure modes are safe, and neither is "half a theme".

## Two doors, one implementation

| Door | Who |
|---|---|
| `POST /api/admin/themes/import`, multipart, admin session | the portal's upload button |
| `POST /api/admin/themes/import`, the same route, `X-Admin-Key` | `npm run import-theme` |

The obvious shape for a CLI would be "open the deployment's storage and write
the theme in". It was rejected: §0c promises the portal and the CLI produce
identical results, and the only version of that which survives future edits is
**one implementation with two callers**. So the CLI is an HTTP client. It also
means it needs no platform credential — the `ADMIN_KEY` the installer already
set is enough, the same credential the publish pipeline uses for
`POST /api/admin/publish`, and it works against Cloudflare, Azure and a local
`wrangler dev` alike.

The gate is `requireAdminOrKey`, and **it must be registered before
`adminContent`**: Hono composes matching middleware in registration order, and
`adminContent` gates the whole `/api/admin` prefix with
`use('/*', requireAdmin())`, which would put a session-only gate in front of
these routes and make the CLI's key door answer 401 no matter what it sent.

## The form is a version too

§0c's decision is "portal form AND package, not either/or" — the form is how you
*tweak* a brand, the package is how you *distribute* one. They are not two
systems: `PUT /api/admin/themes/brand` validates against `brand.schema.json` in
the same strict mode an imported package's `brand.json` gets, and writes a
normal version that inherits the live stylesheet, icons and presentation.

Which means a form edit shows up in the same history, rolls back the same way,
and can be **downloaded as a package** — so a colour changed on a staging site
moves to production instead of being retyped. Downloads are *rebuilt* from the
stored parts rather than kept as an archive: `buildThemePackage` is
deterministic, so the bytes are the bytes, storage is not doubled, and a form
edit — which never had an archive — is exportable at all.

## Versions and rollback

Five by default (`THEME_VERSIONS` overrides), deliberately the same number and
the same shape as the five text revisions [content editing](admin-content-editing.md)
keeps per chapter: an operator who has learnt one safety net should not have to
learn a second. The live version is pinned and never aged out. Rollback re-reads
the stored version's own files rather than trusting the index entry, so it
restores exactly the bytes that were installed.

`DELETE /api/admin/themes/active` stops overriding altogether and puts the
build's brand back. It deletes only the pointer — on a deployment with no shell,
the alternative to a mistake being reversible is a rebuild.

## `storylark-contracts`, and why it exists

The schemas and their validator started in `storylark-core/schemas` with one
consumer, the Vite preset. This phase gave them three, and the third changed
where they can live: the import endpoint runs **inside the Worker**.

That rules out a home in `storylark-core` — a frontend package carrying preact,
six font packages and two Vite plugins, none of which belongs in a Worker bundle
or in an App Service `npm install` — and equally rules out a copy in
`storylark-worker`, because a second copy is a second answer to "is this file
valid", and the day they disagreed the packager would emit packages the
deployment rejects.

So: one zero-dependency package holding the schemas, the validator, the theme
package format and a dependency-free zip codec. `storylark-core` and
`storylark-worker` both depend on it, and `storylark-core/schemas` re-exports
all of it so every existing import path is unchanged.

The zip codec is hand-rolled for the same reason: the same bytes have to be
produced by a Node CLI and consumed inside a Worker, and `node:zlib` does not
exist in a Worker while JSZip is ~100KB of dependency for two record layouts.
What *does* exist in both is `CompressionStream`/`DecompressionStream` with
`deflate-raw` — which is exactly what a zip entry uses — so the only thing left
to write is the framing. Output is deterministic (no clock is read unless asked),
so packaging the same brand twice produces byte-identical files.

## Known limits

- **An installed PWA keeps the old name and icon** until it is reinstalled. The
  operating system owns the copy of the manifest it installed with. The portal
  says so at the moment somebody changes a brand.
- **The service worker's precached icons** are refreshed when the build changes,
  not when a theme is installed, so an installed app can show the previous
  icon inside the shell until its next precache update. The manifest, the
  stylesheet and the brand data are all re-stamped and do not go stale.
- **Custom fonts are still the curated set.** A package may name any family, and
  a family with no shipped files is reported as a warning and ignored rather
  than applied.
