#!/usr/bin/env node
// StoryLark publish pipeline.
//
//   node packages/pipeline/publish.mjs --brand <id> --source <repo path> --parser ./path/to/parser.mjs
//
// The content parser is site-owned and injected with --parser: an ESM module
// whose default (or named `parse`) export is
//   async parse(sourceRepo, previousChapters, siteOrigin)
//     → { books: [{ book, chapters: [chapter] }] }
// so this pipeline stays brand-neutral (TTS → stitch → R2 → manifest → notify).
//
// Flags:
//   --brand <id>                required — selects brands/<id>/brand.json + the content bucket
//   --source <repo path>        required — content source repo
//   --parser <module path>      required — site-owned parser (see contract above)
//   --book <id>                 only publish this book
//   --no-audio                  skip TTS (text-only publish; Web Speech fallback covers listen mode)
//   --local <dir>               mirror the R2 layout into <dir> instead of a remote bucket
//                               (no Cloudflare account needed — serve <dir> at the brand's
//                               contentOrigin, e.g. --local app/dist for same-origin dev)
//   --dry-run                   parse + report, no TTS, no upload
//   --manifest-only             regenerate + upload the manifest without re-publishing chapters
//                               (use after a manifest-schema change, e.g. the UI v2 series metadata)
//
// Voices: the brand's tts.voice picks the provider. Kokoro ids (af_heart,
// bm_fable, …) run the bundled free local model — no account or key needed.
// Azure ids (en-US-…) need AZURE_SPEECH_KEY / AZURE_SPEECH_REGION.
//
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (Azure voices only), ADMIN_KEY (for notify).

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isKokoroVoice } from './tts-kokoro.mjs';
import { stitchChapter } from './stitch.mjs';
import { resolveProvider } from './storage.mjs';
import { contentHash } from './lib/md.mjs';

// The pipeline is site-agnostic: it runs from a site repo's root (cwd), which
// owns brands/, content, and publish state. Nothing resolves relative to this
// package's own location.
const ROOT = process.cwd();
const MONTHLY_CHAR_BUDGET = 450_000; // hard stop below the F0 500K limit

const args = parseArgs(process.argv.slice(2));
const brandId = args.brand;
const USAGE =
  'Usage: node packages/pipeline/publish.mjs --brand <id> --source <path> --parser <module> [--book <id>] [--no-audio] [--local <dir>] [--dry-run] [--storage r2|azure-blob]';
if (!brandId || typeof brandId !== 'string') {
  console.error(USAGE);
  process.exit(1);
}
if (!args.source || typeof args.source !== 'string') {
  console.error('--source <repo path> is required.\n' + USAGE);
  process.exit(1);
}
if (!args.parser || typeof args.parser !== 'string') {
  console.error('--parser <module path> is required (site-owned content parser).\n' + USAGE);
  process.exit(1);
}

const sourceRepo = args.source;
if (args.local) {
  process.env.STORYLARK_LOCAL_R2 = resolve(String(args.local));
  console.log(`Local publish → ${process.env.STORYLARK_LOCAL_R2} (no remote R2).`);
}
const brand = JSON.parse(await readFile(join(ROOT, 'brands', brandId, 'brand.json'), 'utf8'));
const bucket = `${brandId}-content`;
const { putJson, putAudio, putImage } = resolveProvider(args.storage);
const stateFile = join(ROOT, '.storylark', 'state', `${brandId}.json`);
const workRoot = join(ROOT, '.storylark', 'work', brandId);
await mkdir(dirname(stateFile), { recursive: true });
await mkdir(workRoot, { recursive: true });

const state = existsSync(stateFile)
  ? JSON.parse(await readFile(stateFile, 'utf8'))
  : { chapters: {}, libraryVersion: 0, charLedger: {} };

// Narrator voices: brand.tts.voice is the default track (chapter `audio`/
// `timings`); brand.tts.voices lists every voice the library offers — extras
// publish as per-voice tracks the app's Narrator picker switches between.
const PRIMARY_VOICE = brand.tts.voice;
const ALL_VOICES = [...new Set([PRIMARY_VOICE, ...(brand.tts.voices ?? [])])];
const EXTRA_VOICES = ALL_VOICES.filter((v) => v !== PRIMARY_VOICE);

