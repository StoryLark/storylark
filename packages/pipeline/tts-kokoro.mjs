// Kokoro TTS — the bundled, free, local narrator. Runs the Apache-licensed
// Kokoro-82M model (via kokoro-js/onnxruntime) on the publisher's own machine:
// no account, no key, no per-character billing. Same contract as tts.mjs
// (Azure): per-block MP3 chunks + word timings, so stitch/publish are shared.
//
// Word timings are estimated, not model-reported: the model synthesizes
// sentence-sized chunks whose durations are exact, and each word inside a
// sentence gets a slice of that duration proportional to its length. Accurate
// to well under a sentence — good enough for read-along highlighting until
// real phoneme alignment lands.

import { writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { blockPlainText } from './lib/md.mjs';

const run = promisify(execFile);

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Kokoro voice ids look like af_heart / bm_fable: <accent+gender>_<name>. */
export function isKokoroVoice(voice) {
  return /^[a-z]{2}_[a-z]+$/.test(voice);
}

let ttsPromise = null;
async function loadModel() {
  // Lazy singleton — the ~90 MB model loads once per publish run and only
  // when a Kokoro voice is actually selected.
  if (!ttsPromise) {
    ttsPromise = import('kokoro-js').then(({ KokoroTTS }) =>
      KokoroTTS.from_pretrained(MODEL, { dtype: 'q8' })
    );
  }
  return ttsPromise;
}

/**
 * Synthesizes every speakable block of a chapter to individual MP3 chunks in
 * workDir. Returns per-block word timings (offsets relative to each block's
 * plain text, times relative to each chunk's own start) plus the chunk list —
 * the same shape tts.mjs (Azure) returns.
 */
export async function synthesizeChapter(chapter, voice, workDir, { onProgress } = {}) {
  const tts = await loadModel();
  const { TextSplitterStream } = await import('kokoro-js');
  const chunks = [];
  const blockTimings = [];
  let charCount = 0;

  for (const block of chapter.blocks) {
    const text = blockPlainText(block);
    if (!text.trim()) {
      if (block.type === 'scene-break') chunks.push({ blockId: block.id, silenceMs: 900 });
      continue;
    }
    charCount += text.length;

    const { pcm, sampleRate, words } = await synthesizeBlock(tts, TextSplitterStream, text, voice);
    const file = `${workDir}/chunk-${block.id}.mp3`;
    await encodeMp3(pcm, sampleRate, file, workDir, block.id);
    chunks.push({ blockId: block.id, file });
    blockTimings.push({ blockId: block.id, words });
    onProgress?.(block.id, text.length);
  }

  return { chunks, blockTimings, charCount };
}

/** One block: sentence-streamed synthesis + estimated per-word timings. */
async function synthesizeBlock(tts, TextSplitterStream, text, voice) {
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });
  splitter.push(text);
  splitter.close();

  const pieces = [];
  let sampleRate = 24000;
  let total = 0;
  for await (const { text: sentence, audio } of stream) {
    pieces.push({ sentence, samples: audio.audio });
    sampleRate = audio.sampling_rate;
    total += audio.audio.length;
  }

  const pcm = new Float32Array(total);
  const words = [];
  let offset = 0;
  let cursor = 0; // char cursor into the block text
  let clockMs = 0;
  for (const { sentence, samples } of pieces) {
    pcm.set(samples, offset);
    offset += samples.length;
    const durationMs = (samples.length / sampleRate) * 1000;

    // Locate this sentence in the block text (the splitter preserves it
    // verbatim); fall back to the cursor if normalization ever shifts it.
    let at = text.indexOf(sentence, cursor);
    if (at < 0) at = cursor;
    const end = Math.min(at + sentence.length, text.length);

    // Distribute the sentence's exact duration across its words by length.
    const tokens = [...text.slice(at, end).matchAll(/\S+/g)];
    const weight = tokens.reduce((n, t) => n + t[0].length + 1, 0) || 1;
    let t = clockMs;
    for (const tok of tokens) {
      const ms = ((tok[0].length + 1) / weight) * durationMs;
      words.push([at + tok.index, at + tok.index + tok[0].length, Math.round(t), Math.round(t + ms)]);
      t += ms;
    }
    cursor = end;
    clockMs += durationMs;
  }

  return { pcm, sampleRate, words };
}

/** Float32 PCM → 48 kHz 96 kbps mono MP3, matching the Azure chunk settings
 *  so stitch.mjs can concat-copy chunks and silence beats interchangeably. */
async function encodeMp3(pcm, sampleRate, outFile, workDir, blockId) {
  const wavFile = `${workDir}/chunk-${blockId}.wav`;
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE((Math.max(-1, Math.min(1, pcm[i])) * 32767) | 0, 44 + i * 2);
  }
  await writeFile(wavFile, buf);
  await run('ffmpeg', ['-y', '-i', wavFile, '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', outFile]);
  await unlink(wavFile);
}
