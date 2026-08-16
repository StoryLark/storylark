// Presentation at response time (AB#7416 — plan §0d Phase 3).
//
// ── The problem this closes ─────────────────────────────────────────────────
// How a library is ARRANGED — which tabs it has and in what order, which
// sections are on Home, how the shelf sorts and groups, how items open, what
// the skip button does, what shape the covers are, what the empty shelf says —
// was compiled into the JS bundle from presentation/<id>/presentation.json.
// Reordering two tabs meant rebuilding the whole engine on the operator's own
// machine and redeploying, which is the opposite of the "click to update,
// nothing local, ever" model, and it is the last thing standing between Phase 2
// and a genuinely swappable prebuilt engine: you cannot hand a customer a
// prebuilt bundle if their screen layout is inside it.
//
// ── The mechanism ───────────────────────────────────────────────────────────
// Identical in shape to Phase 2's ./brand.ts, because it is proven and because
// both platforms already route documents through the same plumbing:
//
//   dist/presentation.json    the live arrangement — swappable, per deployment
//
//   index.html / admin.html   <script id="storylark-presentation">self.__STORYLARK_PRESENTATION__={…}</script>
//   sw.js                     the same assignment, as a prelude
//
// The platform reads dist/presentation.json on the way out of every HTML
// response and stamps its CURRENT contents into the document, so replacing that
// one file on a deployed site rearranges the live site — no recompile, no new
// hashed chunk, no rebuild. Which is why it is read per request rather than
// captured at boot.
//
// ── A THIRD script tag, not a key in either of the other two ────────────────
// Phase 2 chose a separate tag from Phase 1's `__STORYLARK_DEPLOYMENT__` for
// three reasons. All three apply again here, and one of them applies harder:
//
//  1. Reshaping a global breaks mid-update deployments. An installed PWA's
//     service worker and its precached shell were written by whatever engine
//     was live when they were cached; a document injected with a RESHAPED
//     global served to a worker that reads the old shape loses the value it
//     needs — for `__STORYLARK_DEPLOYMENT__.contentOrigin`, that takes the
//     library offline. Additive globals have no such failure mode, and this is
//     the third one added without touching either of the first two.
//  2. Different SOURCES, different failure modes. Deployment config comes from
//     environment variables; brand and presentation come from two different
//     files, which an operator (and later the portal) edits and replaces
//     independently and at different cadences — a tagline changes far more
//     often than a tab order. Merging them would merge two unrelated fallback
//     stories and make a truncated file take out both.
//  3. The plumbing is shared either way. `run_worker_first`, `serveAsset()` and
//     the Azure claim-before-serveStatic routes decide which URLs reach the
//     injector — not how many tags it writes. Merging saves nothing there.
//
// And the one specific to this phase: ./brand.ts's KNOWN_BRAND_KEYS whitelist
// exists precisely to DROP a `layout` that turns up in brand.json. Folding
// presentation into the brand global would delete that boundary two commits
// after it was drawn — the identity file and the arrangement file would become
// one thing again, which is what Phase 0 split apart.
//
// Both platform entries share THIS module: the Cloudflare Worker imports it
// directly, the Azure Node server as `storylark-worker/lib/presentation`.

/**
 * A presentation, as injected — the contents of dist/presentation.json,
 * validated, with anything unusable dropped.
 *
 * Deliberately `unknown`-ish at the leaves: this module's job is to make sure
 * only WELL-FORMED, KNOWN keys travel, not to know what each one means. The
 * meanings, and the defaults for everything absent, live in exactly one place —
 * DEFAULT_PRESENTATION in storylark-core/src/presentation.ts. Duplicating the
 * defaults here would create a second answer that could disagree with the
 * frontend's, and "a missing key takes the core default" would stop being one
 * fact.
 */
export type PresentationInput = Record<string, unknown>;

