// Per-block re-narration (AB#7412 — plan §3, "Editing and re-narration"):
//
//   "Re-narrating a whole book because one typo changed is unacceptable. The
//    pipeline already content-hashes chapters; extend that per block, so an
//    edit re-generates only the blocks that actually changed and splices the
//    audio."
//
// What this file guards is the two halves of that sentence:
//
//   1. WHICH BLOCKS — only the blocks whose spoken text changed reach the TTS
//      call, across the cases that matter: an in-place edit, an insertion that
//      renumbers everything after it, a reorder, a deletion, and a revert back
//      to text that was narrated before.
//   2. THE SPLICE — the stitched result is one audio file whose per-block word
//      timings are right for where each block ACTUALLY is now, including reused
//      chunks that moved. That is what keeps word-sync highlighting correct
//      after a partial re-narration, and it is the half a "did we re-synthesize
//      the right blocks" test would miss entirely.
//
// The TTS MODEL is the only thing substituted. `synthesizeChapterIncremental`
// takes the provider call as an injection point, and the fake here honours the
// same contract the real ones do (one chunk file per speakable block, plus
// block-relative word timings) while producing REAL MP3s via ffmpeg, of a
// length derived from the text. So `stitch.mjs`, ffmpeg's concat demuxer and
// ffprobe's duration measurement all run for real, and the timings asserted
// below are measured, not asserted into existence.
//
// Verified separately against the real Kokoro model end to end (see the AB#7412
// commit message); the model is skipped here because a test suite should not
// download 90MB and burn a minute of CPU to prove arithmetic.
//
//   node --import tsx/esm --test packages/worker/test/block-renarration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseBlocks, stabilizeBlockIds } from '../../pipeline/lib/md.mjs';
import { blockAudioKey, describeChapterAudio, planChapterAudio, synthesizeChapterIncremental } from '../../pipeline/lib/block-audio.mjs';
import { stitchChapter } from '../../pipeline/stitch.mjs';

const run = promisify(execFile);

/** ffmpeg is how audio is stitched at all; without it there is nothing to test. */
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then(() => true)
  .catch(() => false);

/**
 * A stand-in for the TTS model that keeps the provider contract exactly.
 *
 * Every call is recorded, which is the point: the assertions below are about
 * WHAT WAS ASKED FOR, not about what came back. Audio is a real sine tone whose
 * length is proportional to the text, so different text is genuinely different
 * audio of a different duration and the stitch has something to measure.
 */
function recordingSynthesizer() {
  const calls = [];
  async function synthesize(chapter, voice, dir, opts) {
    const chunks = [];
    const blockTimings = [];
    let charCount = 0;
    for (const block of chapter.blocks) {
      const text = plain(block);
      if (!text.trim()) {
        if (block.type === 'scene-break') chunks.push({ blockId: block.id, silenceMs: 900 });
        continue;
      }
      calls.push({ blockId: block.id, text, voice });
      charCount += text.length;
      const seconds = Math.max(0.4, text.length / 40);
      const file = join(dir, `chunk-${block.id}.mp3`);
      await run('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds.toFixed(3)}`,
        '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', file,
      ]);
      chunks.push({ blockId: block.id, file });
      // Word timings the way a provider gives them: char offsets into THIS
      // block's text, milliseconds from THIS chunk's own start.
      const words = [];
      const totalMs = seconds * 1000;
      const tokens = [...text.matchAll(/\S+/g)];
      tokens.forEach((tok, i) => {
        const start = Math.round((i / tokens.length) * totalMs);
        const end = Math.round(((i + 1) / tokens.length) * totalMs);
        words.push([tok.index, tok.index + tok[0].length, start, end]);
      });
      blockTimings.push({ blockId: block.id, words });
      opts?.onProgress?.(block.id, text.length);
    }
    return { chunks, blockTimings, charCount };
  }
  return { synthesize, calls, reset: () => (calls.length = 0) };
}

function plain(block) {
  switch (block.type) {
    case 'paragraph':
    case 'display-beat':
    case 'end-marker':
      return block.text;
    case 'message-block':
      return block.messages.map((m) => `${m.speaker}, ${m.time}: ${m.text}`).join(' ');
    default:
      return '';
  }
}

