#!/usr/bin/env node
// StoryLark narration worker — drains a deployment's bulk narration queue
// (AB#7412, plan §8 item 4: "a bulk narration queue with progress and a
// realistic time estimate").
//
//   node packages/pipeline/narrate.mjs --brand <id> [flags]
//
// ── Why this is a separate process, and not a button in the portal ──────────
// Because no StoryLark deployment can narrate, and that is a fact about the
// runtimes rather than a missing feature:
//
//   • A Cloudflare Worker cannot run the Kokoro model at all — no filesystem for
//     the ~90MB weights, no native ONNX runtime, no ffmpeg to stitch chunks, and
//     a CPU budget measured in seconds against a job measured in minutes.
//   • The Node entry (platforms/azure/server.mjs) could in principle host a
//     model but deliberately does not: its dependencies are hono, pg and a blob
//     client. TTS, force alignment, stitching and ffmpeg live HERE, in the
//     pipeline, along with the storage credentials — which is where narration
//     has always actually happened.
//
// So the deployment owns the QUEUE (what needs narrating, what is running, what
// failed and why — visible in /admin and pollable over HTTP) and this process
// owns the WORK. The portal never pretends otherwise: it shows the reason and
// this command.
//
// ── It is the same TTS as a publish, not a second one ───────────────────────
// This imports `synthesizeChapter` and `stitchChapter` — the exact functions
// publish.mjs calls — and uploads to the exact content-hashed keys publish.mjs
// writes. There is no second narration path and no second key convention. What
// differs is only where the work comes from (a claimed job instead of a parsed
// source tree) and where the result is recorded (the deployment updates its own
// manifest, because on Cloudflare it is the only thing holding a writable
// content store).
//
// ── Flags ───────────────────────────────────────────────────────────────────
//   --brand <id>            required — same brand id publish.mjs takes
//   --max <n>               jobs claimed per round (default 4)
//   --watch [seconds]       keep polling instead of exiting when the queue empties
//   --worker <name>         how this worker identifies itself (default host-pid)
//   --bucket <name>         content bucket/container (default <brand>-content)
//   --storage r2|azure-blob storage driver (default r2, or STORYLARK_STORAGE)
//   --local <dir>           mirror into a local directory instead of a remote bucket
//   --app-origin <url>      override the deployment URL to talk to
//   --content-origin <url>  override where published chapter JSON is read from
//   --no-audio-voices       primary narrator only; skip the brand's extra voices
//   --status                print the queue and exit — claims nothing
//   --dry-run               claim nothing, print what WOULD be narrated
//
// Env: ADMIN_KEY (required — the same key publish.mjs uses to notify),
//      AZURE_SPEECH_KEY / AZURE_SPEECH_REGION for Azure voices.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { isKokoroVoice } from './tts-kokoro.mjs';
import { stitchChapter } from './stitch.mjs';
import { resolveProvider } from './storage.mjs';

const ROOT = process.cwd();
const args = parseArgs(process.argv.slice(2));
const USAGE =
  'Usage: node packages/pipeline/narrate.mjs --brand <id> [--max <n>] [--watch [seconds]] [--worker <name>] [--bucket <name>] [--storage r2|azure-blob] [--local <dir>] [--status] [--dry-run]';

const brandId = args.brand;
if (!brandId || typeof brandId !== 'string') {
  console.error(USAGE);
  process.exit(1);
}

// Same brand + deployment resolution publish.mjs does, so a worker started in a
// site repo needs no configuration the publish command doesn't already need.
const brand = JSON.parse(await readFile(join(ROOT, 'brands', brandId, 'brand.json'), 'utf8'));
const deploymentFile = join(ROOT, 'deployment', brandId, 'deployment.json');
const deployment = existsSync(deploymentFile) ? JSON.parse(await readFile(deploymentFile, 'utf8')) : {};
const appOrigin = String(
  args['app-origin'] || process.env.STORYLARK_APP_ORIGIN || deployment.appOrigin || brand.appOrigin || ''
).replace(/\/+$/, '');
const contentOrigin = String(
  args['content-origin'] || process.env.STORYLARK_CONTENT_ORIGIN || deployment.contentOrigin || brand.contentOrigin || ''
).replace(/\/+$/, '');
const tts = { ...brand.tts, ...deployment.tts };
if (process.env.STORYLARK_TTS_VOICE) tts.voice = process.env.STORYLARK_TTS_VOICE;
if (process.env.STORYLARK_TTS_VOICES) tts.voices = process.env.STORYLARK_TTS_VOICES.split(',').map((v) => v.trim()).filter(Boolean);

