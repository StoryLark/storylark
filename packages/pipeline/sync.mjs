#!/usr/bin/env node
// StoryLark content sync — pull from an external source of truth (AB#7422,
// plan §8: "large providers who already have a content system").
//
//   node packages/pipeline/sync.mjs --brand <id> [flags] [-- publish flags]
//
// ── What this is for ────────────────────────────────────────────────────────
// StoryLark's portal assumes it is the system of record for content. That suits
// a small shop with nothing else; it does not suit a publisher who already has a
// website repo or a CMS, and who is not going to re-author their catalogue here
// or accept two divergent copies of the truth. Verified against the two real
// sites this project came from: the stories were NEVER held in the player —
// a private writing repo publishes into a public website repo, and the player
// reads from that. Repo-as-source-of-truth is the normal case, not an exotic one.
//
// So: point a deployment at their source, pull on a schedule, and never offer to
// edit what we do not own. That last part is the rule the whole thing rests on —
// **whoever owns the content owns the edit button** — and it is enforced by the
// `origin: sync` this sets, which the admin portal refuses to write to.
//
// ── Exactly two connectors, and no bespoke ones, ever ───────────────────────
//   git   — a git repository of markdown in StoryLark's own folder-per-book
//           convention (docs/authoring-stories.md). Public, or private with a
//           read-only token.
//   feed  — the publisher's own system, over a small documented JSON contract
//           (docs/content-sync.md). Generic by construction: it is a list of
//           books and chapters with URLs to fetch markdown from, and it is
//           written against nobody's specific product.
//
// A publisher whose system fits neither shape uses the content API directly.
// "We'll write a connector for your CMS" is an unbounded commitment and the one
// part of this that could never be finished, so it is refused up front. Do not
// add a third kind here.
//
// ── How it publishes: through the real pipeline, not beside it ──────────────
// This file resolves a source and MATERIALISES it into a staging directory in
// the blessed markdown layout. Then it runs `publish.mjs` over that directory,
// unchanged. Everything downstream — change detection by content hash, TTS,
// force-alignment, stitching, upload, manifest-written-last, push notification —
// is the pipeline that already exists. There is no second publish path here, no
// second narration path, and no second manifest writer; a sync is an ordinary
// publish whose source happened to arrive over the network.
//
// That is also why sync runs HERE rather than inside the deployment: a Worker
// cannot run the TTS model, so an in-deployment sync could only ever produce
// silent, permanently audio-stale content for an entire catalogue. Schedule this
// wherever your publish already runs — see .github/workflows/sync.yml for a
// ready-made cron.
//
// ── Flags ───────────────────────────────────────────────────────────────────
//   --brand <id>        required — same brand id publish.mjs takes
//   --kind git|feed     which connector (default: from config)
//   --url <url>         repo URL (git) or feed URL (feed)
//   --ref <ref>         git only — branch or tag (default: the repo's default branch)
//   --path <subdir>     git only — subdirectory of the repo that contains books/
//   --dry-run           fetch and stage, report what was found, publish nothing
//   Anything after `--` is passed straight to publish.mjs (e.g. --no-audio,
//   --local <dir>, --book <id>, --storage azure-blob, --bucket <name>).
//
// ── Configuration ───────────────────────────────────────────────────────────
// Flags override environment, which overrides deployment/<brand>/deployment.json:
//
//   "sync": { "kind": "git", "url": "https://github.com/example/site.git",
//             "ref": "main", "path": "content" }
//
//   STORYLARK_SYNC_KIND / _URL / _REF / _PATH   same fields, from the environment
//   STORYLARK_SYNC_TOKEN                        read-only credential, ENV ONLY
//
// The token is never read from a file and never written to one. deployment.json
// is committed; a token in it would be a committed credential, so a `token` key
// there is a hard error rather than a warning.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));

