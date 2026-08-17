// The StoryLark content contract (SCF) — ONE validator, three transports
// (AB#7420 — content-management rework, wave 1).
//
// ── The governing architecture ──────────────────────────────────────────────
// The admin portal, a synced git repo and the public content API are
// TRANSPORTS over one content standard. A transport's entire job is to produce
// a *candidate record* — identity, frontmatter, markdown — and hand it here.
// This module is the only place validity is decided:
//
//   • It never guesses and never repairs. A missing required field is an
//     error, not a reason to fall back to a filename.
//   • The same input produces the same errors whichever transport called it.
//     Only the RENDERING differs: inline in the portal, skipped-and-listed in
//     a sync report, 422 from the API.
//   • Every error carries a stable `code`, a human `message`, and a location
//     (`file` + `line`) where the transport could supply one.
//
// Nothing downstream of this gate may branch on which transport delivered the
// content.
//
// ── The `storylark:` frontmatter block — normative ──────────────────────────
// Strict, namespaced, ADDITIVE: a customer's own frontmatter is untouched and
// their own build ignores the extra key. The governing rule for repo content:
// **a file without a `storylark:` block is not StoryLark content** (that is
// what `requireBlock` enforces — the repo transport sets it; the portal and
// API transports don't, because there the identity arrives with the request).
//
//   storylark:
//     type: chapter          # book | chapter | story        (required)
//     book: the-voyage-home  # id — required for `chapter`
//     chapter: going-east    # id — required for `chapter`
//     order: 1               # integer — required for `chapter`; ties are an error
//     publish: true          # optional, default true; false withholds it
//     title: Going East      # optional — overrides top-level title, then # H1
//     cover: images/a.png    # optional — path relative to the file, never a URL
//     contractVersion: 1     # optional, default 1
//
//   • `type: story` — a book with exactly one chapter in one file;
//     book/chapter/order then optional.
//   • `type: book` — book metadata only, no prose. Optional per book.
//   • Ids: lowercase [a-z0-9-], stable. Changing an id creates a new object.
//   • `order`: integers, gaps fine, ties rejected. Filename prefixes are
//     never consulted where a block declares order — explicit beats implicit.
//
// ── Why this lives in storylark-contracts ───────────────────────────────────
// Same reason as validate.mjs: the Worker (portal + API transports) and the
// Node pipeline (repo transport, `storylark validate` CLI-to-come) both need
// it, and two copies would be two answers to "is this content valid". The
// frontmatter *boundary* here is byte-identical to the one in
// packages/pipeline/lib/md.mjs and packages/worker/src/lib/md.ts, and
// packages/worker/test/content-contract.test.mjs asserts that over the same
// corpus md-parity.test.mjs uses — this must never become a third divergent
// markdown implementation, so it parses no prose at all: block conventions,
// spans and hashes stay in md.mjs/md.ts.

/** Highest `storylark.contractVersion` this engine reads. Moves only on a breaking reshape. */
export const CONTENT_CONTRACT_VERSION = 1;

/** Ids are storage keys and URL segments; keep them boring. Same rule everywhere. */
export const CONTENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Per-chapter source ceiling, shared with the content API's limits. */
export const MAX_CHAPTER_SOURCE_BYTES = 2_000_000;

/**
 * What every transport says when `storylark.publish: false` withholds a
 * chapter. Not an error — the content is valid, its own frontmatter just says
 * "not yet" — so it is a shared sentence rather than a shared error code, and
 * NOTHING is written: withholding half-writes nothing.
 */
export const PUBLISH_WITHHELD_MESSAGE =
  'Withheld, not published: this file sets `storylark.publish: false`. Nothing was written — remove the flag or set it to true to publish.';

/**
 * The one error vocabulary. Stable codes: a transport may choose how to RENDER
 * one of these, never to rename it. Every code here is exercised by
 * packages/worker/test/content-contract.test.mjs.
 */
export const CONTENT_ERROR_CODES = Object.freeze([
  'empty_chapter',
  'too_large',
  'unclosed_frontmatter',
  'no_prose',
  'missing_storylark_block',
  'invalid_storylark_block',
  'missing_field',
  'unknown_type',
  'type_mismatch',
  'invalid_id',
  'id_mismatch',
  'invalid_order',
  'order_tie',
  'invalid_publish',
  'invalid_title',
  'invalid_cover',
  'invalid_contract_version',
  'unsupported_contract_version',
  // Manifest-context rejections (design §10.5 / §10.7): the gate itself is
  // pure, so these are produced by the helpers below, which every transport
  // with storage context calls — same codes, same messages, whichever door.
  'unknown_book',
  'book_owned_elsewhere',
]);

