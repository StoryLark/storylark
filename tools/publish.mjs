#!/usr/bin/env node
// StoryReader publish pipeline.
//
//   node tools/publish.mjs --brand holdfast --source D:/git/holdfast-press/holdfast-press.github.io
//   node tools/publish.mjs --brand gunner   --source D:/git/gunnerthelab/gunnerthelab.github.io --no-audio
//
// Flags:
//   --brand <holdfast|gunner>   required
//   --source <repo path>        content source repo (defaults per brand)
//   --book <id>                 only publish this book
//   --no-audio                  skip TTS (text-only publish; Web Speech fallback covers listen mode)
//   --dry-run                   parse + report, no TTS, no upload
//   --manifest-only             regenerate + upload the manifest without re-publishing chapters
//                               (use after a manifest-schema change, e.g. the UI v2 series metadata)
//
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (for audio), ADMIN_KEY (for notify).

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHoldfast } from './parse/holdfast.mjs';
import { parseGunner } from './parse/gunner.mjs';
import { synthesizeChapter } from './tts.mjs';
import { stitchChapter } from './stitch.mjs';
import { putJson, putAudio, putImage } from './r2-upload.mjs';
import { contentHash } from './lib/md.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MONTHLY_CHAR_BUDGET = 450_000; // hard stop below the F0 500K limit

const args = parseArgs(process.argv.slice(2));
const brandId = args.brand;
if (brandId !== 'holdfast' && brandId !== 'gunner') {
  console.error('Usage: node tools/publish.mjs --brand <holdfast|gunner> [--source <path>] [--book <id>] [--no-audio] [--dry-run]');
  process.exit(1);
}

const DEFAULT_SOURCES = {
  holdfast: 'D:/git/holdfast-press/holdfast-press.github.io',
  gunner: 'D:/git/gunnerthelab/gunnerthelab.github.io',
};
const sourceRepo = args.source ?? DEFAULT_SOURCES[brandId];
const brand = JSON.parse(await readFile(join(ROOT, 'brands', brandId, 'brand.json'), 'utf8'));
const bucket = `storyreader-${brandId}-content`;
const stateFile = join(ROOT, 'tools', '.state', `${brandId}.json`);
const workRoot = join(ROOT, 'tools', '.work', brandId);
await mkdir(dirname(stateFile), { recursive: true });
await mkdir(workRoot, { recursive: true });

const state = existsSync(stateFile)
  ? JSON.parse(await readFile(stateFile, 'utf8'))
  : { chapters: {}, libraryVersion: 0, charLedger: {} };

const month = new Date().toISOString().slice(0, 7);
state.charLedger[month] ??= 0;

// ---- 1. Parse ----

// Marketing-site origin where images (/images/...) actually serve — the app
// subdomain doesn't host them. Derived from appOrigin by dropping the `app.`
// label: https://app.holdfastpress.com → https://holdfastpress.com.
const siteOrigin = brand.appOrigin.replace('://app.', '://');

let books; // [{ book, chapters: [chapter] }]
if (brandId === 'holdfast') {
  const { book, chapters } = await parseHoldfast(sourceRepo, state.chapters, siteOrigin);
  books = [{ book, chapters }];
} else {
  const stories = await parseGunner(sourceRepo, state.chapters, siteOrigin);
  books = stories.map(({ book, chapter }) => ({ book, chapters: [chapter] }));
}
if (args.book) books = books.filter((b) => b.book.id === args.book);

const plan = [];
for (const { book, chapters } of books) {
  for (const chapter of chapters) {
    const hash = contentHash({ blocks: chapter.blocks, title: chapter.title });
    const key = `${book.id}/${chapter.id}`;
    const prev = state.chapters[key];
    const changed = prev?.hash !== hash;
    plan.push({ book, chapter, hash, key, changed, prev });
  }
}