const KOKORO_NAMES = {
  af_heart: 'Heart', af_alloy: 'Alloy', af_aoede: 'Aoede', af_bella: 'Bella', af_jessica: 'Jessica',
  af_kore: 'Kore', af_nicole: 'Nicole', af_nova: 'Nova', af_river: 'River', af_sarah: 'Sarah',
  af_sky: 'Sky', am_adam: 'Adam', am_echo: 'Echo', am_eric: 'Eric', am_fenrir: 'Fenrir',
  am_liam: 'Liam', am_michael: 'Michael', am_onyx: 'Onyx', am_puck: 'Puck', am_santa: 'Santa',
  bf_alice: 'Alice', bf_emma: 'Emma', bf_isabella: 'Isabella', bf_lily: 'Lily',
  bm_daniel: 'Daniel', bm_fable: 'Fable', bm_george: 'George', bm_lewis: 'Lewis',
};
function voiceDisplayName(id) {
  const name = KOKORO_NAMES[id];
  if (!name) return id; // Azure ids etc. — shown as-is
  const accent = id[0] === 'b' ? 'British' : 'American';
  const gender = id[1] === 'f' ? 'female' : 'male';
  return `${name} — ${accent}, ${gender}`;
}

/** Synthesize + stitch one chapter in one voice, working in `dir` (chunks are
 *  per-dir, so each voice gets its own) → { audioFile, timingsFile, durationMs }. */
async function synthesizeVoiceTrack(chapter, voice, dir) {
  await mkdir(dir, { recursive: true });
  const useKokoro = isKokoroVoice(voice);
  const { synthesizeChapter } = useKokoro ? await import('./tts-kokoro.mjs') : await import('./tts.mjs');
  const { chunks, blockTimings } = await synthesizeChapter(chapter, voice, dir, {
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION,
    onProgress: (blockId) => process.stdout.write(`\r  [${voice}] synthesized ${blockId}   `),
  });
  process.stdout.write('\n');
  const audioFile = join(dir, 'audio.mp3');
  const { timings, durationMs } = await stitchChapter(chunks, blockTimings, dir, audioFile);
  const timingsFile = join(dir, 'timings.json');
  await writeFile(timingsFile, JSON.stringify(timings));
  return { audioFile, timingsFile, durationMs };
}

const month = new Date().toISOString().slice(0, 7);
state.charLedger[month] ??= 0;

// ---- 1. Parse ----

// Marketing-site origin where images (/images/...) actually serve — the app
// subdomain doesn't host them. Derived from appOrigin by dropping the `app.`
// label: https://app.example.com → https://example.com.
const siteOrigin = brand.appOrigin.replace('://app.', '://');

const parserMod = await import(pathToFileURL(resolve(args.parser)).href);
const parse = parserMod.parse ?? parserMod.default;
if (typeof parse !== 'function') {
  console.error(`--parser ${args.parser} must export a \`parse\` function (or default export).`);
  process.exit(1);
}
const parsed = await parse(sourceRepo, state.chapters, siteOrigin);
// Accept the canonical shape { books: [{ book, chapters }] } (or a bare array of the same).
let books = Array.isArray(parsed) ? parsed : parsed.books; // [{ book, chapters: [chapter] }]
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
const voiceBackfillNeeded =
  !args['no-audio'] &&
  EXTRA_VOICES.length > 0 &&
  plan.some(
    (p) =>
      !p.changed &&
      state.chapters[p.key]?.audio &&
      EXTRA_VOICES.some((v) => !state.chapters[p.key].voices?.[v])
  );
if (changed.length === 0 && !args['manifest-only'] && !voiceBackfillNeeded) {
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
    const useKokoro = isKokoroVoice(brand.tts.voice);
    if (!useKokoro) {
      // Azure-only guards: subscription env + the F0 monthly character budget.
      // The bundled Kokoro model is local and free — nothing to guard.
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
    }
    console.log(`TTS (${useKokoro ? 'kokoro, local' : 'azure'}): ${key} (${chapter.charLength} chars)…`);
    const { synthesizeChapter } = useKokoro ? await import('./tts-kokoro.mjs') : await import('./tts.mjs');
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
    if (!useKokoro) state.charLedger[month] += charCount;
  }

  // Extra narrator voices — each becomes its own hashed audio+timings track.
  const voiceTracks = {};
  if (audioInfo) {
    for (const voice of EXTRA_VOICES) {
      console.log(`TTS extra voice ${voice}: ${key}…`);
      const t = await synthesizeVoiceTrack(chapter, voice, join(chapterDir, voice));
      voiceTracks[voice] = t;
    }
  }

  // Upload chapter artifacts (hashed, immutable).
  const base = `books/${book.id}`;
  console.log(`Upload: ${key} → r2://${bucket}/${base}/…`);
  await putJson(bucket, `${base}/chapters/${chapter.id}.${hash}.json`, chapterFile);
  if (audioInfo) {
    await putAudio(bucket, `${base}/audio/${chapter.id}.${hash}.mp3`, audioInfo.audioFile);
    await putJson(bucket, `${base}/timings/${chapter.id}.${hash}.json`, audioInfo.timingsFile);
    for (const [voice, t] of Object.entries(voiceTracks)) {
      await putAudio(bucket, `${base}/audio/${chapter.id}.${hash}.${voice}.mp3`, t.audioFile);
      await putJson(bucket, `${base}/timings/${chapter.id}.${hash}.${voice}.json`, t.timingsFile);
    }
  }

  state.chapters[key] = {
    hash,
    blocks: chapter.blocks,
    audio: audioInfo ? { durationMs: audioInfo.durationMs, hash } : (wantAudio ? null : prev?.audio ?? null),
    voices: audioInfo
      ? Object.fromEntries(Object.entries(voiceTracks).map(([v, t]) => [v, { durationMs: t.durationMs }]))
      : prev?.voices ?? undefined,
    publishedAt: prev?.publishedAt ?? new Date().toISOString().slice(0, 10),
  };
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

