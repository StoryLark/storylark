// Concatenates per-block MP3 chunks into one chapter file and shifts each
// block's word timings by the measured (ffprobe) offsets. Chunk durations
// come from ffprobe, not the last word boundary — trailing silence matters.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);

export async function stitchChapter(chunks, blockTimings, workDir, outFile) {
  const timingByBlock = new Map(blockTimings.map((t) => [t.blockId, t.words]));
  const finalBlocks = [];
  const concatEntries = [];
  let cursorMs = 0;

  let silenceFile = null;
  for (const chunk of chunks) {
    if (chunk.silenceMs) {
      if (!silenceFile) {
        silenceFile = join(workDir, 'silence-900.mp3');
        await run('ffmpeg', [
          '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
          '-t', String(chunk.silenceMs / 1000), '-c:a', 'libmp3lame', '-b:a', '96k', silenceFile,
        ]);
      }
      concatEntries.push(silenceFile);
      finalBlocks.push({ blockId: chunk.blockId, startMs: Math.round(cursorMs), words: [] });
      cursorMs += chunk.silenceMs;
      continue;
    }

    const durationMs = await probeDurationMs(chunk.file);
    const words = (timingByBlock.get(chunk.blockId) ?? []).map(([cs, ce, s, e]) => [
      cs,
      ce,
      Math.round(s + cursorMs),
      Math.round(e + cursorMs),
    ]);
    finalBlocks.push({ blockId: chunk.blockId, startMs: Math.round(cursorMs), words });
    concatEntries.push(chunk.file);
    cursorMs += durationMs;
  }

  const listFile = join(workDir, 'concat.txt');
  await writeFile(listFile, concatEntries.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  // All chunks share codec/bitrate/channel settings, so stream copy is safe.
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile]);

  return {
    timings: { schemaVersion: 1, durationMs: Math.round(cursorMs), blocks: finalBlocks },
    durationMs: Math.round(cursorMs),
  };
}

export async function probeDurationMs(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  return Math.round(parseFloat(stdout.trim()) * 1000);
}
