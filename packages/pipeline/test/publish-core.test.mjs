// Unit coverage for the pure reconstruction helpers (AB#7654,
// lib/publish-core.mjs) — independent of spawning the CLI or any fixture
// deployment, so the id-extraction and shape-building rules are pinned down
// directly.
//
//   node --import tsx/esm --test packages/pipeline/test/publish-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashFromArtifactPath,
  reconstructAudioFromLive,
  reconstructPreviousFromLive,
  findLiveChapterEntry,
} from '../lib/publish-core.mjs';

test('hashFromArtifactPath extracts the hash from primary and per-voice artifact paths', () => {
  assert.equal(hashFromArtifactPath('the-arrival', 'books/mybook/audio/the-arrival.a1b2c3d4.mp3'), 'a1b2c3d4');
  assert.equal(hashFromArtifactPath('the-arrival', 'books/mybook/timings/the-arrival.a1b2c3d4.json'), 'a1b2c3d4');
  assert.equal(hashFromArtifactPath('the-arrival', 'books/mybook/audio/the-arrival.a1b2c3d4.bm_fable.mp3'), 'a1b2c3d4');
  assert.equal(hashFromArtifactPath('the-arrival', 'books/mybook/chapters/the-arrival.a1b2c3d4.json'), 'a1b2c3d4');
});

test('hashFromArtifactPath degrades gracefully on the missing/malformed cases', () => {
  assert.equal(hashFromArtifactPath('the-arrival', undefined), undefined);
  assert.equal(hashFromArtifactPath('the-arrival', ''), undefined);
});

test('reconstructAudioFromLive returns null audio for a text-only live chapter', () => {
  const result = reconstructAudioFromLive({ hasAudio: false, contentHash: 'deadbeef' }, 'ch', 'af_heart');
  assert.deepEqual(result, { audio: null, voices: undefined });
});

test('reconstructAudioFromLive reconstructs the state shape from a narrated live chapter, excluding the primary voice from `voices`', () => {
  const liveChapterEntry = {
    hasAudio: true,
    audioDurationMs: 54321,
    audio: 'books/b/audio/ch.abc12345.mp3',
    timings: 'books/b/timings/ch.abc12345.json',
    voices: {
      af_heart: { audio: 'books/b/audio/ch.abc12345.mp3', timings: 'books/b/timings/ch.abc12345.json' },
      bm_fable: { audio: 'books/b/audio/ch.abc12345.bm_fable.mp3', timings: 'books/b/timings/ch.abc12345.bm_fable.json' },
    },
  };
  const { audio, voices } = reconstructAudioFromLive(liveChapterEntry, 'ch', 'af_heart');
  assert.deepEqual(audio, { durationMs: 54321, hash: 'abc12345' });
  assert.deepEqual(Object.keys(voices), ['bm_fable'], 'the primary voice is not duplicated into the extras map');
});

test('reconstructAudioFromLive extracts the hash the audio path ACTUALLY carries, not contentHash — the audioStale case', () => {
  // contentHash has moved on (a later edit) but the audio still points at the
  // hash it was narrated against — exactly what audioStale:true describes.
  const liveChapterEntry = {
    hasAudio: true,
    contentHash: 'newhash1',
    audioDurationMs: 1000,
    audio: 'books/b/audio/ch.oldhash1.mp3',
    timings: 'books/b/timings/ch.oldhash1.json',
    audioStale: true,
  };
  const { audio } = reconstructAudioFromLive(liveChapterEntry, 'ch', 'af_heart');
  assert.equal(audio.hash, 'oldhash1', 'the OLD hash the audio was actually narrated against, not the current contentHash');
});

test('reconstructPreviousFromLive builds the same shape state.chapters[key] would hold', () => {
  const liveChapterEntry = {
    contentHash: 'aaaa1111',
    publishedAt: '2026-01-01',
    hasAudio: true,
    audioDurationMs: 2000,
    audio: 'books/b/audio/ch.aaaa1111.mp3',
    timings: 'books/b/timings/ch.aaaa1111.json',
  };
  const contentJson = { blocks: [{ id: 'b001', type: 'paragraph', text: 'Hello.' }] };
  const prev = reconstructPreviousFromLive(liveChapterEntry, contentJson, 'ch', 'af_heart');
  assert.deepEqual(prev, {
    hash: 'aaaa1111',
    blocks: contentJson.blocks,
    audio: { durationMs: 2000, hash: 'aaaa1111' },
    voices: undefined,
    publishedAt: '2026-01-01',
  });
});

test('findLiveChapterEntry finds a chapter across books, and returns undefined for anything not live', () => {
  const manifest = {
    books: [
      { id: 'a', chapters: [{ id: 'one' }, { id: 'two' }] },
      { id: 'b', chapters: [{ id: 'one' }] },
    ],
  };
  assert.equal(findLiveChapterEntry(manifest, 'a', 'two').id, 'two');
  assert.equal(findLiveChapterEntry(manifest, 'b', 'one').id, 'one');
  assert.equal(findLiveChapterEntry(manifest, 'a', 'nope'), undefined);
  assert.equal(findLiveChapterEntry(manifest, 'nope', 'one'), undefined);
  assert.equal(findLiveChapterEntry(null, 'a', 'one'), undefined);
});
