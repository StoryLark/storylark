// Stateless-publish helpers (AB#7654 — "make repository sync automatic,
// stateless, and narration-safe").
//
// ── The problem these exist to solve ────────────────────────────────────────
// publish.mjs keys everything off the machine-local ledger
// `.storylark/state/<bucket>.json`. On a fresh runner (a CI job, a second
// laptop, anything that has never published this bucket before) that ledger
// is empty, so every chapter looks "changed" even when its published text is
// byte-identical, and `detectConflicts()` flags every already-live chapter as
// a conflict with base "(never published from this machine)".
//
// The fix is NOT a content-hash change (an id-independent hash was evaluated
// and rejected — it would re-key every immutable object already in storage).
// It is cheaper: when local state has nothing for a chapter, reconstruct what
// local state WOULD have said by reading the live manifest and the live
// chapter content this run is about to overwrite. That reconstructed object
// is used only in memory, for one run — it is never written back to the state
// file as though this machine had published it.
//
// These functions are pure (no fs/network) so the reconstruction rule can be
// tested directly, independent of --local fixtures and CLI spawning.

/**
 * Extract the hash embedded in a hashed artifact path.
 *
 * Every artifact publish.mjs uploads for a chapter follows
 * `<...>/<chapterId>.<hash>[.<voice>].<ext>` — e.g.
 *   books/b/audio/ch.a1b2c3d4.mp3            (primary voice)
 *   books/b/audio/ch.a1b2c3d4.bm_fable.mp3   (extra voice)
 *   books/b/timings/ch.a1b2c3d4.json
 *
 * The chapter id is passed in explicitly (rather than guessed) because chapter
 * ids are drawn from the same id charset as everything else here and cannot
 * contain a `.`, which is what makes this split unambiguous.
 */
export function hashFromArtifactPath(chapterId, path) {
  if (typeof path !== 'string' || !path) return undefined;
  const base = path.split('/').pop().replace(/\.(mp3|json)$/i, '');
  const prefix = `${chapterId}.`;
  const rest = base.startsWith(prefix) ? base.slice(prefix.length) : base;
  return rest.split('.')[0] || undefined;
}

/**
 * Rebuild the `audio` / `voices` shape `state.chapters[key]` would carry, from
 * the LIVE manifest's chapter entry alone (no extra fetch needed — the
 * manifest already names every audio/timings path and duration).
 *
 * Returns `{ audio: null, voices: undefined }` for a text-only live chapter,
 * which is exactly what state has always recorded for one.
 */
export function reconstructAudioFromLive(liveChapterEntry, chapterId, primaryVoice) {
  if (!liveChapterEntry?.hasAudio) return { audio: null, voices: undefined };
  const hash = hashFromArtifactPath(chapterId, liveChapterEntry.audio) ?? liveChapterEntry.contentHash;
  const audio = { durationMs: liveChapterEntry.audioDurationMs ?? 0, hash };
  const liveVoices = liveChapterEntry.voices && typeof liveChapterEntry.voices === 'object' ? liveChapterEntry.voices : null;
  const voices = liveVoices
    ? Object.fromEntries(
        Object.keys(liveVoices)
          .filter((v) => v !== primaryVoice)
          .map((v) => [v, { durationMs: liveChapterEntry.audioDurationMs ?? 0 }])
      )
    : undefined;
  return { audio, voices };
}

/**
 * Reconstruct the "previous" object a stateless run is missing for one
 * chapter — the shape `state.chapters[key]` has always had — from the live
 * manifest entry plus that chapter's fetched live content JSON.
 *
 * This becomes `prev` everywhere `state.chapters[key]` used to be read
 * directly: the `previous` map threaded into the parser (so
 * `stabilizeBlockIds` inherits the SAME block ids the live chapter already
 * has, not a fresh sequential set), the changed/conflict-base comparison, and
 * the audio/voices carry-forward. One reconstruction, three call sites fixed.
 */
export function reconstructPreviousFromLive(liveChapterEntry, contentJson, chapterId, primaryVoice) {
  const { audio, voices } = reconstructAudioFromLive(liveChapterEntry, chapterId, primaryVoice);
  return {
    hash: liveChapterEntry.contentHash,
    blocks: contentJson.blocks,
    audio,
    voices,
    publishedAt: liveChapterEntry.publishedAt,
  };
}

/** Find a chapter's manifest entry, or undefined if the book/chapter isn't live. */
export function findLiveChapterEntry(liveManifest, bookId, chapterId) {
  const book = (liveManifest?.books ?? []).find((b) => b.id === bookId);
  return book?.chapters?.find((c) => c.id === chapterId);
}