/** Book and chapter ids are storage keys and URL segments — the same rule the
 *  Worker enforces (packages/worker/src/lib/content.ts ID_RE). A feed that
 *  offers something else is rejected loudly rather than sanitised quietly:
 *  silently renaming a publisher's ids would break every link they have. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const { flags, passthrough } = parseArgs(process.argv.slice(2));
const USAGE =
  'Usage: node packages/pipeline/sync.mjs --brand <id> [--kind git|feed] [--url <url>] [--ref <ref>] [--path <subdir>] [--dry-run] [-- <publish flags>]';

const brandId = flags.brand;
if (!brandId || typeof brandId !== 'string') {
  console.error(USAGE);
  process.exit(1);
}

const config = await resolveConfig(brandId, flags);
const token = (process.env.STORYLARK_SYNC_TOKEN ?? '').trim();

const stagingRoot = join(ROOT, '.storylark', 'sync', brandId);
await mkdir(stagingRoot, { recursive: true });

console.log(`Sync (${config.kind}) → ${redact(config.url)}${config.ref ? ` @ ${config.ref}` : ''}`);
const staged = config.kind === 'git' ? await stageFromGit(config) : await stageFromFeed(config);
console.log(`Staged ${staged.books} book(s), ${staged.chapters} chapter(s) → ${staged.source}`);

if (flags['dry-run']) {
  console.log('--dry-run: staged only, nothing published.');
  process.exit(0);
}

await publish(staged.source, config);

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

async function resolveConfig(brand, cli) {
  const file = join(ROOT, 'deployment', brand, 'deployment.json');
  let fromFile = {};
  if (existsSync(file)) {
    const deployment = JSON.parse(await readFile(file, 'utf8'));
    fromFile = deployment.sync ?? {};
    // A committed file must never carry a credential. This is a hard stop, not
    // a warning: a warning gets scrolled past and the secret is in git forever.
    for (const forbidden of ['token', 'password', 'secret', 'accessToken']) {
      if (fromFile[forbidden] !== undefined) {
        console.error(
          `${file} has sync.${forbidden}. That file is committed — a credential must never be in it. ` +
            `Remove it and set STORYLARK_SYNC_TOKEN in the environment instead.`
        );
        process.exit(1);
      }
    }
  }

  const pick = (name, env) =>
    (typeof cli[name] === 'string' && cli[name]) || process.env[env] || fromFile[name] || undefined;

  const kind = pick('kind', 'STORYLARK_SYNC_KIND');
  const url = pick('url', 'STORYLARK_SYNC_URL');
  const ref = pick('ref', 'STORYLARK_SYNC_REF');
  const path = pick('path', 'STORYLARK_SYNC_PATH');

  if (!kind) {
    console.error(
      `No sync source configured for brand "${brand}". Set "sync": { "kind": "git" | "feed", "url": … } in ` +
        `${file}, or pass --kind/--url, or set STORYLARK_SYNC_KIND/STORYLARK_SYNC_URL. See docs/content-sync.md.`
    );
    process.exit(1);
  }
  if (kind !== 'git' && kind !== 'feed') {
    console.error(
      `Unknown sync kind "${kind}". StoryLark supports exactly two: "git" (a repo of markdown) and "feed" ` +
        `(your own system's JSON feed). A system that fits neither uses the content API directly — ` +
        `see docs/content-sync.md.`
    );
    process.exit(1);
  }
  if (!url) {
    console.error(`sync.url is required for a "${kind}" source.`);
    process.exit(1);
  }
  if (kind === 'feed' && !/^https?:\/\//i.test(url)) {
    console.error(`A feed URL must be http(s) (got "${url}").`);
    process.exit(1);
  }
  if (/:\/\/[^/@]*:[^/@]*@/.test(url)) {
    console.error(
      'The sync URL embeds a username:password. Put the credential in STORYLARK_SYNC_TOKEN instead — ' +
        'a URL with a secret in it ends up in logs, in the manifest and in every error message.'
    );
    process.exit(1);
  }
  return { kind, url, ref, path };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Connector 1 — a git repository of markdown
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Clone the source repo shallowly and hand publish.mjs the directory that holds
 * `books/`.
 *
 * A real `git clone`, not an HTTP call against some host's file API. That is the
 * whole reason this connector lives in the pipeline: git is host-agnostic, so
 * this works against GitHub, GitLab, Bitbucket, Gitea, Azure DevOps, a bare repo
 * on a server, or a path on disk, with no per-host code and therefore nothing
 * bespoke to maintain. `--depth 1` because history is irrelevant — the current
 * state of the branch IS the source of truth — and because a large catalogue's
 * history is the expensive part of cloning it.
 *
 * The clone is thrown away and remade each run rather than pulled. A stale
 * working tree (a force-push, a rewritten branch, a partially failed fetch) is a
 * silent wrong-content bug; a fresh shallow clone can't have one, and the cost
 * is bounded by the size of the catalogue rather than by its age.
 *
 * A private repo authenticates with STORYLARK_SYNC_TOKEN, injected into the
 * clone URL as `x-access-token`. It is passed through an environment-substituted
 * URL and redacted from every line this prints.
 */