// Byte-identical to readFrontmatter's boundary in md.mjs / md.ts (BOM strip
// included). content-contract.test.mjs holds all three to the same corpus.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function err(code, message, where = {}) {
  const e = { code, message };
  if (where.file !== undefined) e.file = where.file;
  if (where.line !== undefined) e.line = where.line;
  if (where.field !== undefined) e.field = where.field;
  return e;
}

/**
 * Split a markdown source at the frontmatter fence, exactly as
 * readFrontmatter does — exported so the parity test can prove it.
 * `line` is the 1-based line the BODY starts on.
 */
export function splitFrontmatter(source) {
  const src = String(source).replace(/^﻿/, '');
  const match = FRONTMATTER_RE.exec(src);
  if (!match) return { frontmatter: null, body: src, bodyLine: 1 };
  const bodyLine = (match[0].match(/\n/g) ?? []).length + 1;
  return { frontmatter: match[1], body: src.slice(match[0].length), bodyLine };
}

/** Scalar coercion, byte-identical to readFrontmatter's: quotes stripped, true/false, bare integers. */
function scalar(raw) {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Read the `storylark:` block out of a file's frontmatter — the ONLY nested
 * frontmatter key StoryLark reads, and the only implementation that reads it.
 * (readFrontmatter in md.mjs/md.ts deliberately skips nested keys, so this is
 * new parsing, not a duplicate of existing parsing.)
 *
 * Returns `{ present, fields, fieldLines, line, errors }`. Structural problems
 * — an inline value, an unreadable line, a duplicated key or a second block —
 * are `invalid_storylark_block` errors with the offending line number. Unknown
 * fields inside the block are IGNORED, the same forward-compatibility rule
 * every other StoryLark contract follows: a file written for a newer engine
 * must load on an older one.
 */
export function readStorylarkBlock(source, where = {}) {
  const { frontmatter } = splitFrontmatter(source);
  if (frontmatter === null) return { present: false, fields: {}, fieldLines: {}, line: 0, errors: [] };

  const lines = frontmatter.split(/\r?\n/);
  const errors = [];
  let present = false;
  let blockLine = 0;
  const fields = {};
  const fieldLines = {};

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 2; // line 1 is the opening ---
    const head = /^storylark:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    if (present) {
      errors.push(err('invalid_storylark_block', 'This file has two `storylark:` blocks. Keep exactly one.', { ...where, line: lineNo }));
      continue;
    }
    present = true;
    blockLine = lineNo;
    if (head[1].trim() !== '') {
      errors.push(
        err('invalid_storylark_block', '`storylark:` must introduce an indented block of fields, not carry a value of its own.', {
          ...where,
          line: lineNo,
        })
      );
      continue;
    }
    // Consume the indented lines that follow. A blank line is tolerated inside
    // the block only when an indented line follows it.
    let j = i + 1;
    while (j < lines.length) {
      const raw = lines[j];
      if (raw.trim() === '') {
        const next = lines.slice(j + 1).find((l) => l.trim() !== '');
        if (next !== undefined && /^[ \t]/.test(next)) {
          j++;
          continue;
        }
        break;
      }
      if (!/^[ \t]/.test(raw)) break; // back to top level — block over
      const kv = /^[ \t]+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
      const fieldLineNo = j + 2;
      if (!kv) {
        errors.push(
          err(
            'invalid_storylark_block',
            `Line ${fieldLineNo} of the front matter is inside the \`storylark:\` block but is not a \`field: value\` pair. The block holds flat fields only.`,
            { ...where, line: fieldLineNo }
          )
        );
        j++;
        continue;
      }
      if (kv[2].trim() === '') {
        errors.push(
          err('invalid_storylark_block', `\`storylark.${kv[1]}\` has no value. The block holds flat \`field: value\` pairs only — nothing nests deeper.`, {
            ...where,
            line: fieldLineNo,
            field: kv[1],
          })
        );
        j++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(fields, kv[1])) {
        errors.push(
          err('invalid_storylark_block', `\`storylark.${kv[1]}\` appears twice. A duplicated field is never silently resolved.`, {
            ...where,
            line: fieldLineNo,
            field: kv[1],
          })
        );
        j++;
        continue;
      }
      fields[kv[1]] = scalar(kv[2]);
      fieldLines[kv[1]] = fieldLineNo;
      j++;
    }
    i = j - 1;
  }

  return { present, fields, fieldLines, line: blockLine, errors };
}