const changed = plan.filter((p) => p.changed);
console.log(`Parsed ${plan.length} chapter(s); ${changed.length} changed since last publish.`);
if (args['dry-run']) {
  for (const p of plan) {
    console.log(`  ${p.changed ? 'CHANGED ' : 'unchanged'} ${p.key} — ${p.chapter.blocks.length} blocks, ${p.chapter.wordCount} words, hash ${p.hash}`);
  }
  process.exit(0);
}
if (changed.length === 0 && !args['manifest-only']) {
  console.log('Nothing to publish. (Use --manifest-only to re-upload the manifest after a schema change.)');
  process.exit(0);
}

if (args['manifest-only']) {
  const missing = plan.filter((p) => !state.chapters[p.key]);
  if (missing.length > 0) {
    console.error(`--manifest-only requires all chapters previously published; missing: ${missing.map((p) => p.key).join(', ')}`);
    process.exit(1);
  }
}

// ---- 2/3/4. Per-chapter: chapter JSON (+ TTS + stitch) + upload ----

for (const item of args['manifest-only'] ? [] : changed) {
  const { book, chapter, hash, key, prev } = item;
  const chapterDir = join(workRoot, book.id, chapter.id);
  await mkdir(chapterDir, { recursive: true });

  const chapterJson = {
    id: chapter.id,
    bookId: book.id,
    title: chapter.title,
    label: chapter.label,
    blocks: chapter.blocks,
    charLength: chapter.charLength,
  };
  const chapterFile = join(chapterDir, `content.json`);
  await writeFile(chapterFile, JSON.stringify(chapterJson));

  let audioInfo = null;
  const wantAudio = !args['no-audio'];
  if (wantAudio) {
    if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
      console.error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set — rerun with --no-audio for a text-only publish.');
      process.exit(1);
    }
    if (state.charLedger[month] + chapter.charLength > MONTHLY_CHAR_BUDGET) {
      console.error(
        `Char budget: ${state.charLedger[month]} used + ${chapter.charLength} would exceed ${MONTHLY_CHAR_BUDGET} this month. ` +
          `Skipping audio for ${key} — publish text-only with --no-audio, or wait for next month.`
      );
      process.exit(1);
    }
    console.log(`TTS: ${key} (${chapter.charLength} chars, ~${Math.ceil((chapter.blocks.length * 3.1) / 60)} min at F0 pace)…`);
    const { chunks, blockTimings, charCount } = await synthesizeChapter(chapter, brand.tts.voice, chapterDir, {
      key: process.env.AZURE_SPEECH_KEY,
      region: process.env.AZURE_SPEECH_REGION,
      onProgress: (blockId) => process.stdout.write(`\r  synthesized ${blockId}   `),
    });
    process.stdout.write('\n');
    const audioFile = join(chapterDir, 'audio.mp3');
    const { timings, durationMs } = await stitchChapter(chunks, blockTimings, chapterDir, audioFile);
    const timingsFile = join(chapterDir, 'timings.json');
    await writeFile(timingsFile, JSON.stringify(timings));
    audioInfo = { audioFile, timingsFile, durationMs };
    state.charLedger[month] += charCount;
  }

  // Upload chapter artifacts (hashed, immutable).
  const base = `books/${book.id}`;
  console.log(`Upload: ${key} → r2://${bucket}/${base}/…`);
  await putJson(bucket, `${base}/chapters/${chapter.id}.${hash}.json`, chapterFile);
  if (audioInfo) {
    await putAudio(bucket, `${base}/audio/${chapter.id}.${hash}.mp3`, audioInfo.audioFile);
    await putJson(bucket, `${base}/timings/${chapter.id}.${hash}.json`, audioInfo.timingsFile);
  }

  state.chapters[key] = {
    hash,
    blocks: chapter.blocks,
    audio: audioInfo ? { durationMs: audioInfo.durationMs, hash } : (wantAudio ? null : prev?.audio ?? null),
    publishedAt: prev?.publishedAt ?? new Date().toISOString().slice(0, 10),
  };
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