/**
 * The global the injected statement writes.
 *
 * Keep in sync with PRESENTATION_GLOBAL in packages/core/src/presentation.ts —
 * core cannot import this module (the frontend must not depend on the worker
 * package) so the name is spelled out in both places on purpose, exactly as
 * Phases 1 and 2 do.
 */
export const PRESENTATION_GLOBAL = '__STORYLARK_PRESENTATION__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const PRESENTATION_SCRIPT_ID = 'storylark-presentation';

/** Where a built site keeps the presentation asset. */
export const PRESENTATION_ASSET = '/presentation.json';

const SCRIPT_RE = new RegExp(`<script id="${PRESENTATION_SCRIPT_ID}">[\\s\\S]*?</script>`);
const PRELUDE_RE = new RegExp(`^self\\.${PRESENTATION_GLOBAL}=.*\\n`);

/**
 * The §0b contract's top-level keys, and the shape of each one.
 *
 *   'object'  merged key-by-key by the frontend resolver
 *   'scalar'  a single value
 *   'open'    an object whose OWN keys are not enumerable here (`features`, and
 *             `nav.labels`) — a feature core has not shipped yet is not an
 *             unknown key, so its entry must survive an older engine intact
 *
 * Keep in sync with GROUPS/KNOWN_KEYS in storylark-core/src/presentation.ts.
 * Same reasoning as the globals above: the frontend and the injector cannot
 * import each other, so the list is spelled twice and the divergence is caught
 * by the schema, which both are checked against.
 */
const KNOWN_KEYS: Record<string, 'object' | 'scalar' | 'open'> = {
  contractVersion: 'scalar',
  layout: 'scalar',
  nouns: 'object',
  nav: 'object',
  home: 'object',
  library: 'object',
  reader: 'object',
  player: 'object',
  cover: 'object',
  detail: 'object',
  auth: 'object',
  settings: 'object',
  download: 'object',
  emptyState: 'object',
  about: 'object',
  features: 'open',
};

/**
 * Keys that belong to one of the OTHER two contracts. Finding one here is
 * technically just an unknown key, but a generic warning would be useless: the
 * operator wants to be told where it went and that the value is being ignored.
 * These are the keys most likely to be tried, because all of them lived in the
 * single brand.json before Phase 0.
 */
const RELOCATED: Record<string, string> = {
  id: 'brand identity (brands/<id>/brand.json)',
  name: 'brand identity (brands/<id>/brand.json)',
  appName: 'brand identity (brands/<id>/brand.json)',
  shortName: 'brand identity (brands/<id>/brand.json)',
  tagline: 'brand identity (brands/<id>/brand.json)',
  author: 'brand identity (brands/<id>/brand.json)',
  themeColor: 'brand identity (brands/<id>/brand.json)',
  backgroundColor: 'brand identity (brands/<id>/brand.json)',
  defaultTheme: 'brand identity (brands/<id>/brand.json)',
  fonts: 'brand identity (brands/<id>/brand.json)',
  appOrigin: 'deployment config (STORYLARK_APP_ORIGIN / APP_ORIGIN)',
  contentOrigin: 'deployment config (STORYLARK_CONTENT_ORIGIN / CONTENT_ORIGIN)',
  vapidPublicKey: 'deployment config (VAPID_PUBLIC_KEY)',
  tts: 'deployment config (STORYLARK_TTS_*)',
};

/**
 * Parse and validate the deployment's presentation.json.
 *
 * Validation happens HERE rather than through presentation.schema.json for the
 * same reason Phases 1 and 2 validate by hand: validate.mjs is Node-only ESM
 * that reads schema files off disk, which no Worker can do. What is worth
 * catching at this boundary is an operator hand-editing a live file, so the
 * policy matches ./brand.ts exactly — a bad VALUE is warned about and OMITTED
 * (that one key then takes the core default), and only unparseable JSON gives
 * up on the file entirely. A stray typo in `player` must not flatten the tab bar.
 *
 * What it deliberately does NOT do is check the VALUES inside a known group.
 * `library.view: "griid"` travels, and the frontend resolver ignores it in
 * favour of the default — because the set of legal values is engine knowledge
 * that changes with the engine, and an injector that rejected tomorrow's legal
 * value would be a NEWER file broken by an OLDER server: exactly the failure
 * rule 2 exists to prevent. The injector polices SHAPE; core polices meaning.
 *
 * Returns undefined when there is nothing usable, which callers treat as "this
 * deployment ships no presentation asset" and skip injection for — an older
 * build with no dist/presentation.json keeps working on a newer engine.
 */
