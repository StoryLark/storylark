// Azure Speech TTS, one request per block, collecting WordBoundary events.
// F0 constraints honored here: real-time SDK only (batch API is S0-only),
// 20 requests/minute (3.1 s spacing), 10-minute max audio per request
// (single paragraphs are far below that).

import sdk from 'microsoft-cognitiveservices-speech-sdk';
import { writeFile } from 'node:fs/promises';
import { blockPlainText } from './lib/md.mjs';

const REQUEST_SPACING_MS = 3100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Synthesizes every speakable block of a chapter to individual MP3 chunks in
 * workDir. Returns per-block word timings (offsets relative to each block's
 * plain text, times relative to each chunk's own start) plus the chunk list.
 */
export async function synthesizeChapter(chapter, voice, workDir, { key, region, onProgress }) {
  const chunks = [];
  const blockTimings = [];
  let charCount = 0;

  for (const block of chapter.blocks) {
    const text = blockPlainText(block);
    if (!text.trim()) {
      // Scene breaks become a beat of silence, stitched in later.
      if (block.type === 'scene-break') chunks.push({ blockId: block.id, silenceMs: 900 });
      continue;
    }
    charCount += text.length;

    const file = `${workDir}/chunk-${block.id}.mp3`;
    const { audio, words } = await synthesizeBlockWithRetry(text, voice, { key, region });
    await writeFile(file, Buffer.from(audio));
    chunks.push({ blockId: block.id, file });
    blockTimings.push({ blockId: block.id, words });
    onProgress?.(block.id, text.length);
    await sleep(REQUEST_SPACING_MS);
  }

  return { chunks, blockTimings, charCount };
}

// Premium models (Dragon HD / Omni) enforce tighter concurrency and return a
// transient "ResourceExhausted" (websocket 1013) or drop the socket under load.
// Retry those with exponential backoff so one throttle doesn't abort a publish.
const TRANSIENT_RE = /ResourceExhausted|1013|1006|1011|websocket error|timeout|ServiceUnavailable|Throttl|429/i;

async function synthesizeBlockWithRetry(text, voice, cfg, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await synthesizeBlock(text, voice, cfg);
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? String(e);
      if (i === attempts - 1 || !TRANSIENT_RE.test(msg)) throw e;
      const backoffMs = 3000 * 2 ** i; // 3s, 6s, 12s, 24s
      process.stdout.write(`\n  transient TTS error (${msg.slice(0, 60)}…) — retry ${i + 1}/${attempts - 1} in ${backoffMs / 1000}s\n`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

function synthesizeBlock(text, voice, { key, region }) {
  return new Promise((resolve, reject) => {
    const config = sdk.SpeechConfig.fromSubscription(key, region);
    config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz96KBitRateMonoMp3;
    const synthesizer = new sdk.SpeechSynthesizer(config, null);

    const words = [];
    const ssmlPrefix = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">`;
    const escaped = escapeXml(text);
    const ssml = `${ssmlPrefix}${escaped}</voice></speak>`;

    synthesizer.wordBoundary = (_s, e) => {
      // e.textOffset is relative to the SSML document; subtract the prefix.
      // Escaped entities shift offsets, so map back through the escape table.
      const ssmlOffset = e.textOffset - ssmlPrefix.length;
      const charStart = unescapedOffset(escaped, ssmlOffset);
      const charEnd = charStart + e.wordLength;
      const startMs = e.audioOffset / 10000; // 100ns ticks → ms
      const endMs = startMs + e.duration / 10000;
      if (charStart >= 0 && charStart < text.length) {
        words.push([charStart, Math.min(charEnd, text.length), Math.round(startMs), Math.round(endMs)]);
      }
    };

    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve({ audio: result.audioData, words });
        } else {
          reject(new Error(`TTS failed: ${result.reason} ${result.errorDetails ?? ''}`));
        }
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Maps an offset within the escaped string back to the raw-text offset. */
function unescapedOffset(escaped, offset) {
  let raw = 0;
  let i = 0;
  while (i < offset && i < escaped.length) {
    if (escaped[i] === '&') {
      const semi = escaped.indexOf(';', i);
      i = semi > 0 ? semi + 1 : i + 1;
    } else {
      i++;
    }
    raw++;
  }
  return raw;
}