async function stageFromGit(config) {
  const dir = join(stagingRoot, 'repo');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });

  const url = token ? withToken(config.url, token) : config.url;
  const argv = ['clone', '--depth', '1', '--single-branch'];
  if (config.ref) argv.push('--branch', config.ref);
  argv.push(url, dir);

  try {
    await run('git', argv, { cwd: ROOT });
  } catch (err) {
    const detail = redact(String(err?.stderr || err?.message || err)).trim();
    console.error(
      `Could not clone ${redact(config.url)}${config.ref ? ` (branch ${config.ref})` : ''}.\n${detail}\n` +
        (token
          ? 'A token was supplied — check it is a read-only credential that can see this repository.'
          : 'If the repository is private, set STORYLARK_SYNC_TOKEN to a read-only access token.')
    );
    process.exit(1);
  }

  const source = config.path ? join(dir, config.path) : dir;
  const booksDir = join(source, 'books');
  if (!existsSync(booksDir)) {
    console.error(
      `${redact(config.url)} has no "books/" directory${config.path ? ` under "${config.path}"` : ''}. ` +
        `A synced repo uses StoryLark's own folder-per-book layout — see docs/authoring-stories.md. ` +
        `If the content lives in a subdirectory, set sync.path.`
    );
    process.exit(1);
  }
  return { source, ...(await countStaged(booksDir)) };
}

/** `https://host/path` → `https://x-access-token:<token>@host/path`. Hosts that
 *  want the token as the username instead accept this shape too (GitHub,
 *  GitLab, Bitbucket, Azure DevOps and Gitea all do). */
