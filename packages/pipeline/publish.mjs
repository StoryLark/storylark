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
//   --pull                      BEFORE parsing, fetch each chapter's source markdown back
//                               from the live deployment (books/<id>/source/<ch>.md, which
//                               publish is what uploads) and write it into the local source
//                               repo. This is how an edit made in the admin portal reaches
//                               the laptop instead of being silently overwritten by the next
//                               publish. One-way and explicit on purpose — deployment → local,
//                               only when asked, never as a side effect.
//   --no-source                 skip uploading the source markdown (text-only artifacts, the
//                               pre-AB#7420 behaviour). The deployment then can't be edited
//                               from its own admin portal.
//   --bucket <name>              override the content bucket/container (default: <brand>-content).
//                               Needed when the same brand folder is deployed more than once with
//                               different resource-naming ids (e.g. testing "storylark" on a second
//                               platform as "storylark-dev") — each target needs its own bucket and
//                               its own publish-state tracking, which this also keys by bucket.
//
// Voices: the brand's tts.voice picks the provider. Kokoro ids (af_heart,
// bm_fable, …) run the bundled free local model — no account or key needed.
// Azure ids (en-US-…) need AZURE_SPEECH_KEY / AZURE_SPEECH_REGION.
//
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (Azure voices only), ADMIN_KEY (for notify).

import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, relative } from 'node:path';
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
  'Usage: node packages/pipeline/publish.mjs --brand <id> --source <path> [--parser <module>] [--book <id>] [--no-audio] [--no-source] [--pull] [--local <dir>] [--dry-run] [--storage r2|azure-blob] [--bucket <name>]';
if (!brandId || typeof brandId !== 'string') {
  console.error(USAGE);
  process.exit(1);
}
if (!args.source || typeof args.source !== 'string') {
  console.error('--source <repo path> is required.\n' + USAGE);
  process.exit(1);
}
if (args.parser !== undefined && typeof args.parser !== 'string') {
  console.error('--parser, if given, must be a module path.\n' + USAGE);
  process.exit(1);
}

