// Forced word alignment for the bundled Kokoro narrator.
//
// The Kokoro ONNX export emits only the waveform — the model's internal
// per-phoneme durations are not an output — so exact word timings can't come
// from synthesis itself. Instead we align the synthesized audio against the
// known text with Whisper (tiny.en, ~40 MB, downloaded once like the Kokoro
// model itself) using word-level timestamps: the text is ground truth, Whisper
// supplies the clock. Words Whisper garbles (numbers, archaic spellings) are
// interpolated between the surrounding anchors using the estimator's
// proportions, so output is always complete and monotonic.

let asrPromise = null;
async function loadAligner() {
  if (!asrPromise) {
    // The _timestamped export ships the cross-attentions that word-level
    // timestamps require (the plain export doesn't).
    asrPromise = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en_timestamped', { dtype: 'q8' })
    );
  }
  return asrPromise;
}

const normalize = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Refines estimated word timings against the actual audio.
 *
 * @param pcm        Float32Array mono PCM of one block
 * @param sampleRate PCM sample rate
 * @param text       the block's plain text
 * @param estWords   estimated timings [[charStart, charEnd, msStart, msEnd], …]
 * @returns          same-shape timings, Whisper-anchored
 */
export async function alignWords(pcm, sampleRate, text, estWords) {
  if (estWords.length === 0) return estWords;
  const asr = await loadAligner();

  // Whisper expects 16 kHz input.
  const resampled = sampleRate === 16000 ? pcm : resampleLinear(pcm, sampleRate, 16000);
  const result = await asr(resampled, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: 'word',
  });
  const heard = (result.chunks ?? [])
    .map((c) => ({ word: normalize(c.text), start: c.timestamp[0], end: c.timestamp[1] }))
    .filter((c) => c.word && c.start != null && c.end != null);
  if (heard.length === 0) return estWords;

  const wanted = estWords.map(([cs, ce]) => normalize(text.slice(cs, ce)));

  // Needleman–Wunsch over the two word sequences: our text is ground truth,
  // Whisper's transcript supplies times for every matched word.
  const matches = alignSequences(wanted, heard.map((h) => h.word));

  const anchors = new Map(); // estWords index -> { startMs, endMs }
  for (const [i, j] of matches) {
    anchors.set(i, { startMs: heard[j].start * 1000, endMs: heard[j].end * 1000 });
  }

  // Fill gaps by scaling the estimator's proportions between anchors; clamp to
  // keep the sequence monotonic even when Whisper's chunk seams jitter.
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < estWords.length; i++) {
    const [cs, ce, estS, estE] = estWords[i];
    let s;
    let e;
    const a = anchors.get(i);
    if (a) {
      s = a.startMs;
      e = Math.max(a.endMs, a.startMs + 1);
    } else {
      const next = nextAnchor(anchors, i, estWords.length);
      const prev = prevAnchorEnd(anchors, i) ?? { at: -1, ms: 0, estMs: 0 };
      const span = next
        ? { ms: next.ms - prev.ms, estMs: next.estMs - prev.estMs }
        : null;
      const scale = span && span.estMs > 0 ? span.ms / span.estMs : 1;
      s = prev.ms + (estS - prev.estMs) * scale;
      e = prev.ms + (estE - prev.estMs) * scale;
    }
    s = Math.max(s, prevEnd);
    e = Math.max(e, s + 1);
    prevEnd = e;
    out.push([cs, ce, Math.round(s), Math.round(e)]);
  }
  return out;

  function prevAnchorEnd(map, i) {
    for (let k = i - 1; k >= 0; k--) {
      if (map.has(k)) return { at: k, ms: map.get(k).endMs, estMs: estWords[k][3] };
    }
    return null;
  }
  function nextAnchor(map, i, n) {
    for (let k = i + 1; k < n; k++) {
      if (map.has(k)) return { at: k, ms: map.get(k).startMs, estMs: estWords[k][2] };
    }
    return null;
  }
}

/** Global sequence alignment; returns matched index pairs [iWanted, jHeard]. */
function alignSequences(a, b) {
  const MATCH = 2;
  const FUZZY = 1;
  const GAP = -1;
  const MISS = -1;
  const score = (x, y) => {
    if (x === y) return MATCH;
    if (x.length > 3 && y.length > 3 && (x.startsWith(y.slice(0, 3)) || y.startsWith(x.slice(0, 3)))) return FUZZY;
    return MISS;
  };
  const n = a.length;
  const m = b.length;
  // Score matrix in a flat typed array; traceback re-derives moves from scores.
  const S = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) S[at(i, 0)] = i * GAP;
  for (let j = 1; j <= m; j++) S[at(0, j)] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      S[at(i, j)] = Math.max(
        S[at(i - 1, j - 1)] + score(a[i - 1], b[j - 1]),
        S[at(i - 1, j)] + GAP,
        S[at(i, j - 1)] + GAP
      );
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (S[at(i, j)] === S[at(i - 1, j - 1)] + score(a[i - 1], b[j - 1])) {
      if (a[i - 1] === b[j - 1] || score(a[i - 1], b[j - 1]) === FUZZY) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (S[at(i, j)] === S[at(i - 1, j)] + GAP) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** Cheap linear resampler — alignment doesn't need audiophile quality. */
function resampleLinear(pcm, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0);
  }
  return out;
}
