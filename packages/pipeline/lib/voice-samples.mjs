// Per-voice preview samples for the Settings Narrator picker (AB#7389).
//
// During publish, when a brand publishes more than one narrator voice, this
// ensures a short sample clip exists per voice at samples/<voiceId>.mp3 under
// the published content root, synthesized with the SAME driver (Kokoro or
// Azure) chapters use, from one fixed sentence built from the brand's own
// content nouns (hard rule 5 — never hardcode "story"/"book"). State-driven,
// like a chapter's per-block narration cache (lib/block-audio.mjs): a voice
// whose sample sentence is unchanged since the last publish is skipped, not
// re-synthesized.
//
// `synthesize` is the single injection point for the real TTS call — the
// same idea block-audio.mjs's synthesizeChapterIncremental() already uses
// for chapters (its own `options.synthesize`). publish.mjs leaves it unset,
// which resolves the real Kokoro/Azure driver by voice id (defaultSynthesize
// below); the pipeline's test harness passes a fake one, because no test in
// this suite has ever spawned the real Kokoro model — every existing
// CLI-spawn test publishes with --no-audio — and the per-voice binaries
// Kokoro needs are a separate, multi-megabyte download this harness has no
// business making just to prove a cache-skip rule.

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isKokoroVoice } from '../tts-kokoro.mjs';

const FALLBACK_SENTENCE = "Hi! I'm one of the voices that can read to you.";

/**
 * The one fixed preview sentence, built from the brand's own unit noun (hard
 * rule 5 — never hardcode "story"/"book"). Falls back for a brand with no
 * presentation nouns (a pre-presentation-file brand, or one whose `nouns`
 * never set `unit`).
 */
export function sampleSentence(nouns) {
  const unit = typeof nouns?.unit === 'string' ? nouns.unit.trim() : '';
  return unit ? `Hi! I'm one of the voices that can read your ${unit} to you.` : FALLBACK_SENTENCE;
}

/**
 * Real synthesis: one throwaway single-block "chapter" run through the same
 * Kokoro/Azure driver chapters use (chosen the same way publish.mjs has
 * always chosen it, by voice id), copied straight to outFile. No stitch is
 * needed for a single block and no word timings are needed for a preview
 * clip — it is just played end to end.
 */
async function defaultSynthesize(voice, sentence, outFile, workDir) {
  const useKokoro = isKokoroVoice(voice);
  const driver = useKokoro ? await import('../tts-kokoro.mjs') : await import('../tts.mjs');
  const fakeChapter = { id: 'sample', blocks: [{ id: 'sample', type: 'paragraph', text: sentence }] };
  const { chunks } = await driver.synthesizeChapter(
    fakeChapter,
    voice,
    workDir,
    useKokoro ? {} : { key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION }
  );
  const chunk = chunks.find((c) => c.file);
  if (!chunk) throw new Error(`TTS produced no audio for the "${voice}" preview sample.`);
  await copyFile(chunk.file, outFile);
}

/**
 * Ensure every voice in `voices` has a sample at samples/<voiceId>.mp3 under
 * the content root. Synthesizes only what's missing or whose sentence
 * changed since the last publish — keyed by a hash of the sentence itself,
 * the same content-addressed idea block-audio.mjs uses for chapter blocks —
 * and skips everything else, exactly like a chapter's unchanged blocks.
 *
 * @param {object} opts
 * @param {string[]} opts.voices - every voice id to ensure a sample for.
 * @param {string} opts.sentence - the fixed preview sentence (see sampleSentence()).
 * @param {string} opts.workDir - scratch directory for the synthesized files.
 * @param {object} opts.state - the publish ledger; opts.state.samples is read/written
 *   (voice id → hash of the sentence it was last synthesized against). The
 *   caller is responsible for persisting `state` to disk — this function only
 *   mutates the in-memory object, the same contract publish.mjs's own
 *   per-chapter loop follows for `state.chapters`.
 * @param {(localFile: string, path: string) => Promise<void>} opts.upload -
 *   uploads the synthesized file to `samples/<voiceId>.mp3` (r2/local/azure —
 *   whatever resolveProvider() gave the caller).
 * @param {(voice: string, sentence: string, outFile: string, workDir: string) => Promise<void>} [opts.synthesize] -
 *   overrides the real Kokoro/Azure synthesis (test seam; see file header).
 * @returns {Promise<Record<string,string>>} voice id → sampleUrl (a relative
 *   path), for every voice that has (or now has) a sample.
 */
export async function ensureVoiceSamples({ voices, sentence, workDir, state, upload, synthesize = defaultSynthesize, onProgress }) {
  state.samples ??= {};
  const sentenceHash = createHash('sha256').update(sentence).digest('hex').slice(0, 12);
  const result = {};
  await mkdir(workDir, { recursive: true });
  for (const voice of voices) {
    const path = `samples/${voice}.mp3`;
    if (state.samples[voice] === sentenceHash) {
      result[voice] = path; // unchanged — already published, nothing to do
      continue;
    }
    onProgress?.(voice);
    const outFile = join(workDir, `${voice}.mp3`);
    await synthesize(voice, sentence, outFile, workDir);
    await upload(outFile, path);
    state.samples[voice] = sentenceHash;
    result[voice] = path;
  }
  return result;
}