/** A publish: parse, keep block ids stable against the previous run, narrate. */
async function publish(markdown, previousBlocks, ctx) {
  const blocks = stabilizeBlockIds(parseBlocks(markdown), previousBlocks);
  ctx.recorder.reset();
  const result = await synthesizeChapterIncremental({ id: 'ch', blocks }, 'test-voice', ctx.workDir, {
    synthesize: ctx.recorder.synthesize,
  });
  const audioFile = join(ctx.workDir, `audio-${++ctx.n}.mp3`);
  const { timings, durationMs } = await stitchChapter(result.chunks, result.blockTimings, ctx.workDir, audioFile);
  return { blocks, result, timings, durationMs, audioFile, narrated: ctx.recorder.calls.map((c) => c.text) };
}

async function context() {
  const workDir = await mkdtemp(join(tmpdir(), 'storylark-renarrate-'));
  return { workDir, recorder: recordingSynthesizer(), n: 0 };
}

const CHAPTER = [
  'The lamp on the corner had been out for a week.',
  '',
  'Nobody had reported it, because everybody assumed somebody else had.',
  '',
  '---',
  '',
  'On Thursday a woman with a stepladder fixed it herself.',
  '',
  '*End of Lamplight.*',
].join('\n');

test('blockAudioKey is the spoken text, and nothing else', () => {
  const a = { id: 'b001', type: 'paragraph', text: 'The same words.' };
  // Same words, different id and position → same key. This is what makes an
  // insertion cheap: everything after it renumbers and none of it re-narrates.
  assert.equal(blockAudioKey(a), blockAudioKey({ ...a, id: 'b099' }));
  // Different words → different key, even under the same id.
  assert.notEqual(blockAudioKey(a), blockAudioKey({ ...a, text: 'Different words.' }));
  // Type is part of it: the same sentence as a display beat is read differently
  // from the same sentence as prose, so it is not the same audio.
  assert.notEqual(blockAudioKey(a), blockAudioKey({ ...a, type: 'display-beat' }));
  // Images are never narrated, so every image collapses to the same empty key.
  assert.equal(
    blockAudioKey({ id: 'b1', type: 'image', src: '/a.png', alt: 'A' }),
    blockAudioKey({ id: 'b2', type: 'image', src: '/b.png', alt: 'B' })
  );
});