/**
 * Is this file a candidate for repo ingestion at all? The governing rule — a
 * file without a `storylark:` block is not StoryLark content — plus its one
 * honest edge: a file whose frontmatter fence never closes has no readable
 * block, but if the broken frontmatter MENTIONS `storylark:` it is a broken
 * candidate, not a bystander, and silently ignoring it would turn a missing
 * `---` into content quietly vanishing. The transport asks this one question
 * and hands candidates to the gate; the judgement lives here so no transport
 * grows its own opinion of what counts.
 */
export function isRepoCandidate(source) {
  const src = String(source).replace(/^﻿/, '');
  if (readStorylarkBlock(src).present) return true;
  return /^---\r?\n/.test(src) && !FRONTMATTER_RE.test(src) && /^storylark:/m.test(src);
}

const TYPES = new Set(['book', 'chapter', 'story']);

function checkId(value, field, line, where, errors) {
  if (typeof value !== 'string' || !CONTENT_ID_RE.test(value)) {
    errors.push(
      err(
        'invalid_id',
        `\`storylark.${field}\`: "${String(value)}" is not a usable id. Ids are 1-64 characters of lowercase letters, digits or hyphens, starting with a letter or digit — they are storage keys and URL segments.`,
        { ...where, line, field }
      )
    );
    return false;
  }
  return true;
}

/**
 * Validate ONE candidate record — the unit every transport produces.
 *
 * candidate:
 *   file       where it came from, for error locations (optional)
 *   bookId     book identity the TRANSPORT supplied (URL segment, form field,
 *              folder name — layout, not inference) (optional)
 *   chapterId  chapter identity the transport supplied (optional)
 *   order      position the transport supplied (array index, chapter list)
 *              — a block's own `order` overrides it: explicit beats implicit
 *   markdown   the source, frontmatter included (required)
 *
 * opts:
 *   requireBlock  the strict repo rule: a file without a `storylark:` block is
 *                 not StoryLark content. The repo transport sets it; portal and
 *                 API don't, which is what keeps every pre-block chapter in
 *                 both live deployments valid — grandfathering by design, not
 *                 by leniency in the gate.
 *
 * Returns `{ ok: true, record, errors: [] }` or `{ ok: false, errors }`.
 * The normalised record: { type, book, chapter, order, publish, title, cover,
 * contractVersion, declared } — `declared` says whether a `storylark:` block
 * stated it (strict content) or the transport did (grandfathered content).
 */
