# Deployment Safety

Use this checklist before an install, engine update, or content-source cutover
on a site that already has readers or published content.

## Before the change

- Run `npm ci`, `npm run doctor`, tests, type-check, and build from the exact
  commit you intend to deploy.
- Record the current commit, package lock, Worker version, migration list, and
  public health response.
- Export the database and copy the content bucket to a dated, isolated backup.
  Verify that the export can be read and that the copied object count matches.
- Inventory `manifest.json` and every referenced cover, chapter JSON, source,
  audio, timing, and per-voice track path. Record SHA-256 values where the
  storage provider permits it.
- Do not delete missing content, replace the production manifest, rotate
  credentials, or retire existing automation during the rehearsal.

## Rehearsal

1. Restore the production database and content copy into an isolated
   deployment.
2. Configure the repository connection through Admin. Private repositories use
   a read-only `CONTENT_SYNC_TOKEN` platform secret; never put it in a file.
3. Run content validation and the repository dry run. Any error blocks the
   cutover; validation failures publish nothing.
4. Run the sync once, compare the complete before/after inventory, then run it
   again. The second run must write zero chapters and must not change
   `libraryVersion`, prose hashes, narration, timings, or `voices` paths.
5. Test a multi-chapter book and a standalone story: reading, listening,
   narrator switching where offered, download/offline use, and saved progress.
6. Rehearse rollback to the previous Worker and manifest/database state.

## Production gate

Deploy only after the rehearsal passes and an operator explicitly approves the
production change. Monitor health and the primary read/listen flows for at
least 15 minutes. Roll back if content membership changes unexpectedly, an
existing account/progress record disappears, narration paths change without a
planned re-narration, or the app/health endpoints fail.

Keep the backup and prior automation for at least seven days. Removing either
is a separate operator-approved action.
