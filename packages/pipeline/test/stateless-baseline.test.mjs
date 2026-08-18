// AB#7654 — stateless baseline reconstruction.
//
// The bug: publish.mjs keys "changed" and "conflict" purely off the
// machine-local ledger `.storylark/state/<bucket>.json`. On a fresh runner
// that ledger is empty, so:
//   • every chapter looks "changed" (nothing to hash-compare against), and
//   • detectConflicts() flags every already-live chapter as a conflict, base
//     "(never published from this machine)" — even when the live text is
//     byte-identical.
//
// The second half of that is the sharp edge: `contentHash` covers block ids,
// and stabilizeBlockIds() (lib/md.mjs) INHERITS ids across edits, so a live
// chapter that has been incrementally edited holds non-sequential ids
// (b003, b001, b002, …) while a from-scratch parse with no previous blocks
// produces plain sequential ids (b001, b002, b003). Same words, different
// hash. That is reproduced for real below — not asserted from a diagram —
// by actually editing the chapter twice, from a machine that has state, and
// only THEN wiping state and republishing.
//
//   node --import tsx/esm --test packages/pipeline/test/stateless-baseline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoot, writeChapter, runPublish, deleteState, cleanup } from './helpers.mjs';

const V1 = `---
title: The Arrival
---

The lighthouse keeper climbed the stairs at dawn, same as every morning for thirty years.

The sea was calm today, unusually so, and something about that calm unsettled her.
`;

// v2 inserts a new paragraph at the TOP. Per stabilizeBlockIds() (md.mjs):
// the two old paragraphs re-match their old ids (b001, b002) on the inherit
// pass; the new paragraph's freshly-parsed id (b001) collides with the
// inherited b001 and is bumped to the next free id — b003. Final live order:
// [b003, b001, b002]. A from-scratch parse of the SAME text with no previous
// blocks would instead produce the "obvious" [b001, b002, b003] — same prose,
// different ids, different contentHash. This is the exact mismatch AB#7654's
// baseline reconstruction closes.
const V2 = `---
title: The Arrival
---

A storm had passed in the night, leaving the rocks slick and the air smelling of salt and ozone.

The lighthouse keeper climbed the stairs at dawn, same as every morning for thirty years.

The sea was calm today, unusually so, and something about that calm unsettled her.
`;

// v3 is a genuine further edit to the NEW top paragraph — a real content
// change, made (in these tests) from a "fresh machine" with no local ledger.
const V3 = `---
title: The Arrival
---

A storm had passed in the night, leaving the rocks slick, the gulls screaming overhead, and the air smelling of salt and ozone.

The lighthouse keeper climbed the stairs at dawn, same as every morning for thirty years.

The sea was calm today, unusually so, and something about that calm unsettled her.
`;

/** Publish v1, then edit to v2 and publish again — both from a machine WITH
 *  state, exactly like an operator's laptop. Returns the chapter file path.
 *  The live deployment (the `--local` mirror) now holds v2 with
 *  non-sequential block ids, and this machine's ledger agrees with it. */
async function seedIncrementallyEditedLibrary(root) {
  const file = await writeChapter(root, 'mybook', '01-the-arrival.md', V1);
  const first = await runPublish(root, ['--no-audio']);
  assert.equal(first.code, 0, `seed v1 publish failed:\n${first.stdout}\n${first.stderr}`);

  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, V2);
  const second = await runPublish(root, ['--no-audio']);
  assert.equal(second.code, 0, `seed v2 publish failed:\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /1 changed since last publish/, 'v2 edit should have been detected as changed by the seeding machine');

  return file;
}

test('a stateless republish of byte-identical live content reports zero changed and zero conflicts', async (t) => {
  const root = await makeRoot();
  t.after(() => cleanup(root));

  await seedIncrementallyEditedLibrary(root);

  // Now simulate a fresh machine: same live deployment, no local ledger.
  await deleteState(root);
  const res = await runPublish(root, ['--no-audio']);

  assert.equal(res.code, 0, `stateless republish should succeed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /0 changed since last publish/, 'identical content on a stateless runner must not look changed');
  assert.doesNotMatch(res.stdout, /CONFLICT/, 'identical content on a stateless runner must not be flagged as a conflict');
  assert.doesNotMatch(res.stderr, /CONFLICT/, 'identical content on a stateless runner must not be flagged as a conflict');
  assert.match(res.stdout, /Nothing to publish/);
});

test('a stateless republish of genuinely edited content is reported changed with the live hash as base, not a conflict', async (t) => {
  const root = await makeRoot();
  t.after(() => cleanup(root));

  const file = await seedIncrementallyEditedLibrary(root);

  // Fresh machine, AND a real edit this fresh machine is the first to make.
  await deleteState(root);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, V3);
  const res = await runPublish(root, ['--no-audio']);

  assert.equal(res.code, 0, `a stateless edit must publish, not refuse:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /1 changed since last publish/, 'the real edit must still be detected as changed');
  assert.doesNotMatch(
    res.stdout,
    /CONFLICT/,
    'a stateless machine publishing its own first edit is not a conflict — the live hash is its base, not "never published from this machine"'
  );
  assert.doesNotMatch(
    res.stderr,
    /CONFLICT/,
    'a stateless machine publishing its own first edit is not a conflict — the live hash is its base, not "never published from this machine"'
  );
});

// NOTE on scope: a stateless run's reconstructed baseline sets `prev.hash` to
// whatever is CURRENTLY live (that is the whole point — see the fix's header
// comment), so `liveChapter.contentHash === base` is tautologically true for
// any chapter reconstructed this way. A stateless runner therefore can never
// raise the "someone else changed the live text without me knowing" conflict
// for a chapter it has no local ledger entry for — it always trusts live as
// its base. That is the documented trade-off in AB#7654 (a stateless runner
// has no memory to compare against, so there is nothing else it COULD trust),
// not a regression: conflict detection is unchanged for any machine that
// still has its own local state, and cross-origin content (e.g. a sync run
// next to portal-written books) was never compared in the first place.