test('planChapterAudio counts what an EMPTY cache would cost, and says so plainly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-plan-'));
  const blocks = parseBlocks(CHAPTER);
  const plan = planChapterAudio(blocks, dir, {});
  assert.equal(plan.speakable, 4, 'three paragraphs plus the end marker; the scene break is silence');
  assert.equal(plan.resynthesized, 4);
  assert.equal(plan.reused, 0);
  assert.ok(plan.charCount > 0);
  assert.match(describeChapterAudio(plan), /4 of 4 blocks need narration/);
  // The scene break is still in the item list — it becomes a beat of silence in
  // the stitched audio, it just costs no synthesis.
  assert.equal(plan.items.filter((i) => i.kind === 'silence').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('an in-place edit re-narrates ONE block and reuses the rest', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  assert.equal(first.result.resynthesized, 4, 'nothing cached yet');
  assert.equal(first.result.reused, 0);

  const edited = CHAPTER.replace('somebody else had.', 'somebody else already had.');
  const second = await publish(edited, first.blocks, ctx);

  assert.equal(second.result.resynthesized, 1, 'only the edited paragraph');
  assert.equal(second.result.reused, 3);
  assert.deepEqual(second.narrated, ['Nobody had reported it, because everybody assumed somebody else already had.']);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('inserting a paragraph at the top costs one block, not the chapter', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  // The case that decides whether this feature is worth having. Every block id
  // after the insertion shifts, so a cache keyed on block id would re-narrate
  // the whole chapter; keying on the spoken text does not.
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  const withInsert = `It rained all that October.\n\n${CHAPTER}`;
  const second = await publish(withInsert, first.blocks, ctx);

  assert.equal(second.result.resynthesized, 1);
  assert.equal(second.result.reused, 4);
  assert.deepEqual(second.narrated, ['It rained all that October.']);
  // And the ids really did move, which is what makes the assertion above mean
  // something rather than being trivially true.
  assert.notDeepEqual(
    second.blocks.map((b) => b.id),
    first.blocks.map((b) => b.id)
  );
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('reordering paragraphs re-narrates nothing at all', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  const lines = CHAPTER.split('\n\n');
  const swapped = [lines[1], lines[0], ...lines.slice(2)].join('\n\n');
  const second = await publish(swapped, first.blocks, ctx);

  assert.equal(second.result.resynthesized, 0, 'the same words in a different order are the same audio');
  assert.equal(second.result.reused, 4);
  assert.deepEqual(second.narrated, []);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('reverting to previously narrated text costs nothing', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  // Plan §3: "a revert makes the audio stale". It does — but the audio it needs
  // is audio this cache already holds, so catching up is free.
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  const edited = CHAPTER.replace('somebody else had.', 'somebody else already had.');
  const second = await publish(edited, first.blocks, ctx);
  const reverted = await publish(CHAPTER, second.blocks, ctx);

  assert.equal(reverted.result.resynthesized, 0);
  assert.equal(reverted.result.reused, 4);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('the splice is correct: reused blocks get timings for where they now are', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  // Lengthen the FIRST paragraph, so everything after it must shift later.
  const edited = CHAPTER.replace(
    'The lamp on the corner had been out for a week.',
    'The lamp on the corner had been out for a week, and then for a second week, and then for most of a third.'
  );
  const second = await publish(edited, first.blocks, ctx);
  assert.equal(second.result.resynthesized, 1);

  const before = new Map(first.timings.blocks.map((b) => [b.blockId, b]));
  const after = new Map(second.timings.blocks.map((b) => [b.blockId, b]));

  // The reused blocks are the last three (ids are stable across this edit).
  const reusedIds = second.blocks.slice(1).map((b) => b.id);
  const shift = after.get(reusedIds[0]).startMs - before.get(reusedIds[0]).startMs;
  assert.ok(shift > 0, 'a longer opening paragraph must push everything later');

  for (const id of reusedIds) {
    const b = before.get(id);
    const a = after.get(id);
    assert.equal(a.startMs, b.startMs + shift, `${id} did not shift by the measured amount`);
    assert.equal(a.words.length, b.words.length, `${id} lost or gained words it never re-narrated`);
    for (let i = 0; i < a.words.length; i++) {
      // Char offsets are into the block's own text and must NOT move; the two
      // millisecond fields must move by exactly the shift. That is the whole
      // contract word-sync highlighting depends on.
      assert.equal(a.words[i][0], b.words[i][0], `${id} word ${i} char start moved`);
      assert.equal(a.words[i][1], b.words[i][1], `${id} word ${i} char end moved`);
      assert.equal(a.words[i][2], b.words[i][2] + shift, `${id} word ${i} start ms wrong after the splice`);
      assert.equal(a.words[i][3], b.words[i][3] + shift, `${id} word ${i} end ms wrong after the splice`);
    }
  }

  // Timings must describe the file that actually exists: the last word cannot
  // end after the audio does.
  const last = second.timings.blocks.flatMap((b) => b.words).reduce((m, w) => Math.max(m, w[3]), 0);
  assert.ok(last <= second.timings.durationMs, `last word ends at ${last}ms, audio is ${second.timings.durationMs}ms`);
  assert.equal(second.timings.durationMs, second.durationMs);

  // Every block in the chapter — including the silent scene break — is in the
  // timings, in order, with no gaps in the sequence.
  assert.deepEqual(
    second.timings.blocks.map((b) => b.blockId),
    second.blocks.filter((b) => b.type !== 'image').map((b) => b.id)
  );
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('--renarrate-all ignores the cache', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  ctx.recorder.reset();
  const forced = await synthesizeChapterIncremental({ id: 'ch', blocks: first.blocks }, 'test-voice', ctx.workDir, {
    synthesize: ctx.recorder.synthesize,
    force: true,
  });
  assert.equal(forced.resynthesized, 4);
  assert.equal(forced.reused, 0);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('the cache degrades to a full re-narration rather than to wrong audio', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  // .storylark/work is a build directory an operator may delete at any time.
  // Losing it must cost narration, never correctness.
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  await rm(join(ctx.workDir, 'blocks'), { recursive: true, force: true });
  const second = await publish(CHAPTER, first.blocks, ctx);
  assert.equal(second.result.resynthesized, 4);
  assert.equal(second.result.reused, 0);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('orphaned chunks linger within a budget, then the oldest are dropped', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const first = await publish(CHAPTER, undefined, ctx);
  const cacheDir = join(ctx.workDir, 'blocks');
  const mp3s = async () => (await readdir(cacheDir)).filter((f) => f.endsWith('.mp3'));
  assert.equal((await mp3s()).length, 4);

  // Deleting two blocks leaves their chunks behind — that is what makes putting
  // them back free — but they are orphans now.
  const shorter = CHAPTER.split('\n\n').slice(0, 3).join('\n\n');
  const second = await publish(shorter, first.blocks, ctx);
  assert.equal(second.result.resynthesized, 0, 'a deletion re-narrates nothing');
  assert.equal((await mp3s()).length, 4, 'orphans are kept for the revert');

  // With no budget at all, they go.
  await synthesizeChapterIncremental({ id: 'ch', blocks: second.blocks }, 'test-voice', ctx.workDir, {
    synthesize: ctx.recorder.synthesize,
    orphanBudget: 0,
  });
  assert.equal((await mp3s()).length, 2, 'chunks for blocks that no longer exist are not kept forever');
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('a block with text and no audio is an error, never a silent gap', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const blocks = parseBlocks(CHAPTER);
  await assert.rejects(
    () =>
      synthesizeChapterIncremental({ id: 'ch', blocks }, 'test-voice', ctx.workDir, {
        // A provider that quietly drops a block — the failure mode that would
        // otherwise publish a chapter whose narration skips a paragraph.
        synthesize: async () => ({ chunks: [], blockTimings: [], charCount: 0 }),
      }),
    /produced no audio for 4 block\(s\)/
  );
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('identical paragraphs are synthesized once and spliced in twice', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  const ctx = await context();
  const repeated = 'He said nothing.\n\nShe waited.\n\nHe said nothing.';
  const out = await publish(repeated, undefined, ctx);
  assert.equal(out.result.resynthesized, 3, 'three blocks need audio…');
  assert.equal(out.result.synthesized, 2, '…but the repeated line is only synthesized once');
  assert.equal(out.narrated.length, 2);
  assert.equal(out.narrated.filter((t) => t === 'He said nothing.').length, 1);
  // …but it is still narrated in both places.
  assert.equal(out.timings.blocks.length, 3);
  assert.ok(out.timings.blocks[2].startMs > out.timings.blocks[1].startMs);
  assert.ok(out.timings.blocks[2].words.length > 0);
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('a chapter with no cache and no changes is byte-identical to the pre-AB#7412 behaviour', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  // The compatibility claim: with an empty cache, this asks the provider for
  // exactly the blocks the old whole-chapter call would have, in order.
  const ctx = await context();
  const blocks = parseBlocks(CHAPTER);
  ctx.recorder.reset();
  await synthesizeChapterIncremental({ id: 'ch', blocks }, 'test-voice', ctx.workDir, { synthesize: ctx.recorder.synthesize });
  assert.deepEqual(
    ctx.recorder.calls.map((c) => c.text),
    blocks.map(plain).filter((t) => t.trim())
  );
  await rm(ctx.workDir, { recursive: true, force: true });
});

test('a half-written chunk from a crashed run is never mistaken for a cache hit', { skip: hasFfmpeg ? false : 'ffmpeg not available' }, async () => {
  // Chunks are staged outside the cache and only moved in once the provider has
  // returned, so a synthesis that dies mid-run leaves nothing behind that a
  // later run would trust. Simulated by a provider that throws.
  const ctx = await context();
  const blocks = parseBlocks(CHAPTER);
  await assert.rejects(() =>
    synthesizeChapterIncremental({ id: 'ch', blocks }, 'test-voice', ctx.workDir, {
      synthesize: async (chapter, voice, dir) => {
        await writeFile(join(dir, 'chunk-half.mp3'), 'not really audio');
        throw new Error('the model fell over');
      },
    })
  );
  const plan = planChapterAudio(blocks, join(ctx.workDir, 'blocks'), {});
  assert.equal(plan.reused, 0, 'nothing from the failed run may count as cached');
  assert.equal(plan.resynthesized, 4);
  await rm(ctx.workDir, { recursive: true, force: true });
});
