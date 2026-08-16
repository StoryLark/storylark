// A minimal ZIP reader and writer, with no dependencies and no platform APIs
// beyond the web streams every StoryLark runtime already has.
//
// ── Why hand-rolled ─────────────────────────────────────────────────────────
// A theme package is a zip (plan §0c), and the SAME bytes have to be produced
// by a Node CLI and consumed inside a Cloudflare Worker. The usual libraries
// solve one half of that: JSZip and adm-zip are ~100KB of dependency for what
// is, at this scope, two well-documented record layouts; `node:zlib` and
// `unzipper` don't exist in a Worker at all. What DOES exist in both — and in
// Node 18+, Deno, Bun and every modern browser — is `CompressionStream` /
// `DecompressionStream` with `deflate-raw`, which is exactly the compression
// format a zip entry uses. So the only thing left to write is the framing.
//
// ── The deliberate limits ───────────────────────────────────────────────────
// This handles the subset a theme package is, and REFUSES the rest loudly
// rather than half-supporting it:
//
//   • Store (method 0) and deflate (method 8). Nothing else.
//   • No ZIP64. A 4GB theme is not a theme.
//   • No encryption, no multi-disk, no data descriptors on read (the general
//     purpose bit-3 case) — sizes come from the central directory, which is
//     authoritative and which every writer including this one fills in.
//   • Entry names are validated by the caller (see theme-package.mjs); this
//     module refuses absolute paths and `..` segments itself as well, because
//     a zip reader that can be talked into writing outside its destination is
//     the single most common vulnerability in this file format and the check
//     belongs at the lowest layer that can make it.
//
// CRC32 is computed and CHECKED on read. A truncated upload is the most likely
// real failure here, and it is exactly what a checksum catches.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Default ceilings. The theme-package layer applies its own, tighter, ones. */
export const ZIP_LIMITS = {
  maxEntries: 256,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

// ── CRC32 ───────────────────────────────────────────────────────────────────

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── compression ─────────────────────────────────────────────────────────────

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function deflateRaw(bytes) {
  return through(bytes, new CompressionStream('deflate-raw'));
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function inflateRaw(bytes) {
  return through(bytes, new DecompressionStream('deflate-raw'));
}

async function through(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── writing ─────────────────────────────────────────────────────────────────

/**
 * Build a zip from an ordered list of entries.
 *
 * Deterministic on purpose: no timestamps are taken from the clock (every
 * entry is stamped with a fixed DOS date unless one is given), so packaging the
 * same brand folder twice produces byte-identical output. That is what makes
 * "did this package change?" answerable with a hash instead of a diff, and it
 * keeps a committed default package from churning on every rebuild.
 *
 * @param {{ name: string, data: Uint8Array | string, store?: boolean }[]} entries
 * @param {{ date?: Date }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function zip(entries, opts = {}) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosStamp(opts.date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name;
    assertSafeName(name);
    const nameBytes = encoder.encode(name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(raw);

    // Compress unless told not to, and keep whichever is smaller. PNG and WebP
    // are already deflated internally; re-deflating them reliably makes the
    // entry BIGGER, which is a strange thing for a "compressed" archive to do.
    let method = METHOD_STORE;
    let body = raw;
    if (!entry.store) {
      const deflated = await deflateRaw(raw);
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    chunks.push(local, body);
    central.push({ name: nameBytes, method, crc, csize: body.length, usize: raw.length, offset });
    offset += local.length + body.length;
  }

  const centralStart = offset;
  for (const e of central) {
    const rec = new Uint8Array(46 + e.name.length);
    const cv = new DataView(rec.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.csize, true);
    cv.setUint32(24, e.usize, true);
    cv.setUint16(28, e.name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, e.offset, true);
    rec.set(e.name, 46);
    chunks.push(rec);
    offset += rec.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, offset - centralStart, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);

  return concat(chunks);
}

// ── reading ─────────────────────────────────────────────────────────────────

/**
 * Read a zip into a Map of entry name → bytes.
 *
 * Throws `ZipError` with a message written for an operator staring at a failed
 * upload, not for a developer reading a stack trace — this runs behind an HTTP
 * endpoint and its message is what the portal shows.
 *
 * @param {Uint8Array | ArrayBuffer} input
 * @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzip(input, limits = {}) {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...ZIP_LIMITS, ...limits };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > maxTotalBytes) {
    throw new ZipError(`That file is ${mb(bytes.length)}; the limit is ${mb(maxTotalBytes)}.`);
  }
  if (bytes.length < 22) throw new ZipError('That file is too small to be a zip archive.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  if (eocd < 0) {
    throw new ZipError(
      'That file is not a zip archive (no end-of-central-directory record). If you renamed a folder to .zip, compress it instead.'
    );
  }

  const count = view.getUint16(eocd + 10, true);
  const centralStart = view.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new ZipError(`That archive has ${count} entries; the limit is ${maxEntries}.`);
  if (centralStart >= bytes.length) throw new ZipError('That archive is truncated — its central directory is past the end of the file.');

  const decoder = new TextDecoder();
  const out = new Map();
  let pos = centralStart;
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== CENTRAL_SIG) {
      throw new ZipError('That archive is damaged — its central directory ends early.');
    }
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const csize = view.getUint32(pos + 20, true);
    const usize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory record — the names carry the structure
    assertSafeName(name);
    if (usize > maxEntryBytes) throw new ZipError(`"${name}" is ${mb(usize)}; the per-file limit is ${mb(maxEntryBytes)}.`);
    total += usize;
    if (total > maxTotalBytes) throw new ZipError(`That archive expands to more than ${mb(maxTotalBytes)}.`);

    // The local header's name/extra lengths can legitimately differ from the
    // central directory's, so the data offset is computed from the LOCAL header
    // rather than assumed.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new ZipError(`That archive is damaged — no local header for "${name}".`);
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + csize > bytes.length) throw new ZipError(`That archive is truncated — "${name}" runs past the end of the file.`);
    const stored = bytes.subarray(dataStart, dataStart + csize);

    let data;
    if (method === METHOD_STORE) {
      data = stored.slice();
    } else if (method === METHOD_DEFLATE) {
      try {
        data = await inflateRaw(stored);
      } catch {
        throw new ZipError(`"${name}" could not be decompressed — the archive is corrupt.`);
      }
    } else {
      throw new ZipError(
        `"${name}" uses compression method ${method}, which StoryLark does not read. Re-create the archive with a standard zip tool (deflate).`
      );
    }
    if (data.length !== usize || crc32(data) !== crc) {
      throw new ZipError(`"${name}" failed its checksum — the upload is incomplete or the archive is corrupt.`);
    }
    out.set(name, data);
  }
  return out;
}

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * Refuse anything that could escape the destination, plus the Windows-hostile
 * names that would make a package unusable for half the people who download it.
 */
export function assertSafeName(name) {
  if (!name || name.length > 200) throw new ZipError(`"${name}" is not a usable entry name.`);
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
    throw new ZipError(`"${name}" is an absolute path; theme packages use paths relative to the archive root.`);
  }
  if (name.includes('\\')) throw new ZipError(`"${name}" uses backslashes; zip entry names use "/".`);
  if (name.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new ZipError(`"${name}" contains a relative path segment, which is not allowed.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"|?*]/.test(name)) throw new ZipError(`"${name}" contains characters that are not valid in a file name.`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function findEocd(bytes, view) {
  // The EOCD is the last 22 bytes unless there is an archive comment; scan back
  // over the maximum comment length (0xffff) and no further.
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/** MS-DOS date/time. Fixed default so packaging is reproducible — see zip(). */
function dosStamp(date) {
  const d = date ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (Math.floor(d.getUTCSeconds() / 2) & 0x1f);
  const dosDate = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { dosTime, dosDate };
}

function concat(chunks) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function mb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}
