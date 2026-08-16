// Deployment config at response time (AB#7414 — plan §0d Phase 1).
//
// ── The problem this closes ─────────────────────────────────────────────────
// Origins, the VAPID public key and `tts` are properties of a DEPLOYMENT, not
// of the code. Until now they were compiled into the JS bundle by the Vite
// preset, so an operator who changed CONTENT_ORIGIN in Azure app settings or a
// Cloudflare Worker var got a split brain: the backend picked the new value up
// on the next request (every route already reads `c.env.*` directly), while
// the frontend kept serving the value baked in at the last build. The two
// halves of one deployment disagreed until somebody rebuilt and redeployed.
//
// ── The mechanism ───────────────────────────────────────────────────────────
// The platform that serves the documents stamps the CURRENT environment into
// them on the way out:
//
//   index.html / admin.html   <script id="storylark-deployment">self.__STORYLARK_DEPLOYMENT__={…}</script>
//   sw.js                     the same assignment, prepended as a prelude
//
// `self` rather than `window` on purpose — the identical statement works in a
// document and in the service worker, so there is one shape to reason about.
// The frontend reads the global and falls back to the build-time value when it
// is absent (`vite dev`, `vite preview`, a plain static host); see
// packages/core/src/deployment.ts.
//
// This is deliberately the same injection pattern plan §0d Phase 2 will reuse
// for brand data — "inject brand JSON into index.html at deploy … no extra
// runtime fetch and no FOUC either". Phase 1 builds it for deployment config
// only so Phase 2 extends a working precedent instead of inventing one.
//
// Both platform entries share THIS module: the Cloudflare Worker imports it
// directly (packages/worker/src/index.ts) and the Azure Node server imports it
// as `storylark-worker/lib/deployment`. Same bytes injected either way — the
// per-platform difference is only in how each one gets hold of the document.

/** Narration config. Read by the publish pipeline; carried here so the
 *  deployment contract travels whole. Nothing in the frontend reads it yet. */
export interface DeploymentTts {
  voice?: string;
  rate?: string;
  outputFormat?: string;
  voices?: string[];
}

/**
 * The deployment contract, as injected. Every key is optional: an absent key
 * means "this deployment does not configure it", and the frontend then falls
 * back to the value baked at build time. That is why nothing is defaulted to
 * an empty string here — `contentOrigin: ''` is a meaningful value (same-origin
 * content) and must never be manufactured out of an unset environment variable.
 */
export interface DeploymentConfig {
  appOrigin?: string;
  contentOrigin?: string;
  vapidPublicKey?: string;
  tts?: DeploymentTts;
}

/** Environment shape this reads. A subset of Env, so the Azure entry can pass
 *  `process.env` straight in without pretending to be a Worker. */
export interface DeploymentEnv {
  APP_ORIGIN?: string;
  CONTENT_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  TTS_VOICE?: string;
  TTS_RATE?: string;
  TTS_OUTPUT_FORMAT?: string;
  /** Comma-separated list. */
  TTS_VOICES?: string;
}

/**
 * The global the injected statement writes.
 *
 * Keep in sync with DEPLOYMENT_GLOBAL in packages/core/src/deployment.ts —
 * core cannot import this module (the frontend must not depend on the worker
 * package) so the name is spelled out in both places on purpose.
 */
export const DEPLOYMENT_GLOBAL = '__STORYLARK_DEPLOYMENT__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const DEPLOYMENT_SCRIPT_ID = 'storylark-deployment';

const SCRIPT_RE = new RegExp(`<script id="${DEPLOYMENT_SCRIPT_ID}">[\\s\\S]*?</script>`);
const PRELUDE_RE = new RegExp(`^self\\.${DEPLOYMENT_GLOBAL}=.*\\n`);

/**
 * Read the live deployment config out of the running environment.
 *
 * Validation happens HERE rather than through deployment.schema.json. The
 * schema validates the FILE — it requires `contractVersion`, which an
 * environment has no concept of — and validate.mjs is Node-only ESM that reads
 * schema files off disk, which does not run in a Worker. What is actually
 * worth catching at this boundary is an operator typo in an app setting, so
 * that is what this checks: a value that fails is WARNED ABOUT and OMITTED, so
 * the frontend falls back to the build-time value rather than shipping a
 * broken origin to every reader. The warning is the signal; silently accepting
 * `content.example.com` (no scheme) would break every asset URL in the app.
 */
