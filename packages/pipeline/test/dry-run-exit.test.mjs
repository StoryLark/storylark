// AB#7654 — the Windows exit crash (fix D).
//
// `process.exit(0)` called immediately after real async work — a fetch, a
// git-clone child process — can abort on Windows with "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94": a green dry-run
// reporting a crash exit code. The other tests in this directory only
// exercise the DISK-based `--local` path for readLiveManifest(); this one
// points a publish at a real local HTTP server instead, so the fix is proven
// against the actual code path named in the bug report — an undici fetch —
// and not just against something that happens to look similar.
//
// This can't reproduce the Windows-specific UV_HANDLE_CLOSING assertion on
// every platform this suite runs on, but it does prove the actual mechanism
// the fix relies on: the child process's own 'exit' event fires promptly
// (this test would time out, not merely fail an assertion, if something were
// still holding the event loop open the way a mid-teardown process.exit()
// can), and the exit code is set via `process.exitCode`, not a forced
// `process.exit()` call, on every dry-run/refusal path this bug named.
//
//   node --import tsx/esm --test packages/pipeline/test/dry-run-exit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from '../lib/md.mjs';
import { parse } from '../lib/markdown-import.mjs';
import { makeRoot, PUBLISH_SCRIPT, cleanup } from './helpers.mjs';

const CHAPTER_MD = `---
title: The Arrival
---

The lighthouse keeper climbed the stairs at dawn.
`;

test('a dry-run against a REAL fetch-backed origin exits promptly with exitCode 0, no hard process.exit()', async (t) => {
  const root = await makeRoot();
  t.after(() => cleanup(root));

  // Build the exact chapter JSON + hash a real publish of CHAPTER_MD would
  // produce, using the real parser — so the fake origin serves something
  // genuinely well-formed, not a hand-typed guess.
  const bookDir = join(root, 'source', 'books', 'mybook');
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, '01-the-arrival.md'), CHAPTER_MD);
  const { books } = await parse(join(root, 'source'), {}, undefined);
  const chapter = books[0].chapters[0];
  const hash = contentHash({ blocks: chapter.blocks, title: chapter.title });

  const manifest = {
    schemaVersion: 1,
    libraryVersion: 1,
    books: [
      {
        id: 'mybook',
        title: 'My Book',
        origin: 'cli',
        chapters: [
          {
            id: 'the-arrival',
            contentHash: hash,
            content: `books/mybook/chapters/the-arrival.${hash}.json`,
            hasAudio: false,
          },
        ],
      },
    ],
  };
  const chapterJson = { id: 'the-arrival', bookId: 'mybook', title: chapter.title, blocks: chapter.blocks };

  const server = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } else if (req.url === `/books/mybook/chapters/the-arrival.${hash}.json`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chapterJson));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  await mkdir(join(root, 'brands', 'testbrand'), { recursive: true });
  await writeFile(
    join(root, 'brands', 'testbrand', 'brand.json'),
    JSON.stringify({ id: 'testbrand', appOrigin: origin, contentOrigin: origin, tts: { voice: 'af_heart' } })
  );

  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PUBLISH_SCRIPT, '--brand', 'testbrand', '--source', join(root, 'source'), '--no-audio', '--dry-run'],
      { cwd: root }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // A real timeout, not just an assertion: if the fetch-backed run left a
    // handle open and fell back to relying on a forced process.exit() that
    // this fix removed, the process would hang here instead of merely
    // reporting a wrong exit code.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`publish.mjs --dry-run did not exit within 15s (still-open handle?):\n${stdout}\n${stderr}`));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  assert.ok(Date.now() - started < 15_000, 'exited before the safety timeout');
  assert.equal(result.code, 0, `dry-run over a real fetch should exit 0:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /unchanged mybook\/the-arrival/, 'the fetched live baseline matched, so dry-run reports it unchanged');
});