// ---- Covers ----
//
// gunner: per-story art from the site repo (frontmatter coverImage → public/images/...).
// holdfast: per-book art shipped with this repo at brands/<brand>/assets/covers/<bookId>.<ext>.
// Covers upload under a content-hashed key (safe with immutable caching) and
// re-upload automatically when the art changes. Books without art carry no
// `cover` field — the apps fall back to the brand icon.

for (const { book } of books) {
  const src = coverSourceFor(book);
  if (!src || !existsSync(src)) continue;
  const coverHash = createHash('sha256').update(await readFile(src)).digest('hex').slice(0, 12);
  const ext = src.split('.').pop().toLowerCase();
  const keyPath = `books/${book.id}/covers/cover.${coverHash}.${ext}`;
  state.covers ??= {};
  if (state.covers[book.id] !== keyPath) {
    const local = join(workRoot, book.id, `cover.${coverHash}.${ext}`);
    await mkdir(dirname(local), { recursive: true });
    await cp(src, local);
    console.log(`Cover: ${book.id} → r2://${bucket}/${keyPath}`);
    await putImage(bucket, keyPath, local);
    state.covers[book.id] = keyPath;
    await writeFile(stateFile, JSON.stringify(state, null, 2));
  }
  book.cover = keyPath;
}

/** Where a book's cover art lives on disk, or null if it has none. */
function coverSourceFor(book) {
  // Site-repo art (gunner stories declare coverImage in frontmatter).
  if (book.coverSource) {
    return join(sourceRepo, 'public', String(book.coverSource).replace(/^\//, ''));
  }
  // Brand-asset art (holdfast book covers live with the app).
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const p = join(ROOT, 'brands', brandId, 'assets', 'covers', `${book.id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- 5. Manifest (uploaded last) ----

const newVersion = (state.libraryVersion ?? 0) + 1;
const manifest = {
  schemaVersion: 1,
  libraryVersion: newVersion,
  generatedAt: new Date().toISOString(),
  books: books.map(({ book, chapters }) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    cover: book.cover,
    group: book.group,
    // UI v2 additive fields (optional — apps handle their absence):
    series: book.series,
    seriesOrder: book.seriesOrder,
    bookOrder: book.order,
    description: book.description,
    publishDate: book.publishDate,
    timeframe: book.timeframe, // gunner: in-world "YYYY-MM" for chronological sort
    chapters: chapters.map((ch) => {
      const saved = state.chapters[`${book.id}/${ch.id}`];
      const hash = saved.hash;
      const hasAudio = !!saved.audio;
      return {
        id: ch.id,
        title: ch.title,
        label: ch.label,
        setting: ch.setting,
        wordCount: ch.wordCount,
        readingTime: ch.readingTime,
        audioDurationMs: saved.audio?.durationMs ?? 0,
        contentHash: hash,
        content: `books/${book.id}/chapters/${ch.id}.${hash}.json`,
        audio: hasAudio ? `books/${book.id}/audio/${ch.id}.${saved.audio.hash}.mp3` : undefined,
        timings: hasAudio ? `books/${book.id}/timings/${ch.id}.${saved.audio.hash}.json` : undefined,
        hasAudio,
        publishedAt: saved.publishedAt,
      };
    }),
  })),
};

const manifestFile = join(workRoot, 'manifest.json');
await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
await putJson(bucket, 'manifest.json', manifestFile, false);
state.libraryVersion = newVersion;
await writeFile(stateFile, JSON.stringify(state, null, 2));
console.log(`Manifest v${newVersion} uploaded.`);

// ---- 6. Notify ----

if (process.env.ADMIN_KEY) {
  const res = await fetch(`${brand.appOrigin}/api/admin/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_KEY },
    body: JSON.stringify({ version: newVersion }),
  });
  console.log(res.ok ? `Push notifications fired (${(await res.json()).subscriptions} subscription(s)).` : `Notify failed: ${res.status}`);
} else {
  console.log('ADMIN_KEY not set — skipped push notification.');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}
