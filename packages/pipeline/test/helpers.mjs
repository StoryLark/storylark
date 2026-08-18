// Shared fixture/spawn helpers for the pipeline's stateless-publish tests
// (AB#7654). Deliberately spawns the REAL publish.mjs as a child process
// against a throwaway ROOT and a `--local` mirror — no fetch/wrangler
// mocking, no fabricated CLI internals. `--local` already exists for exactly
// this ("what makes them testable without deploying anything" — publish.mjs's
// own readLiveManifest() comment) so this exercises the genuine code path a
// real `--local`-served demo/dev deployment runs.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLISH_SCRIPT = join(HERE, '..', 'publish.mjs');

/** A throwaway ROOT (what publish.mjs treats as `process.cwd()`) with one brand. */
export async function makeRoot(brandId = 'testbrand') {
  const root = await mkdtemp(join(tmpdir(), 'storylark-pipeline-test-'));
  await mkdir(join(root, 'brands', brandId), { recursive: true });
  await writeFile(
    join(root, 'brands', brandId, 'brand.json'),
    JSON.stringify(
      {
        id: brandId,
        appOrigin: 'https://app.testbrand.example',
        contentOrigin: '', // --local mode never reads this — see readLiveManifest()
        tts: { voice: 'af_heart' }, // a Kokoro-shaped id; never actually synthesized with --no-audio
      },
      null,
      2
    )
  );
  return root;
}

export async function writeChapter(root, bookId, filename, markdown) {
  const dir = join(root, 'source', 'books', bookId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, filename);
  await writeFile(file, markdown);
  return file;
}

/** Spawn the real CLI. Resolves with { code, stdout, stderr } — never rejects
 *  on a non-zero exit, since several tests need to assert ON the exit code. */
export function runPublish(root, extraArgs = [], { brandId = 'testbrand', localDir = 'local-content' } = {}) {
  const argv = [PUBLISH_SCRIPT, '--brand', brandId, '--source', join(root, 'source'), '--local', join(root, localDir), ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export function bucketStateFile(root, brandId = 'testbrand') {
  return join(root, '.storylark', 'state', `${brandId}-content.json`);
}

export function localManifestFile(root, localDir = 'local-content') {
  return join(root, localDir, 'manifest.json');
}

/** Delete this machine's publish ledger — "a fresh runner/second laptop". */
export async function deleteState(root, brandId = 'testbrand') {
  await rm(bucketStateFile(root, brandId), { force: true });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}