const sourceRepo = args.source;
if (args.local) {
  process.env.STORYLARK_LOCAL_R2 = resolve(String(args.local));
  console.log(`Local publish → ${process.env.STORYLARK_LOCAL_R2} (no remote R2).`);
}
// The pipeline needs identity (brands/<id>/brand.json) plus deployment config —
// origins and `tts` — which used to live in the same file and now lives in
// deployment/<id>/deployment.json, overridable by STORYLARK_* env vars so a
// second deployment of the same brand publishes to its own content origin.
// A pre-split brand.json (no contractVersion) still works: its own origins/tts
// are used, so an un-migrated site keeps publishing exactly as before.
const brand = JSON.parse(await readFile(join(ROOT, 'brands', brandId, 'brand.json'), 'utf8'));
const deploymentFile = join(ROOT, 'deployment', brandId, 'deployment.json');
const deployment = existsSync(deploymentFile) ? JSON.parse(await readFile(deploymentFile, 'utf8')) : {};
brand.appOrigin = process.env.STORYLARK_APP_ORIGIN || deployment.appOrigin || brand.appOrigin || '';
brand.contentOrigin = process.env.STORYLARK_CONTENT_ORIGIN || deployment.contentOrigin || brand.contentOrigin || '';
brand.tts = { ...brand.tts, ...deployment.tts };
if (process.env.STORYLARK_TTS_VOICE) brand.tts.voice = process.env.STORYLARK_TTS_VOICE;
if (process.env.STORYLARK_TTS_RATE) brand.tts.rate = process.env.STORYLARK_TTS_RATE;
if (process.env.STORYLARK_TTS_OUTPUT_FORMAT) brand.tts.outputFormat = process.env.STORYLARK_TTS_OUTPUT_FORMAT;
if (process.env.STORYLARK_TTS_VOICES) {
  brand.tts.voices = process.env.STORYLARK_TTS_VOICES.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
if (!brand.tts.voice) {
  console.error(
    `No narrator voice configured. Set tts.voice in ${relative(ROOT, deploymentFile) || deploymentFile} (or STORYLARK_TTS_VOICE).`
  );
  process.exit(1);
}
const bucket = typeof args.bucket === 'string' && args.bucket ? args.bucket : `${brandId}-content`;
const { putJson, putAudio, putImage, putObject, SHORT } = resolveProvider(args.storage);
const stateFile = join(ROOT, '.storylark', 'state', `${bucket}.json`);
const workRoot = join(ROOT, '.storylark', 'work', bucket);
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

// The blessed markdown-folder format (AB#7401) is the default parser — a
// site only needs --parser for a source format markdown-import.mjs doesn't
// cover.
const parserMod = args.parser
  ? await import(pathToFileURL(resolve(args.parser)).href)
  : await import('./lib/markdown-import.mjs');
const parse = parserMod.parse ?? parserMod.default;
if (typeof parse !== 'function') {
  console.error(`--parser ${args.parser} must export a \`parse\` function (or default export).`);
  process.exit(1);
}
// ---- 0. Pull (optional): deployment → local, before anything is parsed ----
//
// Publishing now uploads the source markdown, which makes the DEPLOYMENT the
// place a chapter can be edited (plan §3 / AB#7420). That opens a way to lose
// work: someone fixes a typo in the admin portal, then the next `publish` from
// a laptop parses the laptop's older copy and overwrites it. `--pull` is the
// reconciliation, and it is explicit rather than automatic — a publish that
// silently rewrote the operator's working tree would be worse than the problem.
if (args.pull) await pullSourceFromDeployment();

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

// ---- 4b. Source markdown: the deployment stores what it was built from ----
//
// This is the change that unblocks portal editing (plan §3 / AB#7420). Until
// now publishing was one-way — local markdown in, derived artifacts out — and
// the source never left the operator's machine, so a deployment had no copy of
// what it was built from and there was nothing for a browser to open and fix.
//
// Uploaded for EVERY chapter that has source, not just changed ones, because
// "changed" is measured against the derived content hash: a chapter can be
// byte-identical after parsing while its source file has never been uploaded at
// all (every chapter, the first time this runs). Tracked separately in
// state.sources so repeat publishes upload nothing.
//
// Written with a SHORT TTL, not the immutable one the hashed artifacts get:
// this key is mutable by definition — the admin portal writes to it.
const sourcePaths = {};
if (!args['no-source'] && !args['dry-run']) {
  state.sources ??= {};
  for (const { book, chapters } of books) {
    for (const chapter of chapters) {
      if (typeof chapter.source !== 'string') continue; // custom parser with no markdown to give
      const key = `${book.id}/${chapter.id}`;
      const path = `books/${book.id}/source/${chapter.id}.md`;
      sourcePaths[key] = path;
      const hash = createHash('sha256').update(chapter.source).digest('hex').slice(0, 12);
      if (state.sources[key] === hash) continue;
      const local = join(workRoot, book.id, chapter.id, 'source.md');
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, chapter.source);
      console.log(`Source: ${key} → ${bucket}/${path}`);
      await putObject(bucket, path, local, 'text/markdown; charset=utf-8', SHORT);
      state.sources[key] = hash;
      await writeFile(stateFile, JSON.stringify(state, null, 2));
    }
  }

  // Book metadata as authored, so the portal can edit title/author/description
  // against the same file the CLI reads rather than against the manifest alone.
  for (const { book } of books) {
    const meta = JSON.stringify(
      { title: book.title, author: book.author, description: book.description, order: book.order, coverSource: book.coverSource },
      null,
      2
    );
    const hash = createHash('sha256').update(meta).digest('hex').slice(0, 12);
    state.bookMeta ??= {};
    if (state.bookMeta[book.id] === hash) continue;
    const local = join(workRoot, book.id, 'book.json');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, meta);
    await putJson(bucket, `books/${book.id}/source/book.json`, local, false);
    state.bookMeta[book.id] = hash;
    await writeFile(stateFile, JSON.stringify(state, null, 2));
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

/**
 * Fetch every chapter's source markdown back from the live deployment and write
 * it into the local source repo (`--pull`).
 *
 * Reads the deployment's own manifest over its public content origin — no
 * credential, because the content is public anyway and this direction only ever
 * reads. Chapters are matched to local files by the SAME rule the importer uses
 * to derive a chapter id from a filename (numeric prefix stripped), so
 * `02-the-long-dark.md` is recognised as chapter `the-long-dark` and rewritten
 * in place, keeping its ordering prefix. A chapter that exists on the
 * deployment but has no local file — one created in the portal — lands as
 * `books/<book>/<chapter>.md`, and the operator can rename it to give it an
 * order.
 */
async function pullSourceFromDeployment() {
  if (!brand.contentOrigin) {
    console.error('--pull needs a contentOrigin (deployment/<id>/deployment.json or STORYLARK_CONTENT_ORIGIN).');
    process.exit(1);
  }
  const origin = brand.contentOrigin.replace(/\/+$/, '');
  const res = await fetch(`${origin}/manifest.json`, { cache: 'no-store' });
  if (!res.ok) {
    console.error(`--pull: could not read ${origin}/manifest.json (${res.status}).`);
    process.exit(1);
  }
  const remote = await res.json();
  const booksDir = join(sourceRepo, 'books');
  let pulled = 0;
  let unchanged = 0;

  for (const book of remote.books ?? []) {
    if (args.book && book.id !== args.book) continue;
    const bookDir = join(booksDir, book.id);
    // chapterId → existing local filename, by the importer's own naming rule.
    const local = new Map();
    if (existsSync(bookDir)) {
      for (const file of (await readdir(bookDir)).filter((f) => f.endsWith('.md'))) {
        local.set(file.replace(/\.md$/, '').replace(/^\d+[-_.]?/, '') || file.replace(/\.md$/, ''), join(bookDir, file));
      }
    }
    const singleFile = join(booksDir, `${book.id}.md`);

    for (const ch of book.chapters ?? []) {
      if (!ch.source) continue; // published before source upload existed
      const sourceRes = await fetch(`${origin}/${ch.source}`, { cache: 'no-store' });
      if (!sourceRes.ok) {
        console.warn(`  --pull: ${book.id}/${ch.id} source missing (${sourceRes.status}) — skipped.`);
        continue;
      }
      const text = await sourceRes.text();
      const dest = local.get(ch.id) ?? (existsSync(singleFile) && (book.chapters ?? []).length === 1 ? singleFile : join(bookDir, `${ch.id}.md`));
      const current = existsSync(dest) ? await readFile(dest, 'utf8') : null;
      if (current === text) {
        unchanged++;
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text);
      console.log(`  --pull: ${book.id}/${ch.id} → ${relative(ROOT, dest) || dest}`);
      pulled++;
    }
  }
  console.log(`Pulled ${pulled} chapter source file(s) from ${origin}; ${unchanged} already matched.`);
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

// The library version has to beat whatever is LIVE, not just whatever this
// laptop last wrote (AB#7420). The admin portal bumps the deployed manifest's
// version on every edit, so a machine that has been publishing for a while can
// easily hold a lower number — and a manifest that goes backwards is a manifest
// no reader ever re-fetches, i.e. a publish that silently reaches nobody.
// Best-effort: an unreachable origin (offline, first publish, --local) just
// falls back to local state, which is the pre-existing behaviour.
let liveVersion = 0;
if (!args.local && brand.contentOrigin) {
  try {
    const res = await fetch(`${brand.contentOrigin.replace(/\/+$/, '')}/manifest.json`, { cache: 'no-store' });
    if (res.ok) liveVersion = Number((await res.json()).libraryVersion) || 0;
  } catch {
    // offline or no manifest yet — local state is the only source, as before
  }
}
const newVersion = Math.max(state.libraryVersion ?? 0, liveVersion) + 1;
const manifest = {
  schemaVersion: 1,
  libraryVersion: newVersion,
  // A CLI publish is a publication, not a correction: it announces itself.
  // The portal's correction path is what holds this back (see
  // packages/worker/src/lib/content.ts) — the app's "new content" badge reads
  // this, while libraryVersion above only governs re-fetching.
  announceVersion: newVersion,
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
        // The editable source, when this publish uploaded one. Its presence is
        // what tells the admin portal a chapter can be round-tripped as
        // markdown — checked from the manifest so a library of two hundred
        // short stories costs one read, not two hundred.
        source: sourcePaths[`${book.id}/${ch.id}`],
        // Narration that no longer matches the words, stated rather than left
        // to be discovered. Derived, not asserted: audio is stale exactly when
        // a chapter has audio whose hash isn't the current content hash — which
        // covers a --no-audio publish of changed text as well as a portal edit
        // this run has just re-narrated (and therefore cleared).
        audioStale: hasAudio ? saved.audio.hash !== hash : false,
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