export function deploymentConfigFromEnv(
  env: DeploymentEnv,
  onWarn: (message: string) => void = (m) => console.warn(m)
): DeploymentConfig {
  const config: DeploymentConfig = {};

  const appOrigin = origin(env.APP_ORIGIN, 'APP_ORIGIN', onWarn);
  if (appOrigin !== undefined) config.appOrigin = appOrigin;

  const contentOrigin = origin(env.CONTENT_ORIGIN, 'CONTENT_ORIGIN', onWarn);
  if (contentOrigin !== undefined) config.contentOrigin = contentOrigin;

  const vapid = (env.VAPID_PUBLIC_KEY ?? '').trim();
  if (vapid) {
    // base64url, and a P-256 uncompressed point is 65 bytes => 87 chars.
    if (/^[A-Za-z0-9_-]+$/.test(vapid) && vapid.length >= 80) {
      config.vapidPublicKey = vapid;
    } else {
      onWarn(
        `storylark: VAPID_PUBLIC_KEY is not a base64url public key (got ${vapid.length} chars) — ignoring it and using the build-time value. Push subscriptions will not work until it is fixed.`
      );
    }
  }

  const tts: DeploymentTts = {};
  if (env.TTS_VOICE) tts.voice = env.TTS_VOICE;
  if (env.TTS_RATE) tts.rate = env.TTS_RATE;
  if (env.TTS_OUTPUT_FORMAT) tts.outputFormat = env.TTS_OUTPUT_FORMAT;
  if (env.TTS_VOICES) {
    const voices = env.TTS_VOICES.split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (voices.length) tts.voices = voices;
  }
  if (Object.keys(tts).length) config.tts = tts;

  return config;
}

/**
 * An origin must be scheme + host (+ optional port) and nothing else. A
 * trailing slash is normalised away rather than rejected, because
 * `contentUrl()` concatenates and would otherwise produce `//path`.
 */
function origin(raw: string | undefined, name: string, onWarn: (m: string) => void): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined; // unset — keep the build-time value
  const trimmed = value.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    onWarn(`storylark: ${name}="${value}" is not an absolute URL — ignoring it and using the build-time value.`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    onWarn(`storylark: ${name}="${value}" is not http(s) — ignoring it and using the build-time value.`);
    return undefined;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    onWarn(`storylark: ${name}="${value}" has a path/query/fragment — an origin is scheme + host only. Ignoring it and using the build-time value.`);
    return undefined;
  }
  return url.origin;
}

/**
 * `self.__STORYLARK_DEPLOYMENT__={…};` — the one statement, shared by the HTML
 * tag and the service-worker prelude.
 *
 * `<` is escaped because the same string is emitted inside a `<script>` element,
 * where a literal `</script>` (or `<!--`) inside a JSON string value would end
 * the element early. JSON.stringify only ever emits `<` inside string values,
 * so escaping it globally is safe and needs no HTML parser.
 */
export function deploymentStatement(config: DeploymentConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `self.${DEPLOYMENT_GLOBAL}=${json};`;
}

/** The `<script>` element injected into a document. */
export function deploymentScriptTag(config: DeploymentConfig): string {
  return `<script id="${DEPLOYMENT_SCRIPT_ID}">${deploymentStatement(config)}</script>`;
}

/**
 * Stamp the config into an HTML document.
 *
 * Placed immediately after `<head>` so it runs before the module bundle, which
 * is what makes this injection and not a runtime fetch: the app reads the
 * global during its own module evaluation, with no round trip and nothing to
 * await. Idempotent — a document that already carries the tag gets it replaced,
 * not doubled.
 */
export function injectDeploymentIntoHtml(html: string, config: DeploymentConfig): string {
  const tag = deploymentScriptTag(config);
  if (SCRIPT_RE.test(html)) return html.replace(SCRIPT_RE, tag);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

/**
 * Stamp the config into the service worker script.
 *
 * The service worker has no document to read a global out of, and it needs the
 * content origin SYNCHRONOUSLY in its fetch handler (the decision to call
 * `respondWith` cannot be awaited), so a prelude on the script itself is the
 * only injection that is both current and race-free. A useful side effect: when
 * an origin changes, sw.js changes byte-for-byte, which is exactly the signal
 * the browser uses to install an updated service worker.
 */
export function injectDeploymentIntoScript(js: string, config: DeploymentConfig): string {
  return `${deploymentStatement(config)}\n${js.replace(PRELUDE_RE, '')}`;
}

/**
 * Wrap a static-asset Response with the injection applied.
 *
 * A buffered string rewrite rather than Cloudflare's HTMLRewriter: the two
 * platforms would otherwise need two different injectors kept in sync, and
 * proving they agree is most of the value of this change. index.html is ~1 KB
 * and admin.html smaller, so there is nothing to stream.
 *
 * Headers: `ETag`/`Last-Modified` are dropped because they describe the file on
 * disk and this body is no longer that file — leaving them would let a client
 * revalidate its way back to a stale copy — and `Cache-Control: no-store` keeps
 * the document itself out of every cache between here and the reader. The
 * installed PWA still precaches the shell; the service worker re-stamps that
 * copy (see packages/core/src/sw.ts).
 */
export async function injectDeploymentIntoResponse(
  response: Response,
  config: DeploymentConfig,
  kind: 'html' | 'script'
): Promise<Response> {
  const body = await response.text();
  const injected = kind === 'html' ? injectDeploymentIntoHtml(body, config) : injectDeploymentIntoScript(body, config);
  const headers = new Headers(response.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.set('cache-control', 'no-store');
  return new Response(injected, { status: response.status, statusText: response.statusText, headers });
}
