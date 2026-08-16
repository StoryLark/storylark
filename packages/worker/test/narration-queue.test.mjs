// The bulk narration queue (AB#7412 — plan §8 item 4, "the genuinely expensive
// piece").
//
// Driven against the REAL app over real Requests, a REAL sqlite database
// carrying the REAL shipped migrations (including 0008, so the DDL itself is
// executed here rather than assumed valid) and a REAL content store on disk.
// The "worker" in these tests is the HTTP client — it makes exactly the calls
// packages/pipeline/narrate.mjs makes, in the same order, so what is proven is
// the contract between the deployment and the worker rather than a mock of it.
//
// What is deliberately NOT here: running the Kokoro model. That is ~90MB of
// weights and minutes per chapter, it is the same `synthesizeChapter` +
// `stitchChapter` publish.mjs has always called, and putting it in `npm test`
// would make the suite unrunnable. The queue is what is new and the queue is
// what is tested.
//
//   node --import tsx/esm --test packages/worker/test/narration-queue.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDeployment, chapterMarkdown } from './sqlite-env.mjs';

/** Push a library and return the queue batch it created. */
async function libraryOf(dep, books) {
  const res = await dep.call('POST', '/api/content/v1/books', { contractVersion: 1, books });
  assert.equal(res.status < 300, true, res.text);
  return res.json;
}

test('an empty deployment has an empty queue, and says which runtime can drain it', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.status, 200);
  assert.equal(view.json.available, true, 'migration 0008 really did apply');
  assert.deepEqual(view.json.counts, { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 });
  assert.equal(view.json.estimateSeconds, null, 'no estimate before anything has been measured');

  // The honesty requirement: no deployment narrates, and the response says so
  // and names what does.
  assert.equal(view.json.runtime.canProcessInDeployment, false);
  assert.match(view.json.runtime.reason, /model/i);
  assert.match(view.json.runtime.runCommand, /narrate\.mjs/);
  assert.equal(view.json.runtime.workerAuthConfigured, true);
});

test('enqueue picks up exactly the chapters whose audio is missing or stale', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await libraryOf(dep, [
    { id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }, { id: 'two', markdown: chapterMarkdown('Two') }] },
    { id: 'book-b', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }] },
  ]);
  // The push already queued all three. Draining them lets the stale-only rule be
  // tested against a library that has audio.
  const view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.json.counts.pending, 3);

  // Re-enqueueing must not double up: the same chapter gets its pending job
  // updated, not a second one.
  const again = await dep.call('POST', '/api/admin/narration/enqueue', {});
  assert.equal(again.json.queued, 3);
  assert.equal(again.json.created, 0, 'nothing new was created');
  assert.equal(again.json.requeued, 3, 'the existing pending jobs were updated in place');
  const after = await dep.call('GET', '/api/admin/narration');
  assert.equal(after.json.counts.pending, 3, 'still three jobs, not six');

  // Narrowing by book works.
  const narrowed = await dep.call('POST', '/api/admin/narration/enqueue', { bookIds: ['book-b'] });
  assert.equal(narrowed.json.queued, 1);
});

test('a full worker round trip: claim, complete, and the manifest stops being stale', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await libraryOf(dep, [{ id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }] }]);

  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 4 });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.jobs.length, 1);
  const job = claim.json.jobs[0];
  assert.equal(job.status, 'running');
  assert.equal(job.worker, 'runner-1');
  assert.equal(job.attempts, 1);
  // The claim tells the worker exactly where to read from and write to, so the
  // deployment and the worker cannot disagree about key conventions.
  assert.equal(job.contentKey, `books/book-a/chapters/one.${job.contentHash}.json`);
  assert.equal(job.audioKey, `books/book-a/audio/one.${job.contentHash}.mp3`);
  assert.equal(job.contentUrl, `https://content.example.test/books/book-a/chapters/one.${job.contentHash}.json`);

  // A second worker asking now gets nothing — the job is claimed.
  const second = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-2', max: 4 });
  assert.equal(second.json.jobs.length, 0);

  const before = await dep.manifest();
  assert.equal(before.books[0].chapters[0].hasAudio, false);

  const done = await dep.call('POST', `/api/admin/narration/jobs/${job.id}/complete`, {
    audio: job.audioKey,
    timings: job.timingsKey,
    durationMs: 42_000,
    elapsedMs: 9_000,
    contentHash: job.contentHash,
  });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.batchFinished, true);

  const after = await dep.manifest();
  const chapter = after.books[0].chapters[0];
  assert.equal(chapter.hasAudio, true);
  assert.equal(chapter.audioStale, false);
  assert.equal(chapter.audio, job.audioKey);
  assert.equal(chapter.timings, job.timingsKey);
  assert.equal(chapter.audioDurationMs, 42_000);
  assert.ok(after.libraryVersion > before.libraryVersion, 'readers must re-fetch to hear it');
  assert.equal(
    after.announceVersion,
    before.announceVersion,
    'narration is never an announcement — the words readers were told about did not change'
  );

  // library_state moved too, which is what GET /api/library/version answers.
  const version = await dep.call('GET', '/api/library/version');
  assert.equal(version.json.version, after.libraryVersion);
});

