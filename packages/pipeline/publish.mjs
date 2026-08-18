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
//   --renarrate-all             ignore the per-block narration cache and re-synthesize every
//                               block (AB#7412 — plan §3). Normally a republish re-narrates
//                               ONLY the blocks whose spoken text changed and splices the rest
//                               of the audio back in unchanged, which is what makes fixing a
//                               typo affordable. Use this after changing voice settings, or if
//                               you suspect a cached chunk is bad.
//   --no-source                 skip uploading the source markdown (text-only artifacts, the
//                               pre-AB#7420 behaviour). The deployment then can't be edited
//                               from its own admin portal.
//   --force                     publish even when the deployment holds content this working
//                               tree doesn't know about (AB#7412). Without it, a publish that
//                               would overwrite an admin-portal edit — or delete a chapter
//                               written there — REFUSES and exits 2, naming each conflict.
//                               `--pull` is the other way out, and the one that keeps both.
//   --origin <portal|cli|sync>  what to record as this content's ORIGIN in the manifest
//                               (AB#7422 — plan §8). Default: whatever the live manifest
//                               already says, falling back to `cli`. Set to `sync` by
//                               packages/pipeline/sync.mjs, which is the only thing that
//                               should ever set it — synced content is read-only in the
//                               admin portal, and mislabelling an operator's own markdown
//                               as synced would lock them out of their own library.
//   --sync-kind <git|feed>      recorded alongside --origin sync: which connector produced
//   --sync-url <url>            this book, and where its real source of truth lives, so the
//   --sync-ref <ref>            portal can say "edit at source" with a link instead of a
//   --sync-path <path>          shrug. Never a credential — the manifest is public.
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
import { describeChapterAudio, planChapterAudio, synthesizeChapterIncremental } from './lib/block-audio.mjs';
import { reconstructPreviousFromLive, findLiveChapterEntry } from './lib/publish-core.mjs';
import { sampleSentence, ensureVoiceSamples } from './lib/voice-samples.mjs';