// ---- Voice backfill: unchanged chapters missing a newly-added voice. ----
if (!args['no-audio'] && !args['dry-run'] && !args['manifest-only'] && EXTRA_VOICES.length > 0) {
  for (const { book, chapter, hash, key, changed } of plan) {
    if (changed) continue; // handled above
    const saved = state.chapters[key];
    if (!saved?.audio) continue; // text-only chapter — nothing to backfill
    const missing = EXTRA_VOICES.filter((v) => !saved.voices?.[v]);
    for (const voice of missing) {
      console.log(`TTS backfill voice ${voice}: ${key}…`);
      const dir = join(workRoot, book.id, chapter.id, voice);
      const t = await synthesizeVoiceTrack({ id: chapter.id, blocks: saved.blocks ?? chapter.blocks }, voice, dir);
      const base = `books/${book.id}`;
      await putAudio(bucket, `${base}/audio/${chapter.id}.${hash}.${voice}.mp3`, t.audioFile);
      await putJson(bucket, `${base}/timings/${chapter.id}.${hash}.${voice}.json`, t.timingsFile);
      saved.voices = { ...(saved.voices ?? {}), [voice]: { durationMs: t.durationMs } };
      await writeFile(stateFile, JSON.stringify(state, null, 2));
    }
  }
}

// ---- Covers ----
//
// Two supported sources, checked in order by coverSourceFor():
//   1. site-repo art — a book's `coverSource` (e.g. frontmatter → public/images/...).
//   2. brand-asset art — brands/<brand>/assets/covers/<bookId>.<ext> shipped with this repo.
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
  // Site-repo art (a book declares its cover path via coverSource).
  if (book.coverSource) {
    return join(sourceRepo, 'public', String(book.coverSource).replace(/^\//, ''));
  }
  // Brand-asset art (covers shipped with this repo under brands/<id>/assets/covers).
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
  // Narrator choices the app's Settings picker offers (id → display name).
  voices:
    EXTRA_VOICES.length > 0
      ? Object.fromEntries(ALL_VOICES.map((v) => [v, voiceDisplayName(v)]))
      : undefined,
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
    timeframe: book.timeframe, // flat libraries: in-world "YYYY-MM" for chronological sort
    chapters: chapters.map((ch) => {
      const saved = state.chapters[`${book.id}/${ch.id}`];
      const hash = saved.hash;
      const hasAudio = !!saved.audio;
      // Per-voice tracks: the primary voice aliases the default audio/timings;
      // extras point at their own hashed files. Omitted entirely pre-voices.
      const publishedVoices = hasAudio ? Object.keys(saved.voices ?? {}) : [];
      const voices =
        publishedVoices.length > 0
          ? {
              [PRIMARY_VOICE]: {
                audio: `books/${book.id}/audio/${ch.id}.${saved.audio.hash}.mp3`,
                timings: `books/${book.id}/timings/${ch.id}.${saved.audio.hash}.json`,
              },
              ...Object.fromEntries(
                publishedVoices.map((v) => [
                  v,
                  {
                    audio: `books/${book.id}/audio/${ch.id}.${saved.audio.hash}.${v}.mp3`,
                    timings: `books/${book.id}/timings/${ch.id}.${saved.audio.hash}.${v}.json`,
                  },
                ])
              ),
            }
          : undefined;
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
        voices,
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

if (args.local) {
  console.log('Local publish — skipped remote push notification.');
} else if (process.env.ADMIN_KEY) {
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