export function validateChapterCandidate(candidate, opts = {}) {
  const where = candidate.file !== undefined ? { file: candidate.file } : {};
  const errors = [];
  const markdown = candidate.markdown;

  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { ok: false, errors: [err('empty_chapter', 'The chapter is empty.', { ...where, line: 1 })] };
  }
  if (markdown.length > MAX_CHAPTER_SOURCE_BYTES) {
    errors.push(err('too_large', 'That chapter is larger than 2MB, which is past what this contract accepts.', { ...where, line: 1 }));
  }
  const opens = /^﻿?---\r?\n/.test(markdown);
  if (opens && !/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(markdown)) {
    errors.push(err('unclosed_frontmatter', 'The front matter block starts with --- but never closes. Add a closing --- line.', { ...where, line: 1 }));
    return { ok: false, errors };
  }

  // Transport-supplied identity is an explicit statement, but it is still
  // identity, and the id rule has one home. A URL segment or a filename that
  // cannot be a storage key is refused HERE rather than by each transport
  // spelling the rule again.
  if (candidate.bookId !== undefined && !CONTENT_ID_RE.test(String(candidate.bookId))) {
    errors.push(
      err(
        'invalid_id',
        `"${String(candidate.bookId)}" is not a usable book id. Ids are 1-64 characters of lowercase letters, digits or hyphens, starting with a letter or digit — they are storage keys and URL segments.`,
        { ...where, line: 1 }
      )
    );
  }
  if (candidate.chapterId !== undefined && !CONTENT_ID_RE.test(String(candidate.chapterId))) {
    errors.push(
      err(
        'invalid_id',
        `"${String(candidate.chapterId)}" is not a usable chapter id. Ids are 1-64 characters of lowercase letters, digits or hyphens, starting with a letter or digit — they are storage keys and URL segments.`,
        { ...where, line: 1 }
      )
    );
  }

  const { body } = splitFrontmatter(markdown);
  const block = readStorylarkBlock(markdown, where);
  errors.push(...block.errors);

  if (!block.present) {
    if (opts.requireBlock) {
      errors.push(
        err(
          'missing_storylark_block',
          'This file has no `storylark:` block, so it is not StoryLark content and is never ingested from a repo. Add the block — StoryLark content is opt-in, never inferred. See docs/authoring-stories.md.',
          { ...where, line: 1 }
        )
      );
      return { ok: false, errors };
    }
    // Grandfathered / transport-identified content: the transport stated the
    // identity, the file states the words. This is every chapter both live
    // deployments already hold.
    if (body.trim() === '') {
      errors.push(err('no_prose', 'There is no text in this chapter — only front matter.', { ...where, line: 1 }));
    }
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      errors: [],
      record: {
        type: 'chapter',
        book: candidate.bookId,
        chapter: candidate.chapterId,
        order: Number.isInteger(candidate.order) ? candidate.order : undefined,
        publish: true,
        title: undefined,
        cover: undefined,
        contractVersion: 1,
        declared: false,
      },
    };
  }

  const f = block.fields;
  const at = (field) => ({ ...where, line: block.fieldLines[field] ?? block.line, field });

  // type — the one field nothing works without.
  let type;
  if (f.type === undefined) {
    errors.push(err('missing_field', '`storylark.type` is required — "book", "chapter" or "story".', { ...at('type') }));
  } else if (typeof f.type !== 'string' || !TYPES.has(f.type)) {
    errors.push(err('unknown_type', `\`storylark.type\` must be "book", "chapter" or "story" — got "${String(f.type)}".`, at('type')));
  } else {
    type = f.type;
  }

  // Required-for-chapter fields. The transport's identity satisfies book /
  // chapter / order (a URL segment or an array position is an explicit
  // statement, not a guess); the block's own values win where both exist, and
  // disagreement is an error, never a quiet preference.
  let book;
  let chapter;
  let order;
  let declaredOrder;

  if (f.book !== undefined) {
    if (checkId(f.book, 'book', at('book').line, where, errors)) book = f.book;
  } else if (candidate.bookId !== undefined) {
    book = candidate.bookId;
  }
  if (f.chapter !== undefined) {
    if (checkId(f.chapter, 'chapter', at('chapter').line, where, errors)) chapter = f.chapter;
  } else if (candidate.chapterId !== undefined) {
    chapter = candidate.chapterId;
  }
  if (f.order !== undefined) {
    if (typeof f.order !== 'number' || !Number.isInteger(f.order)) {
      errors.push(err('invalid_order', `\`storylark.order\` must be an integer — got "${String(f.order)}". Gaps are fine; ties are an error.`, at('order')));
    } else {
      order = f.order;
      declaredOrder = f.order;
    }
  } else if (Number.isInteger(candidate.order)) {
    order = candidate.order;
  }

  // In repo mode the folder tree is organisation, never meaning — so a
  // `type: book` file has nothing to inherit an id from and must name its own
  // book. The portal and the API address a book in the request itself, which
  // is why this is required only where no transport identity exists.
  if (type === 'book' && opts.requireBlock && book === undefined && f.book === undefined) {
    errors.push(
      err(
        'missing_field',
        '`storylark.book` is required for type "book" in a repo: the folder name is organisation, not an id, so the file must say which book it declares.',
        at('book')
      )
    );
  }

  if (type === 'chapter') {
    if (book === undefined && f.book === undefined) {
      errors.push(err('missing_field', '`storylark.book` is required for type "chapter": the id of the book this chapter belongs to.', at('book')));
    }
    if (chapter === undefined && f.chapter === undefined) {
      errors.push(err('missing_field', '`storylark.chapter` is required for type "chapter": this chapter\'s own id.', at('chapter')));
    }
    if (order === undefined && f.order === undefined) {
      errors.push(
        err(
          'missing_field',
          '`storylark.order` is required for type "chapter": an integer position in the book. Filename prefixes are not consulted — explicit beats implicit.',
          at('order')
        )
      );
    }
  }

  // Identity cross-checks: the block and the transport must agree.
  if (f.book !== undefined && candidate.bookId !== undefined && f.book !== candidate.bookId) {
    errors.push(
      err('id_mismatch', `The \`storylark:\` block says book "${String(f.book)}" but this content arrived addressed to book "${candidate.bookId}". They have to agree.`, at('book'))
    );
  }
  if (f.chapter !== undefined && candidate.chapterId !== undefined && f.chapter !== candidate.chapterId) {
    errors.push(
      err(
        'id_mismatch',
        `The \`storylark:\` block says chapter "${String(f.chapter)}" but this content arrived addressed to chapter "${candidate.chapterId}". They have to agree.`,
        at('chapter')
      )
    );
  }

  // Optional fields — validated strictly when present, defaulted per spec when
  // absent. A default from the spec is normalisation; anything else would be
  // repair, and the gate never repairs.
  let publish = true;
  if (f.publish !== undefined) {
    if (typeof f.publish !== 'boolean') {
      errors.push(err('invalid_publish', `\`storylark.publish\` must be true or false — got "${String(f.publish)}".`, at('publish')));
    } else {
      publish = f.publish;
    }
  }
  let title;
  if (f.title !== undefined) {
    if (typeof f.title !== 'string' || f.title.trim() === '') {
      errors.push(err('invalid_title', `\`storylark.title\` must be a non-empty string — got "${String(f.title)}". Quote it if it looks like a number or a boolean.`, at('title')));
    } else {
      title = f.title;
    }
  }
  let cover;
  if (f.cover !== undefined) {
    if (typeof f.cover !== 'string' || f.cover.trim() === '') {
      errors.push(err('invalid_cover', '`storylark.cover` must be a path.', at('cover')));
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(f.cover) || f.cover.startsWith('//')) {
      errors.push(
        err('invalid_cover', `\`storylark.cover\` must be a path relative to this file, not a URL — got "${f.cover}". Images are ingested into the deployment, never hotlinked.`, at('cover'))
      );
    } else {
      cover = f.cover;
    }
  }
  let contractVersion = 1;
  if (f.contractVersion !== undefined) {
    if (typeof f.contractVersion !== 'number' || !Number.isInteger(f.contractVersion) || f.contractVersion < 1) {
      errors.push(err('invalid_contract_version', `\`storylark.contractVersion\` must be a positive integer — got "${String(f.contractVersion)}".`, at('contractVersion')));
    } else if (f.contractVersion > CONTENT_CONTRACT_VERSION) {
      errors.push(
        err(
          'unsupported_contract_version',
          `\`storylark.contractVersion\` ${f.contractVersion} was written for a newer StoryLark engine — this one reads up to ${CONTENT_CONTRACT_VERSION}. Update the deployment, or state ${CONTENT_CONTRACT_VERSION}.`,
          at('contractVersion')
        )
      );
    } else {
      contractVersion = f.contractVersion;
    }
  }

  // Prose rules per type. A `book` file is metadata only; everything else must
  // actually say something.
  if (type === 'book') {
    if (body.trim() !== '') {
      errors.push(
        err('type_mismatch', 'A `storylark.type: book` file carries book metadata only, and this one has prose in the body. Move the prose into a chapter file.', {
          ...where,
          line: splitFrontmatter(markdown).bodyLine,
        })
      );
    }
    if (candidate.chapterId !== undefined) {
      errors.push(
        err('type_mismatch', 'This file declares `storylark.type: book` — book metadata, no prose — but it arrived addressed as a chapter.', at('type'))
      );
    }
  } else if (type !== undefined && body.trim() === '') {
    errors.push(err('no_prose', 'There is no text in this chapter — only front matter.', { ...where, line: 1 }));
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    record: { type, book, chapter, order, declaredOrder, publish, title, cover, contractVersion, declared: true },
  };
}