function withToken(url, secret) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url; // ssh/file — token is meaningless
    u.username = 'x-access-token';
    u.password = secret;
    return u.toString();
  } catch {
    return url; // a local path or scp-style remote: nothing to inject into
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Connector 2 — the publisher's own system, over a documented JSON feed
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Fetch the feed, fetch each chapter's markdown, and write the whole thing out
 * in the blessed folder layout so the ordinary parser can read it.
 *
 * The contract is deliberately the smallest thing that can describe a library
 * (documented in full in docs/content-sync.md) and is written against nobody's
 * particular product: a publisher emits it from whatever they already have.
 * Chapter text may be inline (`markdown`) or fetched (`markdownUrl`), because a
 * system with the text to hand shouldn't be forced to serve a second request per
 * chapter, and one that stores files shouldn't have to inline megabytes.
 *
 * Auth: STORYLARK_SYNC_TOKEN is sent as a bearer token to the feed and to any
 * URL on the SAME ORIGIN as the feed — never to another origin. A feed that
 * points at a CDN or a third-party image host must not be able to make this
 * process hand that host the publisher's credential.
 */
async function stageFromFeed(config) {
  const dir = join(stagingRoot, 'feed');
  await rm(dir, { recursive: true, force: true });
  const booksDir = join(dir, 'books');
  await mkdir(booksDir, { recursive: true });

  const feed = await fetchJson(config.url, config.url);
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.books)) {
    console.error(
      `${config.url} did not return a StoryLark feed: expected a JSON object with a "books" array. ` +
        `See docs/content-sync.md for the contract.`
    );
    process.exit(1);
  }
  if (feed.storylarkFeedVersion !== undefined && Number(feed.storylarkFeedVersion) !== 1) {
    console.warn(
      `Feed declares storylarkFeedVersion ${feed.storylarkFeedVersion}; this pipeline understands 1. ` +
        `Reading it as version 1 — update StoryLark if fields appear to be missing.`
    );
  }

  let chapterCount = 0;
  for (const book of feed.books) {
    const bookId = String(book?.id ?? '');
    if (!ID_RE.test(bookId)) {
      console.error(`Feed book id "${bookId}" is not usable: 1-64 lowercase letters, digits or hyphens.`);
      process.exit(1);
    }
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    if (chapters.length === 0) {
      console.error(`Feed book "${bookId}" has no chapters.`);
      process.exit(1);
    }
    const bookDir = join(booksDir, bookId);
    await mkdir(bookDir, { recursive: true });

    const meta = {
      title: book.title,
      author: book.author,
      description: book.description,
      order: book.order,
    };
    if (book.coverUrl) {
      meta.coverSource = await stageCover(dir, bookId, String(book.coverUrl), config.url);
    }
    await writeFile(join(bookDir, 'book.json'), JSON.stringify(meta, null, 2));

    for (const [i, chapter] of chapters.entries()) {
      const chapterId = String(chapter?.id ?? '');
      if (!ID_RE.test(chapterId)) {
        console.error(`Feed chapter id "${chapterId}" in book "${bookId}" is not usable: 1-64 lowercase letters, digits or hyphens.`);
        process.exit(1);
      }
      let markdown;
      if (typeof chapter.markdown === 'string') {
        markdown = chapter.markdown;
      } else if (typeof chapter.markdownUrl === 'string') {
        markdown = await fetchText(new URL(chapter.markdownUrl, config.url).toString(), config.url);
      } else {
        console.error(`Feed chapter "${bookId}/${chapterId}" has neither "markdown" nor "markdownUrl".`);
        process.exit(1);
      }
      // Chapter order comes from the feed's array order, expressed the way the
      // parser already understands it: a numeric filename prefix. The id is
      // pinned in front matter as well, so a chapter id that happens to start
      // with digits can't be mangled by the prefix-stripping rule.
      const prefix = String(i + 1).padStart(2, '0');
      const file = join(bookDir, `${prefix}-${chapterId}.md`);
      await writeFile(file, withFrontmatter(markdown, chapterId, chapter));
      chapterCount++;
    }
  }
  if (feed.books.length === 0) {
    console.error(`${config.url} returned an empty library ("books": []). Nothing to sync.`);
    process.exit(1);
  }
  return { source: dir, books: feed.books.length, chapters: chapterCount };
}

/**
 * Guarantee the chapter file carries `chapterId` (and, where the feed offered
 * them, `title`/`label`) without rewriting front matter the publisher already
 * wrote.
 *
 * Their front matter is authoritative — it is their content — so existing keys
 * are never touched; missing ones are inserted after the opening `---`. A file
 * with no front matter at all gets a fresh block. This is textual on purpose: a
 * parse-and-re-emit would quietly reformat (and eventually lose) fields this
 * pipeline doesn't know about.
 */
function withFrontmatter(markdown, chapterId, chapter) {
  const wanted = [
    ['chapterId', chapterId],
    ['title', chapter?.title],
    ['label', chapter?.label],
  ].filter(([, v]) => typeof v === 'string' && v.length > 0);

  const opens = /^﻿?---\r?\n/.test(markdown);
  const closed = opens && /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.test(markdown);
  if (!closed) {
    const block = wanted.map(([k, v]) => `${k}: ${v}`).join('\n');
    return `---\n${block}\n---\n\n${markdown.replace(/^﻿/, '')}`;
  }
  const open = markdown.match(/^﻿?---\r?\n/)[0];
  const rest = markdown.slice(open.length);
  const end = rest.search(/^---[ \t]*$/m);
  const head = rest.slice(0, end);
  const missing = wanted.filter(([k]) => !new RegExp(`^${k}\\s*:`, 'm').test(head));
  if (missing.length === 0) return markdown;
  return open + missing.map(([k, v]) => `${k}: ${v}\n`).join('') + rest;
}