test('a completion for text that has since changed is refused, not published', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await libraryOf(dep, [{ id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }] }]);
  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'slow-runner', max: 1 });
  const job = claim.json.jobs[0];

  // While the worker is synthesising, the publisher pushes a correction.
  await dep.call('PUT', '/api/content/v1/books/book-a/chapters/one', {
    contractVersion: 1,
    markdown: chapterMarkdown('One', 'Corrected while the narration was running.'),
  });

  const done = await dep.call('POST', `/api/admin/narration/jobs/${job.id}/complete`, {
    audio: job.audioKey,
    timings: job.timingsKey,
    durationMs: 42_000,
    contentHash: job.contentHash,
  });
  assert.equal(done.status, 409);
  assert.equal(done.json.error, 'stale_content_hash');

  const manifest = await dep.manifest();
  const chapter = manifest.books[0].chapters[0];
  assert.equal(chapter.hasAudio, false, 'audio of superseded words is never published');
  assert.notEqual(chapter.contentHash, job.contentHash);

  // The job is marked failed with the reason, and the correction's own job is
  // pending — so the queue self-heals rather than stranding the chapter.
  const view = await dep.call('GET', '/api/admin/narration');
  const failed = view.json.jobs.find((j) => j.id === job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /changed while it was being narrated/);
  assert.equal(view.json.counts.pending, 1);
});

test('failures are recorded with their reason, and can be retried', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await libraryOf(dep, [{ id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }] }]);
  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 1 });
  const job = claim.json.jobs[0];

  await dep.call('POST', `/api/admin/narration/jobs/${job.id}/fail`, {
    error: 'ffmpeg is not installed on this worker.',
  });
  let view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.json.counts.failed, 1);
  assert.match(view.json.jobs[0].error, /ffmpeg/);

  const retry = await dep.call('POST', `/api/admin/narration/jobs/${job.id}/retry`);
  assert.equal(retry.status, 200);
  view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.json.counts.pending, 1);
  assert.equal(view.json.counts.failed, 0);

  // The attempt counter survives the retry, so a job failing forever is visible.
  const reclaim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 1 });
  assert.equal(reclaim.json.jobs[0].attempts, 2);
});

