// AB#7389 — narrator voice preview samples.
//
// Unit coverage for lib/voice-samples.mjs's pure/orchestration logic,
// independent of spawning the CLI. The `synthesize` seam here is faked for
// the reason the module's own header explains: no test in this suite has
// ever spawned the real Kokoro model (every existing CLI-spawn test
// publishes with --no-audio), and — verified directly against this
// environment while writing this test — the per-voice binaries Kokoro needs
// are fetched relative to node_modules/kokoro-js at import time; making that
// a real network dependency of a unit test that only needs to prove the
// STATE-DRIVEN skip/write rule would make the rule's own test flaky for a
// reason that has nothing to do with the rule. Real synthesis is exercised
// end-to-end by voice-samples-cli.test.mjs instead.
//
//   node --import tsx/esm --test packages/pipeline/test/voice-samples.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleSentence, ensureVoiceSamples } from '../lib/voice-samples.mjs';

test('sampleSentence builds from the brand unit noun, never hardcoding "story"/"book"', () => {
  assert.equal(
    sampleSentence({ unit: 'chapter' }),
    "Hi! I'm one of the voices that can read your chapter to you.",
    'must use whatever unit noun the brand supplies, not a hardcoded word'
  );
  assert.equal(
    sampleSentence({ unit: 'letter' }),
    "Hi! I'm one of the voices that can read your letter to you."
  );
});

test('sampleSentence falls back to the fixed sentence when the brand has no unit noun', () => {
  assert.equal(sampleSentence(undefined), "Hi! I'm one of the voices that can read to you.");
  assert.equal(sampleSentence({}), "Hi! I'm one of the voices that can read to you.");
  assert.equal(sampleSentence({ unit: '   ' }), "Hi! I'm one of the voices that can read to you.");
});

/** A fake `synthesize` that just writes a marker so tests can prove whether
 *  it ran, without touching Kokoro/ffmpeg. */
function countingFakeSynthesize() {
  const calls = [];
  const fn = async (voice, sentence, outFile) => {
    calls.push(voice);
    await writeFile(outFile, `fake-audio:${voice}:${sentence}`);
  };
  fn.calls = calls;
  return fn;
}

/** A fake `upload` that just copies into a map keyed by the storage path, so
 *  assertions can inspect exactly what would have been uploaded. */
function recordingFakeUpload() {
  const uploaded = new Map();
  const fn = async (localFile, path) => {
    uploaded.set(path, await readFile(localFile, 'utf8'));
  };
  fn.uploaded = uploaded;
  return fn;
}

test('ensureVoiceSamples synthesizes + uploads a sample per voice and returns sampleUrl for each', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'storylark-voice-samples-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const state = {};
  const synthesize = countingFakeSynthesize();
  const upload = recordingFakeUpload();
  const sentence = "Hi! I'm one of the voices that can read your story to you.";

  const result = await ensureVoiceSamples({
    voices: ['af_heart', 'bm_fable'],
    sentence,
    workDir,
    state,
    synthesize,
    upload,
  });

  assert.deepEqual(result, { af_heart: 'samples/af_heart.mp3', bm_fable: 'samples/bm_fable.mp3' });
  assert.deepEqual(synthesize.calls.sort(), ['af_heart', 'bm_fable'], 'both voices should have been synthesized');
  assert.equal(upload.uploaded.get('samples/af_heart.mp3'), `fake-audio:af_heart:${sentence}`);
  assert.equal(upload.uploaded.get('samples/bm_fable.mp3'), `fake-audio:bm_fable:${sentence}`);
  assert.ok(state.samples.af_heart, 'state.samples must record a hash for the voice so a rerun can skip it');
  assert.ok(state.samples.bm_fable);
});

test('a rerun with the same sentence skips every voice — state-driven, like chapter tracks', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'storylark-voice-samples-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const state = {};
  const sentence = "Hi! I'm one of the voices that can read your story to you.";
  const first = countingFakeSynthesize();
  await ensureVoiceSamples({ voices: ['af_heart', 'bm_fable'], sentence, workDir, state, synthesize: first, upload: recordingFakeUpload() });
  assert.equal(first.calls.length, 2, 'first run synthesizes both voices');

  // Same `state` object carried into a second run — exactly what publish.mjs
  // does (it reads state.json once, mutates it in place, writes it back).
  const second = countingFakeSynthesize();
  const secondUpload = recordingFakeUpload();
  const result = await ensureVoiceSamples({ voices: ['af_heart', 'bm_fable'], sentence, workDir, state, synthesize: second, upload: secondUpload });

  assert.equal(second.calls.length, 0, 'a rerun with an unchanged sentence must not re-synthesize anything');
  assert.equal(secondUpload.uploaded.size, 0, 'a rerun with an unchanged sentence must not re-upload anything');
  assert.deepEqual(result, { af_heart: 'samples/af_heart.mp3', bm_fable: 'samples/bm_fable.mp3' }, 'sampleUrl is still reported for a skipped voice');
});

test('a changed sentence (e.g. the brand unit noun changed) re-synthesizes only — the cache is keyed by sentence content', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'storylark-voice-samples-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const state = {};
  await ensureVoiceSamples({
    voices: ['af_heart'],
    sentence: 'Hi! Old sentence.',
    workDir,
    state,
    synthesize: countingFakeSynthesize(),
    upload: recordingFakeUpload(),
  });
  const oldHash = state.samples.af_heart;

  const rerun = countingFakeSynthesize();
  await ensureVoiceSamples({
    voices: ['af_heart'],
    sentence: 'Hi! New sentence.',
    workDir,
    state,
    synthesize: rerun,
    upload: recordingFakeUpload(),
  });

  assert.equal(rerun.calls.length, 1, 'a changed sentence must be re-synthesized');
  assert.notEqual(state.samples.af_heart, oldHash, 'the recorded hash must move with the sentence');
});

test('ensureVoiceSamples writes the sample file to disk before uploading it', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'storylark-voice-samples-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  let sawFileAtUploadTime = false;
  await ensureVoiceSamples({
    voices: ['af_heart'],
    sentence: 'Hi!',
    workDir,
    state: {},
    synthesize: async (voice, sentence, outFile) => writeFile(outFile, 'x'),
    upload: async (localFile) => {
      sawFileAtUploadTime = existsSync(localFile);
    },
  });

  assert.ok(sawFileAtUploadTime, 'the synthesized file must exist on disk by the time upload() is called');
});