/** Download a cover into the staging tree and return the `coverSource` value
 *  publish.mjs resolves (a path under `<source>/public/`). */
async function stageCover(dir, bookId, coverUrl, feedUrl) {
  const absolute = new URL(coverUrl, feedUrl).toString();
  const res = await fetch(absolute, { headers: authHeaders(absolute, feedUrl) });
  if (!res.ok) {
    console.warn(`  cover for "${bookId}": ${absolute} returned ${res.status} — skipped.`);
    return undefined;
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext =
    { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type] ??
    (['.png', '.jpg', '.jpeg', '.webp'].includes(extname(new URL(absolute).pathname).toLowerCase())
      ? extname(new URL(absolute).pathname).toLowerCase()
      : '.jpg');
  const rel = `/covers/${bookId}${ext}`;
  const dest = join(dir, 'public', 'covers', `${bookId}${ext}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return rel;
}

/** Bearer auth, but only for the feed's own origin. See stageFromFeed(). */
function authHeaders(url, feedUrl) {
  if (!token) return {};
  try {
    if (new URL(url).origin !== new URL(feedUrl).origin) return {};
  } catch {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchText(url, feedUrl) {
  const res = await fetch(url, { headers: authHeaders(url, feedUrl), cache: 'no-store' });
  if (!res.ok) {
    console.error(
      `${url} returned ${res.status}.` +
        (res.status === 401 || res.status === 403
          ? ' Set STORYLARK_SYNC_TOKEN to a credential that can read it.'
          : '')
    );
    process.exit(1);
  }
  return res.text();
}

async function fetchJson(url, feedUrl) {
  const text = await fetchText(url, feedUrl);
  try {
    return JSON.parse(text);
  } catch {
    console.error(`${url} did not return JSON.`);
    process.exit(1);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Publish
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hand the staged source to the real pipeline.
 *
 * A child process rather than an import: publish.mjs is a script that reads
 * process.argv and calls process.exit, and running it as anything else would
 * mean maintaining a second entry point into it — which is how a "sync
 * pipeline" that slowly diverges from the publish pipeline gets born. Its stdio
 * is inherited so the operator sees the ordinary publish output, and its exit
 * code becomes this process's exit code so a scheduled run fails loudly.
 */
function publish(source, config) {
  const argv = [
    join(HERE, 'publish.mjs'),
    '--brand', brandId,
    '--source', source,
    '--origin', 'sync',
    '--sync-kind', config.kind,
    // The URL as CONFIGURED, never the credential-bearing one: this value is
    // written into the manifest, which is public.
    '--sync-url', config.url,
    ...(config.ref ? ['--sync-ref', config.ref] : []),
    ...(config.path ? ['--sync-path', config.path] : []),
    ...passthrough,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) process.exit(code ?? 1);
      resolvePromise();
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function countStaged(booksDir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(booksDir, { withFileTypes: true });
  let books = 0;
  let chapters = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      books++;
      chapters += (await readdir(join(booksDir, entry.name))).filter((f) => f.endsWith('.md')).length;
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      books++;
      chapters++;
    }
  }
  return { books, chapters };
}

/** Never print a token, in success or in failure. */
function redact(text) {
  let out = String(text).replace(/(\/\/)[^/@\s]*:[^/@\s]*@/g, '$1***@');
  if (token) out = out.split(token).join('***');
  return out;
}

/** Flags before `--`; everything after it goes to publish.mjs untouched. */
function parseArgs(argv) {
  const split = argv.indexOf('--');
  const mine = split === -1 ? argv : argv.slice(0, split);
  const passthrough = split === -1 ? [] : argv.slice(split + 1);
  const flags = {};
  for (let i = 0; i < mine.length; i++) {
    if (!mine[i].startsWith('--')) continue;
    const name = mine[i].slice(2);
    if (i + 1 < mine.length && !mine[i + 1].startsWith('--')) flags[name] = mine[++i];
    else flags[name] = true;
  }
  return { flags, passthrough };
}
