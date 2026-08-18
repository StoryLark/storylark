// AB#7654 — narration metadata carry-forward.
//
// The bug: publish.mjs rebuilds the manifest purely from `state.chapters`
// (this machine's local ledger). The audio carry-forward for an unchanged
// chapter is `prev?.audio ?? null` / `prev?.voices ?? undefined` — LOCAL
// STATE ONLY. On a fresh runner publishing `--no-audio`, `prev` is undefined,
// so `audio`/`timings`/`voices`/`hasAudio` are silently dropped from the
// manifest even though the objects are still sitting in the bucket. `--no-
// audio` is supposed to mean "upload no NEW audio," never "erase narration
// references that already exist."
//
// These tests fabricate a "chapter that already has real narration" by
// publishing text-only for real and then hand-editing the resulting manifest
// to add the audio fields a narrated publish would have written — the
// carry-forward logic under test (reconstructAudioFromLive /
// reconstructPreviousFromLive, lib/publish-core.mjs) only ever reads the live
// MANIFEST's fields, never the audio bytes themselves, so this exercises the
// real code path without needing a real TTS run.
//
//   node --import tsx/esm --test packages/pipeline/test/stateless-audio-carryforward.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  makeRoot,
  writeChapter,
  runPublish,
  deleteState,
  localManifestFile,
  readJson,
  writeJson,
  cleanup,
} from './helpers.mjs';

const ARRIVAL_V1 = `---
title: The Arrival
---

The lighthouse keeper climbed the stairs at dawn, same as every morning for thirty years.

The sea was calm today, unusually so, and something about that calm unsettled her.
`;

// A genuine prose edit — this is what makes the chapter's contentHash change.
const ARRIVAL_V2 = `---
title: The Arrival
---

The lighthouse keeper climbed the stairs at dawn, same as every morning for thirty years, boots loud on the iron treads.

The sea was calm today, unusually so, and something about that calm unsettled her.
`;

const DEPARTURE_V1 = `---
title: The Departure
---

She left the island on the last ferry of the season, and did not look back at the light.
`;

// Used only to force a companion chapter to be "changed" so the manifest
// actually gets rebuilt — the interesting assertion is about "the-arrival",
// which stays byte-identical across the run.
const DEPARTURE_V2 = `---
title: The Departure
---

She left the island on the last ferry of the season, and did not look back at the light, not even once.
`;

/**
 * Publish a two-chapter book text-only, then fabricate narration for
 * "the-arrival" directly in the (real, `--local`-served) manifest — as if
 * some other, narration-capable machine had published it. Deletes local
 * state afterwards so the next publish in the test is genuinely stateless.
 */
async function seedNarratedFixture(root) {
  const arrivalFile = await writeChapter(root, 'mybook', '01-the-arrival.md', ARRIVAL_V1);
  const departureFile = await writeChapter(root, 'mybook', '02-the-departure.md', DEPARTURE_V1);
  const seed = await runPublish(root, ['--no-audio']);
  assert.equal(seed.code, 0, `seed publish failed:\n${seed.stdout}\n${seed.stderr}`);

  const manifestPath = localManifestFile(root);
  const manifest = await readJson(manifestPath);
  const book = manifest.books.find((b) => b.id === 'mybook');
  const arrival = book.chapters.find((c) => c.id === 'the-arrival');
  assert.equal(arrival.hasAudio, false, 'sanity: seeded text-only');
  const hash = arrival.contentHash;

  arrival.hasAudio = true;
  arrival.audioDurationMs = 87654;
  arrival.audio = `books/mybook/audio/the-arrival.${hash}.mp3`;
  arrival.timings = `books/mybook/timings/the-arrival.${hash}.json`;
  arrival.audioStale = false;
  await writeJson(manifestPath, manifest);

  await deleteState(root);
  return { arrivalFile, departureFile, hash };
}

test('stateless + --no-audio + an unchanged narrated chapter keeps its audio/timings/hasAudio in the rebuilt manifest', async (t) => {
  const root = await makeRoot();
  t.after(() => cleanup(root));
  const { departureFile, hash } = await seedNarratedFixture(root);

  // Force the manifest to actually be rebuilt (a sibling chapter changes);
  // "the-arrival" itself is untouched.
  await writeFile(departureFile, DEPARTURE_V2);
  const res = await runPublish(root, ['--no-audio']);
  assert.equal(res.code, 0, `publish failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /1 changed since last publish/, 'only the-departure should be reported changed');

  const manifest = await readJson(localManifestFile(root));
  const arrival = manifest.books.find((b) => b.id === 'mybook').chapters.find((c) => c.id === 'the-arrival');
  assert.equal(arrival.contentHash, hash, 'the-arrival text did not change');
  assert.equal(arrival.hasAudio, true, '--no-audio must not erase existing narration metadata');
  assert.equal(arrival.audioDurationMs, 87654);
  assert.equal(arrival.audio, `books/mybook/audio/the-arrival.${hash}.mp3`);
  assert.equal(arrival.timings, `books/mybook/timings/the-arrival.${hash}.json`);
  assert.equal(arrival.audioStale, false, 'unchanged text with carried-forward audio is not stale');
});

test('stateless + --no-audio + a CHANGED narrated chapter preserves the old audio reference, marked audioStale', async (t) => {
  const root = await makeRoot();
  t.after(() => cleanup(root));
  const { arrivalFile, hash: oldHash } = await seedNarratedFixture(root);

  // Edit the narrated chapter itself, from a machine with no local ledger.
  await writeFile(arrivalFile, ARRIVAL_V2);
  const res = await runPublish(root, ['--no-audio']);
  assert.equal(res.code, 0, `publish failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /1 changed since last publish/);
  assert.doesNotMatch(res.stderr, /CONFLICT/, 'a stateless machine editing narrated text is not a conflict');

  const manifest = await readJson(localManifestFile(root));
  const arrival = manifest.books.find((b) => b.id === 'mybook').chapters.find((c) => c.id === 'the-arrival');
  assert.notEqual(arrival.contentHash, oldHash, 'the text really did change, so the content hash must move');
  assert.equal(arrival.content, `books/mybook/chapters/the-arrival.${arrival.contentHash}.json`, 'new text uploads under its own hash');
  assert.equal(arrival.hasAudio, true, 'the audio reference must never be silently dropped');
  assert.equal(arrival.audioDurationMs, 87654, 'the OLD audio duration, because no new audio was synthesized');
  assert.equal(arrival.audio, `books/mybook/audio/the-arrival.${oldHash}.mp3`, 'audio keeps pointing at the OLD (still-immutable, still-live) object');
  assert.equal(arrival.timings, `books/mybook/timings/the-arrival.${oldHash}.json`);
  assert.equal(arrival.audioStale, true, 'text moved on but the audio did not — exactly what audioStale exists to say');
});