if (!appOrigin) {
  console.error(
    `No appOrigin for brand "${brandId}". The worker talks to the deployment over HTTP — set it in ${deploymentFile}, or pass --app-origin.`
  );
  process.exit(1);
}
if (!tts.voice) {
  console.error(`No narrator voice configured for "${brandId}". Set tts.voice in ${deploymentFile} (or STORYLARK_TTS_VOICE).`);
  process.exit(1);
}

const adminKey = process.env.ADMIN_KEY ?? '';
if (!adminKey && !args.status) {
  console.error(
    'ADMIN_KEY is not set. The worker authenticates to the deployment with the same key publish.mjs uses to send its notification.'
  );
  process.exit(1);
}

if (args.local) {
  process.env.STORYLARK_LOCAL_R2 = resolve(String(args.local));
  console.log(`Local mode → ${process.env.STORYLARK_LOCAL_R2} (no remote bucket).`);
}
const bucket = typeof args.bucket === 'string' && args.bucket ? args.bucket : `${brandId}-content`;
const { putJson, putAudio } = resolveProvider(args.storage);

const PRIMARY_VOICE = tts.voice;
const EXTRA_VOICES = args['no-audio-voices'] ? [] : [...new Set(tts.voices ?? [])].filter((v) => v !== PRIMARY_VOICE);
const workerName =
  (typeof args.worker === 'string' && args.worker) || `${hostname()}-${process.pid}`;
const maxPerRound = Number.isFinite(Number(args.max)) ? Math.max(1, Math.min(Number(args.max), 50)) : 4;
const workRoot = join(ROOT, '.storylark', 'narrate', bucket);
await mkdir(workRoot, { recursive: true });

/* ────────────────────────────────────────────────────────────────────────────
 * --status / --dry-run: look, don't touch
 * ──────────────────────────────────────────────────────────────────────────── */