test('a pending job can be cancelled; a running one cannot', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await libraryOf(dep, [
    { id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }, { id: 'two', markdown: chapterMarkdown('Two') }] },
  ]);
  const view = await dep.call('GET', '/api/admin/narration');
  const pending = view.json.jobs[0];

  const cancelled = await dep.call('DELETE', `/api/admin/narration/jobs/${pending.id}`);
  assert.equal(cancelled.status, 200);

  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 5 });
  assert.equal(claim.json.jobs.length, 1, 'the cancelled job is not handed out');
  const running = claim.json.jobs[0];

  const refused = await dep.call('DELETE', `/api/admin/narration/jobs/${running.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'not_cancellable');
});

test('the time estimate is measured, not invented', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const body = 'A paragraph of perfectly ordinary prose, repeated. '.repeat(20);
  await libraryOf(dep, [
    {
      id: 'book-a',
      chapters: [
        { id: 'one', markdown: chapterMarkdown('One', body) },
        { id: 'two', markdown: chapterMarkdown('Two', body) },
      ],
    },
  ]);

  let view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.json.estimateSeconds, null, 'nothing measured yet, so no number is offered');
  assert.ok(view.json.charsRemaining > 0);

  // Complete one job at a known, deliberate rate.
  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 1 });
  const job = claim.json.jobs[0];
  await dep.call('POST', `/api/admin/narration/jobs/${job.id}/complete`, {
    audio: job.audioKey,
    timings: job.timingsKey,
    durationMs: 1000,
    elapsedMs: 10_000, // ten seconds for job.charLength characters
    contentHash: job.contentHash,
  });

  view = await dep.call('GET', '/api/admin/narration');
  assert.ok(view.json.charsPerSecond > 0, 'throughput comes from the completed job');
  const expected = job.charLength / 10;
  assert.ok(
    Math.abs(view.json.charsPerSecond - expected) < 0.001,
    `charsPerSecond ${view.json.charsPerSecond} should be the measured ${expected}`
  );
  // One job of the same size is left, so the estimate is about ten seconds.
  assert.ok(view.json.estimateSeconds >= 9 && view.json.estimateSeconds <= 11, `got ${view.json.estimateSeconds}`);
});

test('batches carry their own progress, and finish exactly once', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const push = await libraryOf(dep, [
    { id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }, { id: 'two', markdown: chapterMarkdown('Two') }] },
  ]);
  const batchId = push.narration.batchId;
  assert.ok(batchId);

  let view = await dep.call('GET', '/api/admin/narration');
  let batch = view.json.batches.find((b) => b.id === batchId);
  assert.equal(batch.total, 2);
  assert.equal(batch.pending, 2);
  assert.equal(batch.notifiedAt, null);
  assert.match(batch.label, /content API batch/);

  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 2 });
  assert.equal(claim.json.jobs.length, 2);

  const first = await dep.call('POST', `/api/admin/narration/jobs/${claim.json.jobs[0].id}/complete`, {
    audio: claim.json.jobs[0].audioKey,
    timings: claim.json.jobs[0].timingsKey,
    durationMs: 1000,
    contentHash: claim.json.jobs[0].contentHash,
  });
  assert.equal(first.json.batchFinished, false, 'one of two is not a finished batch');

  const second = await dep.call('POST', `/api/admin/narration/jobs/${claim.json.jobs[1].id}/complete`, {
    audio: claim.json.jobs[1].audioKey,
    timings: claim.json.jobs[1].timingsKey,
    durationMs: 1000,
    contentHash: claim.json.jobs[1].contentHash,
  });
  assert.equal(second.json.batchFinished, true);
  // No RESEND_API_KEY / ADMIN_EMAIL in this deployment, so no mail is sent —
  // and that is reported honestly rather than claimed.
  assert.equal(second.json.batch.notified, false);
  assert.equal(second.json.batch.reason, 'no_mail_configured');
  assert.equal(second.json.batch.done, 2);
  assert.equal(second.json.batch.failed, 0);

  view = await dep.call('GET', '/api/admin/narration');
  batch = view.json.batches.find((b) => b.id === batchId);
  assert.equal(batch.done, 2);
  assert.equal(batch.pending, 0);
  assert.ok(batch.notifiedAt !== null, 'the batch is stamped, so it can never notify twice');
});

test('a portal edit queues its own re-narration, and saving twice leaves one job', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // A library that already has audio, so a portal edit has something to make stale.
  await libraryOf(dep, [{ id: 'book-a', chapters: [{ id: 'one', markdown: chapterMarkdown('One') }] }]);
  const claim = await dep.call('POST', '/api/admin/narration/claim', { worker: 'runner-1', max: 1 });
  const job = claim.json.jobs[0];
  await dep.call('POST', `/api/admin/narration/jobs/${job.id}/complete`, {
    audio: job.audioKey,
    timings: job.timingsKey,
    durationMs: 1000,
    contentHash: job.contentHash,
  });
  assert.equal((await dep.call('GET', '/api/admin/narration')).json.counts.pending, 0);

  // Two saves in a row, as an author drafting would produce. The content API's
  // own PUT is the same saveChapter() the portal's editor calls.
  for (const text of ['A first draft of the correction.', 'A second draft of the correction.']) {
    const res = await dep.call('PUT', '/api/content/v1/books/book-a/chapters/one', {
      contractVersion: 1,
      managed: false,
      markdown: chapterMarkdown('One', text),
    });
    assert.equal(res.status, 200, res.text);
  }

  const view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.json.counts.pending, 1, 'two saves leave one job, for the text the author stopped on');
  const manifest = await dep.manifest();
  assert.equal(manifest.books[0].chapters[0].audioStale, true, 'the words moved and the voice did not — stated, not hidden');
  assert.equal(view.json.jobs.find((j) => j.status === 'pending').contentHash, manifest.books[0].chapters[0].contentHash);
});

test('a deployment whose database predates the migration reports a fix instead of a 500', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  dep.db.exec('DROP TABLE narration_jobs');
  dep.db.exec('DROP TABLE narration_batches');

  const view = await dep.call('GET', '/api/admin/narration');
  assert.equal(view.status, 200, 'a missing table is a state, not a crash');
  assert.equal(view.json.available, false);
  assert.match(view.json.message, /migrations/);
  assert.equal(view.json.runtime.canProcessInDeployment, false);

  // And a push still publishes the text; only the queueing degrades.
  const push = await dep.call('PUT', '/api/content/v1/books/book-a', {
    contractVersion: 1,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });
  assert.equal(push.status, 200, push.text);
  assert.equal(push.json.summary.chaptersSucceeded, 1);
  assert.equal(push.json.narration.queued, 0);
  assert.match(push.json.narration.message, /text was published/);
});