/**
 * Validate a whole book's worth of candidates together — each chapter through
 * `validateChapterCandidate`, plus the one rule that only exists between
 * chapters: **an `order` tie is an error, never silently resolved.**
 *
 * The tie check runs over DECLARED orders only (a `storylark:` block's own
 * `order:`), because transport-supplied positions are unique by construction —
 * an array has no ties to detect.
 *
 * **The stored manifest joins the tie check** (design §10.6): the caller passes
 * `bookCandidate.existingChapters` — the book's already-published chapters with
 * their declared orders, where they declared one — and a new chapter claiming
 * an order an incumbent already holds is the SAME `order_tie`, same message,
 * whether the incumbent arrived in this batch or last month. Two carve-outs,
 * both statements rather than inference: a chapter re-declaring the order it
 * already owns is not a tie, and an incumbent this same arrival re-declares is
 * judged by its new declaration, not its old one — an arrival is a set.
 *
 * Returns `{ ok, records, errors }`; `records[i]` is null where chapter i
 * failed. Callers wanting skip-and-report (a repo sync, a best-effort batch)
 * read per-chapter results; callers wanting all-or-nothing read `ok`.
 */
export function validateBookCandidate(bookCandidate, opts = {}) {
  const errors = [];
  const records = [];
  const chapters = bookCandidate.chapters ?? [];
  for (const chapter of chapters) {
    const result = validateChapterCandidate({ bookId: bookCandidate.bookId, ...chapter }, opts);
    errors.push(...result.errors);
    records.push(result.ok ? result.record : null);
  }

  const seen = new Map(); // declared order -> first claimant's name
  // Stored incumbents claim their orders first — they were there first. An
  // incumbent this arrival itself re-declares is skipped: its new statement is
  // already in `records`, and holding it to the superseded one would make the
  // check depend on what the book USED to say.
  const arrivalNames = new Set(records.filter(Boolean).map((r) => r.chapter).filter((c) => c !== undefined));
  for (const existing of bookCandidate.existingChapters ?? []) {
    if (!Number.isInteger(existing.order)) continue;
    if (existing.chapter !== undefined && arrivalNames.has(existing.chapter)) continue;
    if (!seen.has(existing.order)) seen.set(existing.order, existing.chapter ?? `order ${existing.order}`);
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.declaredOrder === undefined) continue;
    const name = chapters[i].file ?? record.chapter ?? `chapters[${i}]`;
    const prior = seen.get(record.declaredOrder);
    // Re-declaring the order this same chapter already owns is not a tie.
    if (prior !== undefined && prior !== record.chapter) {
      errors.push(
        err('order_tie', `"${prior}" and "${name}" both declare \`storylark.order: ${record.declaredOrder}\`. Order ties are an error, never silently resolved — renumber one of them.`, {
          ...(chapters[i].file !== undefined ? { file: chapters[i].file } : {}),
        })
      );
      records[i] = null;
    } else if (prior === undefined) {
      seen.set(record.declaredOrder, name);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Manifest-context rejections (design §10.5 / §10.7)
 *
 * The gate above is pure — it never reads storage — so the two rules that need
 * the library's current state are expressed as error BUILDERS here, called by
 * whichever transport holds that state. The codes and the sentences live in
 * this module for the same reason everything else does: the same collision must
 * read identically whichever door it came through.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §10.7 — a chapter naming a `book:` that neither the library holds nor this
 * arrival declares. The arrival is evaluated as a SET: the caller only builds
 * this error after checking the whole arrival for a `type: book` (or book push)
 * declaring the id, so file order can never matter.
 */
export function unknownBookError(bookId, where = {}) {
  return err(
    'unknown_book',
    `\`storylark.book: ${bookId}\` names a book this library does not hold, and nothing in this arrival declares it. ` +
      `Add a \`type: book\` file declaring "${bookId}" to the same arrival, or fix the id — a book is never auto-created from a reference.`,
    where
  );
}

/**
 * §10.5 — the first writer owns a `bookId`. A later arrival from a DIFFERENT
 * source is rejected with the owner named, because an error naming the owner is
 * a five-minute fix and a silent overwrite is two systems fighting forever.
 * `owner` is `{ origin, syncSource }` straight off the manifest entry.
 */
export function bookOwnedElsewhereError(bookId, owner, where = {}) {
  return err(
    'book_owned_elsewhere',
    `"${bookId}" already exists in this library and belongs to ${describeContentOwner(owner)}. ` +
      `The first writer owns a book id: pick a different id, or remove the book from its current owner first. Nothing from this arrival was written to it.`,
    where
  );
}

/** The owner of a book, in words a rejection can carry. */
export function describeContentOwner(owner) {
  const origin = typeof owner?.origin === 'string' ? owner.origin : 'cli';
  const source = owner?.syncSource;
  if (origin === 'sync' && source?.kind === 'git') {
    return `the git repository ${source.url}${source.ref ? ` (branch ${source.ref})` : ''}`;
  }
  if (origin === 'sync' && source?.kind === 'feed') return `the feed at ${source.url}`;
  if (origin === 'sync' && source?.kind === 'api') {
    return `${source.system || 'an external system'} pushing over the content API`;
  }
  if (origin === 'portal') return 'this deployment’s own portal (origin: portal)';
  return 'this deployment’s own publish pipeline (origin: cli)';
}
