---
'storylark-pipeline': minor
'storylark-worker': minor
'storylark-core': minor
---

Content can come from somewhere else, and then it isn't ours to edit (AB#7422, AB#7426)

The portal assumed StoryLark was the system of record. A publisher who already
has a website repository or a content system is not going to re-author their
catalogue in it, and will not accept two divergent copies of the truth. So
content now records **where it came from**, and one rule follows from it:
*whoever owns the content owns the edit button.*

**`origin` on every book and chapter** — `portal`, `cli`, `sync` or `personal`.
An absent value reads as `cli`, so every library published before this field
existed keeps working and stays fully editable; nothing becomes read-only by
omission. `personal` is the seam a reader's own device-local imports will arrive
through, and is not otherwise built.

**Two pull connectors, and no bespoke ones ever** —
`packages/pipeline/sync.mjs --brand <id>` pulls a library from either a **git
repository of markdown** (a real shallow `git clone`, so any host works with no
per-host code; private repos via `STORYLARK_SYNC_TOKEN`) or the publisher's own
system over a **small documented JSON feed**. It stages the result in the blessed
folder-per-book layout and then runs `publish.mjs` over it — so change detection,
narration, force-alignment, upload, manifest-written-last and push notification
are the pipeline that already existed, not a second copy of it. A third `kind` is
rejected with a pointer at the content API: "we'll write a connector for your
CMS" is the one commitment here that could never be finished.

**Pipeline** — `--origin` and `--sync-kind/-url/-ref/-path`; a republish preserves
whatever origin is already live rather than relabelling it, so a synced library
that gets its narration from an ordinary `publish` run stays synced. **A publish
now only removes books it could have produced**: a sync no longer deletes
portal-written stories from the manifest, a CLI publish no longer deletes the
synced catalogue, and `--book <id>` narrows the publish rather than the library.
The library version is also seeded from a `--local` directory's existing
manifest, so two publishes into one directory can't both claim v1.

**Worker** — the admin content API refuses every write against `origin: sync`
with `409 managed_externally` and a message naming the actual source, while
leaving reads, downloads and history alone. `portal` and `cli` content is
untouched. The listing and chapter detail now carry `origin`, `readOnly` and
`syncSource`.

**Portal** — synced rows are badged, and a synced chapter opens as a read-only
view with a *Managed externally — edit at source* notice and a link, instead of
an editor whose save button would be refused.

Configuration lives in `deployment/<id>/deployment.json` (`sync.kind`/`url`/`ref`/
`path`, schema-validated) or `STORYLARK_SYNC_*`. The credential is environment
only — a token in the committed file is a hard error. Scheduling runs where
publishing runs; scaffolded sites now get a `sync.yml` workflow (nightly cron
plus a manual button) alongside `publish.yml`. Full guide: `docs/content-sync.md`.

Also fixed while adding `sync.mjs` to the package: `storylark-pipeline` was not
shipping `storage.mjs` or `storage-azure.mjs`, so `publish.mjs` in the published
tarball crashed on its own storage seam.