if (args.status || args['dry-run']) {
  const view = await api('GET', '/api/admin/narration?limit=50');
  if (!view.available) {
    console.error(view.message ?? 'The deployment has no narration queue.');
    process.exit(1);
  }
  const { counts, charsRemaining, estimateSeconds, charsPerSecond, runtime } = view;
  console.log(`Queue at ${appOrigin}:`);
  console.log(`  pending ${counts.pending}  running ${counts.running}  done ${counts.done}  failed ${counts.failed}  cancelled ${counts.cancelled}`);
  console.log(`  ${charsRemaining.toLocaleString()} characters of text left to narrate.`);
  console.log(
    estimateSeconds === null
      ? '  No time estimate yet — nothing has completed on this deployment, so there is no measured throughput to extrapolate from.'
      : `  Estimated ${formatDuration(estimateSeconds)} remaining, at the measured ${Math.round(charsPerSecond)} characters/second.`
  );
  console.log(`  Narration in the deployment: ${runtime.canProcessInDeployment ? 'yes' : 'no'} — ${runtime.reason}`);
  for (const job of view.jobs.filter((j) => j.status === 'pending' || j.status === 'running').slice(0, 20)) {
    console.log(`   ${job.status.padEnd(8)} ${job.bookId}/${job.chapterId}  (${job.charLength} chars)`);
  }
  for (const job of view.jobs.filter((j) => j.status === 'failed').slice(0, 10)) {
    console.log(`   FAILED   ${job.bookId}/${job.chapterId}: ${job.error}`);
  }
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The loop
 * ──────────────────────────────────────────────────────────────────────────── */

const watchSeconds = args.watch === true ? 30 : Number.isFinite(Number(args.watch)) ? Number(args.watch) : null;
let narrated = 0;
let failed = 0;

for (;;) {
  const { jobs } = await api('POST', '/api/admin/narration/claim', { worker: workerName, max: maxPerRound });
  if (jobs.length === 0) {
    if (watchSeconds === null) break;
    process.stdout.write(`\rNothing pending; next check in ${watchSeconds}s…            `);
    await sleep(watchSeconds * 1000);
    continue;
  }
  console.log(`Claimed ${jobs.length} job(s) as "${workerName}".`);
  for (const job of jobs) {
    await runJob(job);
  }
}

console.log(`\nNarrated ${narrated} chapter(s); ${failed} failed.`);
// `process.exitCode`, deliberately NOT `process.exit()`. Found in a real run:
// tearing the process down while onnxruntime-node still holds async handles
// aborts libuv on Windows ("Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)") AFTER every chapter has already been narrated, uploaded
// and reported — so a completely successful drain would exit as a crash and a
// scheduled run would look broken. Setting the code and letting Node unwind
// normally is what publish.mjs already does at the end of a successful publish.
process.exitCode = failed > 0 ? 1 : 0;

/**
 * One job: read the published blocks, synthesise, stitch, upload, report.
 *
 * Every failure path reports the job FAILED with the real message rather than
 * leaving it stuck in `running`. A job nobody ever reports on is the worst
 * outcome here — the queue would look busy while nothing was happening, which is
 * indistinguishable from progress and is exactly what a queue exists to prevent.
 */
async function runJob(job) {
  const label = `${job.bookId}/${job.chapterId}`;
  const startedAt = Date.now();
  const chapterDir = join(workRoot, job.bookId, `${job.chapterId}.${job.contentHash}`);
  try {
    await rm(chapterDir, { recursive: true, force: true });
    await mkdir(chapterDir, { recursive: true });

    const chapter = await readChapter(job);
    if (!Array.isArray(chapter.blocks) || chapter.blocks.length === 0) {
      throw new Error('The published chapter JSON has no blocks — there is nothing to narrate.');
    }

    const useKokoro = isKokoroVoice(PRIMARY_VOICE);
    if (!useKokoro && (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION)) {
      throw new Error(
        `Voice "${PRIMARY_VOICE}" is an Azure voice and AZURE_SPEECH_KEY / AZURE_SPEECH_REGION are not set on this worker.`
      );
    }
    console.log(`TTS (${useKokoro ? 'kokoro, local' : 'azure'}): ${label} — ${chapter.blocks.length} block(s)…`);
    const primary = await synthesizeVoiceTrack(chapter, PRIMARY_VOICE, chapterDir);

    const voiceTracks = {};
    for (const voice of EXTRA_VOICES) {
      console.log(`TTS extra voice ${voice}: ${label}…`);
      voiceTracks[voice] = await synthesizeVoiceTrack(chapter, voice, join(chapterDir, voice));
    }

    // The SAME key convention publish.mjs writes, handed to us by the claim so
    // the deployment and the worker cannot disagree about where audio lives.
    await putAudio(bucket, job.audioKey, primary.audioFile);
    await putJson(bucket, job.timingsKey, primary.timingsFile);
    const voices = {
      [PRIMARY_VOICE]: { audio: job.audioKey, timings: job.timingsKey },
    };
    for (const [voice, track] of Object.entries(voiceTracks)) {
      const audioKey = `books/${job.bookId}/audio/${job.chapterId}.${job.contentHash}.${voice}.mp3`;
      const timingsKey = `books/${job.bookId}/timings/${job.chapterId}.${job.contentHash}.${voice}.json`;
      await putAudio(bucket, audioKey, track.audioFile);
      await putJson(bucket, timingsKey, track.timingsFile);
      voices[voice] = { audio: audioKey, timings: timingsKey };
    }

    const result = await api('POST', `/api/admin/narration/jobs/${encodeURIComponent(job.id)}/complete`, {
      audio: job.audioKey,
      timings: job.timingsKey,
      durationMs: primary.durationMs,
      voices: EXTRA_VOICES.length > 0 ? voices : undefined,
      elapsedMs: Date.now() - startedAt,
      // The deployment refuses the completion if the chapter changed while this
      // was synthesising, rather than publishing audio of superseded words.
      contentHash: job.contentHash,
    });
    narrated++;
    console.log(
      `  ${label}: ${Math.round(primary.durationMs / 1000)}s of audio in ${formatDuration(Math.round((Date.now() - startedAt) / 1000))}` +
        (result.batchFinished ? '  — batch finished.' : '')
    );
  } catch (err) {
    failed++;
    const message = String(err?.message ?? err);
    console.error(`  ${label}: FAILED — ${message}`);
    await api('POST', `/api/admin/narration/jobs/${encodeURIComponent(job.id)}/fail`, { error: message }).catch(() => {});
  } finally {
    await rm(chapterDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The chapter's published blocks.
 *
 * Read from the PUBLIC content origin — no credential, because published content
 * is public and this direction only ever reads. In `--local` mode the same key
 * is read off disk, which is what makes the whole loop testable with no cloud.
 */
async function readChapter(job) {
  if (process.env.STORYLARK_LOCAL_R2) {
    const file = join(process.env.STORYLARK_LOCAL_R2, job.contentKey);
    if (!existsSync(file)) throw new Error(`${file} does not exist — the chapter JSON for this content hash is not in the local mirror.`);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  const url = job.contentUrl ?? (contentOrigin ? `${contentOrigin}/${job.contentKey}` : null);
  if (!url) {
    throw new Error('No content origin is configured, so the worker cannot read the published chapter to narrate it.');
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned ${res.status} — the chapter JSON for this content hash is not published.`);
  return res.json();
}

/** Synthesize + stitch one chapter in one voice. Identical to publish.mjs's. */
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

async function api(method, path, body) {
  const res = await fetch(`${appOrigin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': adminKey,
      // Harmless on the key path and required on the session path — sending it
      // always means the worker behaves the same either way.
      'X-Requested-With': 'storylark',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: 'unparseable', message: text.slice(0, 500) };
  }
  if (!res.ok) {
    const detail = parsed.message ?? parsed.error ?? text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return parsed;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