export function readPresentationAsset(
  text: string,
  onWarn: (message: string) => void = (m) => console.warn(m)
): PresentationInput | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    onWarn(
      `storylark: presentation.json is not valid JSON (${(err as Error).message}) — serving the presentation baked in at build until it is fixed.`
    );
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    onWarn('storylark: presentation.json is not a JSON object — serving the presentation baked in at build until it is fixed.');
    return undefined;
  }

  const doc = raw as Record<string, unknown>;
  const out: PresentationInput = {};

  for (const [key, value] of Object.entries(doc)) {
    const kind = KNOWN_KEYS[key];
    if (!kind) {
      // Rule 2 of the contract, enforced at the serve boundary rather than only
      // at build: an unknown key is ignored with a warning.
      const moved = RELOCATED[key];
      onWarn(
        moved
          ? `storylark: presentation.json "${key}" is not presentation — it lives in ${moved}. Ignoring it here.`
          : `storylark: presentation.json has an unknown key "${key}" — ignoring it. (Written for a newer engine, or a typo.)`
      );
      continue;
    }
    if (kind === 'scalar') {
      out[key] = value;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      onWarn(`storylark: presentation.json \`${key}\` is not an object — ignoring it and using the core default.`);
      continue;
    }
    out[key] = value;
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * `self.__STORYLARK_PRESENTATION__={…};` — the one statement, shared by the
 * HTML tag and the service-worker prelude.
 *
 * `<` is escaped for the same reason as in ./brand.ts and ./deployment.ts: this
 * string is emitted inside a `<script>` element, where a literal `</script>`
 * inside a JSON string value would end the element early. Presentation carries
 * free text a human types — empty-state copy, nav labels, About link labels —
 * so this is a real case here, not a theoretical one.
 */
export function presentationStatement(presentation: PresentationInput): string {
  const json = JSON.stringify(presentation).replace(/</g, '\\u003c');
  return `self.${PRESENTATION_GLOBAL}=${json};`;
}

/** The `<script>` element injected into a document. */
export function presentationScriptTag(presentation: PresentationInput): string {
  return `<script id="${PRESENTATION_SCRIPT_ID}">${presentationStatement(presentation)}</script>`;
}

/**
 * Stamp the presentation into an HTML document.
 *
 * Immediately after `<head>`, ahead of the module bundle, so the app reads the
 * live arrangement during its own module evaluation — no round trip, nothing to
 * await, and no flash of the previous tab order. Idempotent.
 *
 * No `<title>` equivalent here, unlike ./brand.ts: nothing in the presentation
 * contract affects what the browser shows before JavaScript runs.
 */
export function injectPresentationIntoHtml(html: string, presentation: PresentationInput): string {
  const tag = presentationScriptTag(presentation);
  if (SCRIPT_RE.test(html)) return html.replace(SCRIPT_RE, tag);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

/**
 * Stamp the presentation into the service worker script.
 *
 * The service worker needs it for one thing, and it is not optional: re-stamping
 * the precached app shell. The precache is only refetched when the BUILD
 * changes, so without this an installed PWA would keep yesterday's arrangement
 * indefinitely after a swap, even though this worker already knows better. See
 * packages/core/src/sw.ts.
 */
export function injectPresentationIntoScript(js: string, presentation: PresentationInput): string {
  return `${presentationStatement(presentation)}\n${js.replace(PRELUDE_RE, '')}`;
}
