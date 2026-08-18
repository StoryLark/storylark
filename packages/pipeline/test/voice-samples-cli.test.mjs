// AB#7389 — narrator voice preview samples, exercised end-to-end.
//
// Unlike every other test in this directory, this one does NOT pass
// --no-audio: it spawns the REAL publish.mjs CLI, with a REAL local Kokoro
// voice model (verified directly against this environment while writing
// this test — no fixture, no stub — af_heart/bm_fable synthesize in ~15s
// each once the model is warm) so the actual samples/<voiceId>.mp3 files and
// the manifest's sampleUrl fields are proven for real, per this repo's
// standing rule to test for real rather than merely typecheck/compile. The
// state-driven SKIP rule is what has to run fast, and it does: a rerun below
// makes zero TTS calls at all.
//
//   node --import tsx/esm --test packages/pipeline/test/voice-samples-cli.test.mjs
//
// (Runs real local TTS — expect roughly 45-90s for the first publish.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, writeChapter, runPublish, readJson, localManifestFile, cleanup } from './helpers.mjs';

const CHAPTER_MD = `---
title: The Arrival
---

The keeper climbed the stairs at dawn.
`;

/** makeRoot() writes a single-voice brand.json; this repoints it at two
 *  Kokoro voices (so ALL_VOICES.length === 2, the condition that turns on
 *  both the manifest's `voices` map and sample generation) and adds a
 *  presentation.json with a distinctive unit noun, so the sample sentence
 *  can be proven to come from the brand's own nouns and not a hardcoded
 *  word (hard rule 5). */
async function makeTwoVoiceRoot() {
  const root = await makeRoot();
  const brandFile = join(root, 'brands', 'testbrand', 'brand.json');
  const brand = await readJson(brandFile);
  brand.tts = { voice: 'af_heart', voices: ['af_heart', 'bm_fable'] };
  await writeFile(brandFile, JSON.stringify(brand, null, 2));

  await mkdir(join(root, 'presentation', 'testbrand'), { recursive: true });
  await writeFile(
    join(root, 'presentation', 'testbrand', 'presentation.json'),
    JSON.stringify({ contractVersion: 1, layout: 'flat', nouns: { unit: 'yarn', unitPlural: 'yarns', Unit: 'Yarn', UnitPlural: 'Yarns' } })
  );
  return root;
}

test('a publish with 2+ voices writes samples/<id>.mp3 for each and lands sampleUrl in the manifest, built from the brand nouns', async (t) => {
  const root = await makeTwoVoiceRoot();
  t.after(() => cleanup(root));
  await writeChapter(root, 'mybook', '01-the-arrival.md', CHAPTER_MD);

  const res = await runWithTimeout(root, [], 150_000);
  assert.equal(res.code, 0, `publish should succeed:\n${res.stdout}\n${res.stderr}`);
  assert.match(
    res.stdout,
    /Voice sample \(af_heart\): "Hi! I'm one of the voices that can read your yarn to you\."/,
    'the sample sentence must be built from the brand\'s own unit noun ("yarn"), not a hardcoded word'
  );
  assert.match(res.stdout, /Voice sample \(bm_fable\):/);

  for (const voice of ['af_heart', 'bm_fable']) {
    const file = join(root, 'local-content', 'samples', `${voice}.mp3`);
    assert.ok(existsSync(file), `samples/${voice}.mp3 should exist under the published content root`);
    const s = await stat(file);
    assert.ok(s.size > 1000, `samples/${voice}.mp3 should be a real audio file, not empty (${s.size} bytes)`);
  }

  const manifest = await readJson(localManifestFile(root));
  assert.equal(manifest.voices.af_heart.sampleUrl, 'samples/af_heart.mp3');
  assert.equal(manifest.voices.bm_fable.sampleUrl, 'samples/bm_fable.mp3');
  assert.ok(manifest.voices.af_heart.name, 'the display name must still be present alongside sampleUrl');
  assert.ok(manifest.voices.bm_fable.name);

  // A rerun with nothing changed must be state-driven: no re-synthesis logged
  // for either voice, proven by absence of the log line ensureVoiceSamples()
  // only emits on an actual synthesize() call (onProgress), and by the rerun
  // finishing fast, which it could not if it were reloading the model.
  const rerunStarted = Date.now();
  const rerun = await runWithTimeout(root, [], 60_000);
  assert.equal(rerun.code, 0, `rerun should succeed:\n${rerun.stdout}\n${rerun.stderr}`);
  assert.doesNotMatch(rerun.stdout, /Voice sample \(/, 'an unchanged sentence must not be re-synthesized on a rerun');
  assert.ok(Date.now() - rerunStarted < 30_000, 'a rerun that skips every sample must not pay for a fresh model load + synthesis');

  const rerunManifest = await readJson(localManifestFile(root));
  assert.equal(rerunManifest.voices.af_heart.sampleUrl, 'samples/af_heart.mp3', 'sampleUrl survives a skip-rerun unchanged');
  assert.equal(rerunManifest.voices.bm_fable.sampleUrl, 'samples/bm_fable.mp3');
});

test('--no-audio publishes text-only and skips sample generation entirely (additive, no crash)', async (t) => {
  const root = await makeTwoVoiceRoot();
  t.after(() => cleanup(root));
  await writeChapter(root, 'mybook', '01-the-arrival.md', CHAPTER_MD);

  const res = await runPublish(root, ['--no-audio']);
  assert.equal(res.code, 0, `--no-audio publish should succeed:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Voice sample \(/, '--no-audio must skip sample generation like every other kind of narration');
  assert.ok(!existsSync(join(root, 'local-content', 'samples')), 'no samples directory should be created for a --no-audio publish');

  // The narrator CHOICE list (manifest.voices) is unconditional on whether
  // this run did any TTS at all — a --no-audio publish still tells the app
  // which voices the deployment offers, exactly as it did before this
  // feature existed. What must be true, additively, is that no entry has a
  // sampleUrl, because none was ever synthesized.
  const manifest = await readJson(localManifestFile(root));
  assert.ok(manifest.voices?.af_heart, 'the voice choice list itself is unaffected by --no-audio');
  assert.equal(manifest.voices.af_heart.sampleUrl, undefined, '--no-audio must not fabricate a sampleUrl for a sample that was never synthesized');
  assert.equal(manifest.voices.bm_fable.sampleUrl, undefined);
});

/** Same contract as helpers.mjs's runPublish, but with an explicit
 *  kill-on-timeout safety net (real local TTS, so this must fail loudly
 *  rather than hang the suite if the model/ffmpeg misbehaves). */
function runWithTimeout(root, extraArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`publish.mjs did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    runPublish(root, extraArgs).then((res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    }, reject);
  });
}