// The pipeline is site-agnostic: it runs from a site repo's root (cwd), which
// owns brands/, content, and publish state. Nothing resolves relative to this
// package's own location.
async function main() {
  const ROOT = process.cwd();
  const MONTHLY_CHAR_BUDGET = 450_000; // hard stop below the F0 500K limit

  const args = parseArgs(process.argv.slice(2));
  const brandId = args.brand;
  const USAGE =
    'Usage: node packages/pipeline/publish.mjs --brand <id> --source <path> [--parser <module>] [--book <id>] [--no-audio] [--no-source] [--pull] [--force] [--renarrate-all] [--local <dir>] [--dry-run] [--storage r2|azure-blob] [--bucket <name>]';
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
  // Content origin (AB#7422 — plan §8). Validated here rather than trusted: an
  // invented value would be written into the manifest and read back by the portal
  // as an unknown origin, which defaults to "editable" — safe, but silently not
  // what was asked for. Better to say so now.
  const ORIGINS = ['portal', 'cli', 'sync'];
  const declaredOrigin = args.origin === undefined ? undefined : String(args.origin);
  if (declaredOrigin !== undefined && !ORIGINS.includes(declaredOrigin)) {
    console.error(`--origin must be one of ${ORIGINS.join(', ')} (got "${declaredOrigin}").`);
    process.exit(1);
  }
  // `personal` is deliberately not accepted: it is the seam for a reader's own
  // device-local imports (plan §5 / AB#7426), which by definition never reach a
  // deployment, so nothing published from here can legitimately claim it.
  const syncSource =
    declaredOrigin === 'sync'
      ? {
          kind: args['sync-kind'] === 'feed' ? 'feed' : 'git',
          url: typeof args['sync-url'] === 'string' ? args['sync-url'] : '',
          ref: typeof args['sync-ref'] === 'string' ? args['sync-ref'] : undefined,
          path: typeof args['sync-path'] === 'string' ? args['sync-path'] : undefined,
          syncedAt: new Date().toISOString(),
        }
      : undefined;
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
   *  per-dir, so each voice gets its own) → { audioFile, timingsFile, durationMs }.
   *
   *  Per-block incremental like the primary track (AB#7412): each voice keeps its
   *  own block cache under its own directory, because the same words in a
   *  different voice are different audio. */
  async function synthesizeVoiceTrack(chapter, voice, dir) {
    await mkdir(dir, { recursive: true });
    const { chunks, blockTimings, reused, resynthesized } = await synthesizeChapterIncremental(chapter, voice, dir, {
      force: args['renarrate-all'] === true,
      key: process.env.AZURE_SPEECH_KEY,
      region: process.env.AZURE_SPEECH_REGION,
      onProgress: (blockId) => process.stdout.write(`\r  [${voice}] synthesized ${blockId}   `),
    });
    process.stdout.write('\n');
    if (reused > 0) console.log(`  [${voice}] re-narrated ${resynthesized} block(s), reused ${reused}.`);
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

  // Read here, before a single object is uploaded and before parsing, rather
  // than at manifest time where it used to be read — a check that runs after
  // the chapter JSON has already been overwritten is not a check. Reading it
  // before parse() is also what makes stateless-baseline reconstruction
  // possible (AB#7654): the previous-blocks the parser needs for a chapter this
  // machine has no local state for come from THIS read.
  const liveManifest = await readLiveManifest();

  // ---- Stateless baseline reconstruction (AB#7654) ----
  //
  // `state.chapters` is this machine's OWN ledger and is empty on a fresh
  // runner. Without a fallback, every chapter looks "changed" (nothing to
  // compare its hash against) and detectConflicts() flags every already-live
  // chapter as a conflict with base "(never published from this machine)" —
  // even when the live text is byte-identical, because stabilizeBlockIds()
  // (md.mjs) inherits block ids across edits, so a live chapter's ids are
  // history-dependent while a fresh parse with no previous produces sequential
  // `b001..`, which hashes differently even for identical prose.
  //
  // The fix: for any book/chapter this run's local state doesn't know about,
  // fetch the LIVE chapter content (same origin the manifest came from) and use
  // its blocks as the `previousBlocks` the parser stabilizes ids against, and
  // its contentHash as the changed/conflict-base "prev" — exactly what
  // state.chapters[key] would have held had this machine published it. Cached
  // in memory for this run only; never written back to the state file, because
  // this machine did not actually publish it.
  const liveBaselineCache = new Map(); // key -> reconstructed prev, or undefined
  async function fetchLiveChapterContent(path) {
    if (args.local) {
      const file = join(process.env.STORYLARK_LOCAL_R2, path);
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return null;
      }
    }
    if (!brand.contentOrigin) return null;
    try {
      const res = await fetch(`${brand.contentOrigin.replace(/\/+$/, '')}/${path}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }
  async function getLiveBaseline(bookId, chapterId) {
    const key = `${bookId}/${chapterId}`;
    if (liveBaselineCache.has(key)) return liveBaselineCache.get(key);
    const liveChapterEntry = findLiveChapterEntry(liveManifest, bookId, chapterId);
    if (!liveChapterEntry) {
      liveBaselineCache.set(key, undefined);
      return undefined;
    }
    const contentJson = await fetchLiveChapterContent(liveChapterEntry.content);
    if (!contentJson || !Array.isArray(contentJson.blocks)) {
      console.warn(`Warning: could not fetch the live baseline for ${key} (${liveChapterEntry.content}) — treating it as new.`);
      liveBaselineCache.set(key, undefined);
      return undefined;
    }
    const reconstructed = reconstructPreviousFromLive(liveChapterEntry, contentJson, chapterId, PRIMARY_VOICE);
    liveBaselineCache.set(key, reconstructed);
    return reconstructed;
  }
  // Built once, before parse(), because the parser needs previousBlocks AT
  // parse time (markdown-import.mjs threads it into stabilizeBlockIds). Local
  // state always wins when present; a live-reconstructed baseline only fills a
  // gap local state has.
  const previousForParse = { ...state.chapters };
  for (const book of liveManifest?.books ?? []) {
    if (args.book && book.id !== args.book) continue;
    for (const ch of book.chapters ?? []) {
      const key = `${book.id}/${ch.id}`;
      if (previousForParse[key]) continue; // local state wins
      const baseline = await getLiveBaseline(book.id, ch.id);
      if (baseline) previousForParse[key] = baseline;
    }
  }

  const parsed = await parse(sourceRepo, previousForParse, siteOrigin);
  // Accept the canonical shape { books: [{ book, chapters }] } (or a bare array of the same).
  let books = Array.isArray(parsed) ? parsed : parsed.books; // [{ book, chapters: [chapter] }]
  if (args.book) books = books.filter((b) => b.book.id === args.book);

  const plan = [];
  for (const { book, chapters } of books) {
    for (const chapter of chapters) {
      const hash = contentHash({ blocks: chapter.blocks, title: chapter.title });
      const key = `${book.id}/${chapter.id}`;
      // previousForParse already IS "local state, else the reconstructed live
      // baseline, else undefined for a genuinely new chapter" — the same
      // object the parser just stabilized block ids against, so the base this
      // comparison uses is exactly the base stabilizeBlockIds used.
      const prev = previousForParse[key];
      const changed = prev?.hash !== hash;
      plan.push({ book, chapter, hash, key, changed, prev });
    }
  }

  const changed = plan.filter((p) => p.changed);
  console.log(`Parsed ${plan.length} chapter(s); ${changed.length} changed since last publish.`);

  // ---- 1b. Conflict detection: what is LIVE that this run doesn't know about ----
  //
  // --force downgrades the refusal to a warning; --dry-run reports without ever
  // refusing, because a dry run overwrites nothing by definition.
  const conflictsRefused = reportConflicts(detectConflicts(), !args['dry-run'] && args.force !== true);
  if (conflictsRefused) {
    process.exitCode = 2;
    return;
  }

  if (args['dry-run']) {
    for (const p of plan) {
      // Narration cost per chapter, not just "changed" (AB#7412): "this chapter
      // changed" used to imply re-narrating all of it, and now it usually
      // doesn't. Reported here so the cost is known before it is paid.
      const audio = args['no-audio']
        ? ''
        : ` — narration: ${describeChapterAudio(
            planChapterAudio(p.chapter.blocks, join(workRoot, p.book.id, p.chapter.id, 'blocks'), {
              force: args['renarrate-all'] === true,
            })
          )}`;
      console.log(
        `  ${p.changed ? 'CHANGED ' : 'unchanged'} ${p.key} — ${p.chapter.blocks.length} blocks, ${p.chapter.wordCount} words, hash ${p.hash}${audio}`
      );
    }
    // A hard process.exit(0) here crashes on Windows with
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" when it fires
    // right after async work (the git-clone child process a sync run staged
    // from, or the undici fetches readLiveManifest()/getLiveBaseline() just
    // made) — a green dry-run reporting a crash exit code. Setting exitCode and
    // returning lets Node drain those handles instead of tearing them down mid-
    // close.
    process.exitCode = 0;
    return;
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
    // See the dry-run exit above: exitCode + return, not process.exit(0), so a
    // stateless run whose async work already touched a live origin doesn't
    // crash on the way out on Windows.
    process.exitCode = 0;
    return;
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
      // What this chapter will ACTUALLY cost, decided before anything is spent:
      // the per-block cache means an edited chapter usually bills for a paragraph,
      // not for the chapter (AB#7412). The budget guard below is charged against
      // that number rather than the whole chapter's length, because charging for
      // characters that are never sent is how a publish gets refused for a typo
      // fix it could easily have afforded.
      const audioPlan = planChapterAudio(chapter.blocks, join(chapterDir, 'blocks'), { force: args['renarrate-all'] === true });
      if (!useKokoro) {
        // Azure-only guards: subscription env + the F0 monthly character budget.
        // The bundled Kokoro model is local and free — nothing to guard.
        if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
          console.error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set — rerun with --no-audio for a text-only publish.');
          process.exit(1);
        }
        if (state.charLedger[month] + audioPlan.charCount > MONTHLY_CHAR_BUDGET) {
          console.error(
            `Char budget: ${state.charLedger[month]} used + ${audioPlan.charCount} would exceed ${MONTHLY_CHAR_BUDGET} this month. ` +
              `Skipping audio for ${key} — publish text-only with --no-audio, or wait for next month.`
          );
          process.exit(1);
        }
      }
      console.log(`TTS (${useKokoro ? 'kokoro, local' : 'azure'}): ${key} — ${describeChapterAudio(audioPlan)}…`);
      // Per-block, not per-chapter (AB#7412 — plan §3). Only the blocks whose
      // spoken text actually changed are re-synthesized; the rest are spliced back
      // in from the previous run's chunks, and stitchChapter re-derives every word
      // timing against the real durations so word-sync survives the splice.
      const { chunks, blockTimings, charCount, reused, resynthesized } = await synthesizeChapterIncremental(
        chapter,
        brand.tts.voice,
        chapterDir,
        {
          force: args['renarrate-all'] === true,
          key: process.env.AZURE_SPEECH_KEY,
          region: process.env.AZURE_SPEECH_REGION,
          onProgress: (blockId) => process.stdout.write(`\r  synthesized ${blockId}   `),
        }
      );
      process.stdout.write('\n');
      console.log(
        reused > 0
          ? `  re-narrated ${resynthesized} block(s), reused ${reused} unchanged — ${charCount} chars synthesized.`
          : `  narrated ${resynthesized} block(s) — ${charCount} chars synthesized.`
      );
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

  // ---- Voice preview samples: one short sample per published voice (AB#7389) ----
  //
  // Independent of chapter narration and of --manifest-only — a sample, once
  // synthesized, never needs re-publishing chapters to stay valid, and
  // ensureVoiceSamples() is itself state-driven (skips a voice whose sentence
  // hash is unchanged), so a manifest-only run after samples already exist
  // just re-reads the same paths at effectively no cost. Gated on whether
  // there is a narrator choice to preview at all (EXTRA_VOICES.length > 0,
  // the same condition that puts `voices` on the manifest below) and on
  // whether this run does TTS at all (--no-audio skips every kind of
  // narration, samples included) and isn't a dry run (which synthesizes
  // nothing).
  let sampleUrls = {};
  if (!args['no-audio'] && !args['dry-run'] && EXTRA_VOICES.length > 0) {
    const presentationFile = join(ROOT, 'presentation', brandId, 'presentation.json');
    const nouns = existsSync(presentationFile) ? JSON.parse(await readFile(presentationFile, 'utf8')).nouns : undefined;
    const sentence = sampleSentence(nouns);
    sampleUrls = await ensureVoiceSamples({
      voices: ALL_VOICES,
      sentence,
      workDir: join(workRoot, 'samples'),
      state,
      upload: (localFile, path) => putAudio(bucket, path, localFile),
      onProgress: (voice) => console.log(`Voice sample (${voice}): "${sentence}"`),
    });
    await writeFile(stateFile, JSON.stringify(state, null, 2));
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

  /**
   * Read the deployment's own manifest — the live state this run is about to
   * overwrite. Best effort: an unreachable origin, a first publish or a corrupt
   * file all mean "nothing is live", which is the behaviour that existed before
   * any of this.
   *
   * Read ONCE, early, and used for four separate things: conflict detection
   * (below), the library version floor, origin preservation, and carrying through
   * books this run doesn't own.
   */
  async function readLiveManifest() {
    if (args.local) {
      // A --local publish has no origin to fetch; the "live" manifest is the one
      // already mirrored into the local directory, and reading it keeps origin
      // preservation and conflict detection working identically off-cloud (which
      // is also what makes them testable without deploying anything).
      const localManifest = join(process.env.STORYLARK_LOCAL_R2, 'manifest.json');
      if (!existsSync(localManifest)) return null;
      try {
        return JSON.parse(await readFile(localManifest, 'utf8'));
      } catch {
        return null; // unreadable/corrupt — treat as absent, like an unreachable origin
      }
    }
    if (!brand.contentOrigin) return null;
    try {
      const res = await fetch(`${brand.contentOrigin.replace(/\/+$/, '')}/manifest.json`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch {
      return null; // offline or no manifest yet — local state is the only source, as before
    }
  }

  /**
   * Conflict detection between a portal edit and a CLI publish (AB#7412 — plan
   * §3's last open item).
   *
   * ── The failure this closes ─────────────────────────────────────────────────
   * Since AB#7420 the deployment holds its own source and can be edited from its
   * admin portal. `--pull` reconciles that back into a working tree WHEN ASKED,
   * but a publish without it simply overwrote whatever the portal had, silently,
   * with no way to notice afterwards: the manifest only records the winner.
   *
   * ── The rule, in one line ───────────────────────────────────────────────────
   * A chapter conflicts when the LIVE content differs both from what this machine
   * last published AND from what this run is about to publish.
   *
   * Both halves are load-bearing:
   *
   *   • `live === base`  — the deployment is exactly where this machine left it.
   *     Nobody has touched it, so publishing over it loses nothing. This is the
   *     ordinary case and it must stay silent.
   *   • `live === local` — the deployment already holds the very text about to be
   *     written. That is precisely the state a `--pull` leaves behind, so the
   *     documented reconciliation must not then be refused by the check that
   *     recommended it.
   *
   * Everything else — a portal edit this laptop never saw, two people editing the
   * same chapter, a second machine publishing the same book — lands in between
   * and is refused.
   *
   * ── Why contentHash and not a timestamp ─────────────────────────────────────
   * `contentHash` is already on every manifest entry, both writers compute it
   * with code proven equivalent (packages/worker/test/md-parity.test.mjs), and it
   * describes the text rather than when someone's clock said they typed it. A
   * timestamp comparison across a laptop and a datacentre is a bug waiting for a
   * daylight-saving change; a hash comparison is not.
   */
  function detectConflicts() {
    const blocking = [];
    const warnings = [];
    if (!liveManifest) return { blocking, warnings };

    const live = new Map((liveManifest.books ?? []).map((b) => [b.id, b]));
    const planned = new Map();
    for (const p of plan) {
      if (!planned.has(p.book.id)) planned.set(p.book.id, []);
      planned.get(p.book.id).push(p);
    }

    for (const [bookId, items] of planned) {
      const liveBook = live.get(bookId);
      if (!liveBook) continue; // never published — nothing of anyone else's here

      // Content this run does not own is carried through untouched (see §5b), so
      // it cannot be clobbered and must not be reported as if it could.
      if ((liveBook.origin ?? 'cli') !== (declaredOrigin ?? 'cli')) continue;

      const liveChapters = new Map((liveBook.chapters ?? []).map((ch) => [ch.id, ch]));

      for (const p of items) {
        const liveChapter = liveChapters.get(p.chapter.id);
        if (!liveChapter) continue; // new here, nothing live to lose
        const base = p.prev?.hash;
        if (liveChapter.contentHash === base) continue; // deployment is where we left it
        if (liveChapter.contentHash === p.hash) continue; // deployment already holds this exact text
        blocking.push({
          kind: 'edited',
          key: p.key,
          live: liveChapter.contentHash,
          base: base ?? '(never published from this machine)',
          local: p.hash,
        });
      }

      // A chapter that exists live and has no local file at all. The manifest is
      // regenerated from what was parsed, so publishing would DELETE it — and the
      // overwhelmingly likely reason it exists is that somebody wrote it in the
      // portal, where there is no local file to have.
      const plannedIds = new Set(items.map((p) => p.chapter.id));
      for (const ch of liveBook.chapters ?? []) {
        if (plannedIds.has(ch.id)) continue;
        blocking.push({ kind: 'orphan', key: `${bookId}/${ch.id}`, live: ch.contentHash });
      }

      // Order divergence is a warning, not a refusal. `publish.mjs` derives
      // chapter order from the numeric filename prefixes and always has; a portal
      // reorder is a manifest-only change. Restoring the file order is therefore
      // the correct behaviour AND a surprise, so it is announced rather than
      // either hidden or treated as an error.
      const liveOrder = (liveBook.chapters ?? []).map((ch) => ch.id).filter((id) => plannedIds.has(id));
      const localOrder = items.map((p) => p.chapter.id);
      if (liveOrder.length === localOrder.length && liveOrder.join(' ') !== localOrder.join(' ')) {
        warnings.push(
          `${bookId}: the deployment's chapter order differs from your files (live: ${liveOrder.join(' → ')}; ` +
            `publishing: ${localOrder.join(' → ')}). Order comes from the numeric filename prefixes, so this publish ` +
            `restores the file order. Rename the files to keep a reorder made in the portal.`
        );
      }

      // Book metadata the portal can edit and a publish would quietly revert.
      const localBook = items[0].book;
      for (const field of ['title', 'author', 'description']) {
        const liveValue = liveBook[field];
        const localValue = localBook[field];
        if (liveValue === undefined || liveValue === localValue) continue;
        warnings.push(`${bookId}: ${field} is "${liveValue}" on the deployment and "${localValue ?? '(unset)'}" here — publishing overwrites it.`);
      }
    }

    return { blocking, warnings };
  }

  /**
   * Say what was found, and report whether the caller should stop before
   * anything is overwritten.
   *
   * Returns a boolean (refused?) rather than calling process.exit(2) itself:
   * this can run after real async work (readLiveManifest()'s fetch, the
   * baseline reconstruction fetches above), and a process.exit() torn down
   * mid-close is exactly the Windows UV_HANDLE_CLOSING crash AB#7654 also
   * fixes for the dry-run exits — the caller sets exitCode and returns instead.
   */
  function reportConflicts({ blocking, warnings }, refuse) {
    for (const w of warnings) console.warn(`Warning: ${w}`);
    if (blocking.length === 0) return false;

    const lines = ['', 'CONFLICT — the deployment holds content this publish does not know about.', ''];
    for (const c of blocking) {
      if (c.kind === 'orphan') {
        lines.push(`  ${c.key}`);
        lines.push(`      Exists on the deployment (${c.live}) and has no file in your source.`);
        lines.push('      Almost certainly written in the admin portal. Publishing would remove it from the library.');
      } else {
        lines.push(`  ${c.key}`);
        lines.push(`      live ${c.live} · last published from here ${c.base} · about to publish ${c.local}`);
        lines.push('      The deployment changed after your last publish — an admin-portal edit, or another machine.');
        lines.push("      Publishing would replace that text with this working tree's copy.");
      }
      lines.push('');
    }
    lines.push('Reconcile first — both are one command:');
    lines.push('  publish --pull      fetch the deployment\'s text into this working tree, review it, then publish');
    lines.push('  publish --force     publish anyway, overwriting what is live');
    lines.push('');

    if (!refuse) {
      console.warn(lines.join('\n'));
      return false;
    }
    console.error(lines.join('\n'));
    return true;
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
  //
  // The same read also carries ORIGIN forward (AB#7422). A republish must not
  // relabel where content came from: a book synced from a publisher's repo stays
  // `sync` (and therefore stays read-only in the portal) even when this run is a
  // plain `npm run publish`, and a story written in the portal stays `portal`.
  // Only an explicit --origin overrides what is already live.
  // `liveManifest` is read ONCE, early — see readLiveManifest()'s definition and
  // the conflict gate that consumes it before anything is uploaded.
  // Whatever is already published wins, local or remote: a manifest version that
  // goes backwards is a manifest no reader ever re-fetches. Two publishes into the
  // same local directory from different --bucket state files would otherwise both
  // claim v1, and the second would reach nobody.
  const liveVersion = Number(liveManifest?.libraryVersion) || 0;

  /** origin recorded live for a book, or for one of its chapters. */
  const liveBooks = new Map((liveManifest?.books ?? []).map((b) => [b.id, b]));
  function liveOrigin(bookId, chapterId) {
    const book = liveBooks.get(bookId);
    if (!book) return undefined;
    if (chapterId === undefined) return book.origin;
    const ch = (book.chapters ?? []).find((c) => c.id === chapterId);
    return ch?.origin ?? book.origin;
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
    // Narrator choices the app's Settings picker offers (id → { name,
    // sampleUrl? } — AB#7389). `sampleUrls[v]` is absent when this run didn't
    // (re)synthesize samples at all (e.g. --no-audio, or --dry-run never
    // reaches here) — the entry still carries its name, so the picker itself
    // still works, just without a preview button for that voice.
    voices:
      EXTRA_VOICES.length > 0
        ? Object.fromEntries(ALL_VOICES.map((v) => [v, { name: voiceDisplayName(v), sampleUrl: sampleUrls[v] }]))
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
      // Ownership (AB#7422 — plan §8). Explicit flag wins; otherwise whatever is
      // already live is preserved; otherwise `cli`, which is what a publish from
      // an operator's own markdown has always been.
      origin: declaredOrigin ?? liveOrigin(book.id) ?? 'cli',
      // Where a synced book's real source of truth is. Preserved from the live
      // manifest on an ordinary republish so a `--pull`-then-publish round trip
      // (which is how a synced library gets its narration) doesn't erase it.
      syncSource: syncSource ?? liveBooks.get(book.id)?.syncSource,
      chapters: chapters.map((ch) => {
        // An unchanged chapter never enters the per-chapter loop above, so on a
        // stateless run state.chapters has nothing for it even though it just
        // published fine — previousForParse (AB#7654) is that same chapter's
        // reconstructed live baseline, which already carries the audio/voices
        // this chapter has live, so it is not silently dropped from the
        // manifest just because this machine has no memory of it.
        const saved = state.chapters[`${book.id}/${ch.id}`] ?? previousForParse[`${book.id}/${ch.id}`];
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
          // Per chapter as well as per book: a chapter is the unit an edit is
          // refused (or allowed) on, so it carries its own answer rather than
          // making every reader of the manifest walk up to the book.
          origin: declaredOrigin ?? liveOrigin(book.id, ch.id) ?? 'cli',
        };
      }),
    })),
  };

  // ---- 5b. Books this run does not own, carried through untouched ----
  //
  // The manifest is regenerated from what was parsed, so a book absent from the
  // source has always been dropped from the library. That is correct for content
  // this run OWNS — deleting a chapter folder should unpublish it — and wrong for
  // content that came from somewhere else (AB#7422).
  //
  // Without this, plan §8's "a deployment can carry a synced repo AND a few
  // portal-written stories side by side" is not true: a sync would silently
  // delete every story written in the portal, and a CLI publish would silently
  // delete the synced catalogue. Neither is recoverable from the manifest alone.
  //
  // The rule is narrow on purpose: **a publish only removes books it could have
  // produced.** A run publishing `sync` keeps live `portal` and `cli` books; a
  // run publishing `cli` (the default) keeps live `sync` and `portal` books.
  // Behaviour for a library that is entirely CLI-published — the only shape that
  // existed before this — is byte-for-byte unchanged.
  const runOrigin = declaredOrigin ?? 'cli';
  const publishedIds = new Set(books.map(({ book }) => book.id));
  const carried = (liveManifest?.books ?? []).filter(
    (b) => !publishedIds.has(b.id) && (b.origin ?? 'cli') !== runOrigin
  );
  if (carried.length > 0) {
    console.log(
      `Carrying through ${carried.length} book(s) this run doesn't own: ` +
        carried.map((b) => `${b.id} (${b.origin ?? 'cli'})`).join(', ')
    );
    manifest.books.push(...carried);
  }
  // `--book <id>` narrows the publish to one book but must not narrow the
  // LIBRARY to one book. Same-origin siblings are carried through too, because
  // the alternative is that publishing one chapter unpublishes everything else.
  if (args.book) {
    const kept = new Set(manifest.books.map((b) => b.id));
    const siblings = (liveManifest?.books ?? []).filter((b) => !kept.has(b.id));
    if (siblings.length > 0) {
      console.log(`--book ${args.book}: keeping ${siblings.length} other book(s) already in the library.`);
      manifest.books.push(...siblings);
    }
  }

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

}

await main();
