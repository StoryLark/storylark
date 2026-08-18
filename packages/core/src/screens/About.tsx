import type { JSX } from 'preact';
import { BRAND } from '../brand';
import { NOUNS, PRESENTATION, countUnits } from '../presentation';
import { DEPLOYMENT } from '../deployment';
import { BUILD } from '../version';
import { navigate } from '../router';
import { manifest } from '../lib/state';
// Single source of truth: the About screen renders the repo's own docs.
import changelogMd from '../../RELEASE-NOTES.md?raw';
import roadmapMd from '../../ROADMAP.md?raw';

/**
 * The brand's marketing install-guide page. The marketing-site origin is this
 * deployment's app origin without its `app.` label (e.g.
 * https://app.example.com → https://example.com/app).
 */
const INSTALL_PAGE_URL = `${DEPLOYMENT.appOrigin.replace('://app.', '://')}/app`;

/**
 * The release-notes/changelog docs for the overall build number (AB#7653),
 * distinct from RELEASE-NOTES.md above (which is storylark-core's own
 * package changelog, rendered inline under "What's new"). storylark.org's
 * build serves the changelog at /releases/ — confirmed live (200).
 */
const RELEASE_DOCS_URL = 'https://storylark.org/releases/';

export function About(): JSX.Element {
  const m = manifest.value;
  const units = m ? m.books.reduce((n, b) => n + b.chapters.length, 0) : 0;
  return (
    <div class="screen about-screen">
      <header class="reader-header">
        <button class="icon-btn" onClick={() => navigate('/settings')} aria-label="Back to settings">
          ←
        </button>
        <div class="reader-heading">
          <span class="reader-title">About</span>
        </div>
        <span />
      </header>

      <div class="about-hero">
        <img class="about-logo" src="/icons/icon-192.png" alt="" width="72" height="72" />
        <h1 class="about-title">{BRAND.appName}</h1>
        <p class="about-brand">
          {BRAND.name} · by {BRAND.author}
        </p>
        <p class="about-version">
          Version {BUILD.coreVersion} · build {BUILD.commit} · Release {BUILD.releaseBuild}
        </p>
        {units > 0 && <p class="about-count">{countUnits(units)} in the library</p>}
      </div>

      <section class="settings-section">
        <h2>How {BRAND.appName} works</h2>
        <ul class="about-list">
          <li>
            <strong>Read, listen, or both.</strong> Open any {NOUNS.unit} in Read, Listen, or Read + Listen mode. In Read +
            Listen the text highlights word by word as the narration plays. The app remembers your mode per {NOUNS.unit}.
          </li>
          <li>
            <strong>Take it offline.</strong> Download {NOUNS.unitPlural}, both text and audio, from the Library
            {NOUNS.collection ? `, or grab a whole ${NOUNS.collection} at once,` : ''} and keep reading with no connection.
            Manage what's stored under Settings → Storage.
          </li>
          <li>
            <strong>Pick up where you left off.</strong> Your position is saved on this device as you go; the Home screen's
            Continue card takes you straight back to it.
          </li>
          <li>
            <strong>Sync across devices.</strong> Sign in with your email (magic link, no password) and your progress follows
            you to every device.
          </li>
          <li>
            <strong>Know when there's more.</strong> Turn on notifications to hear the moment a new {NOUNS.unit} is published.
          </li>
        </ul>
      </section>

      <section class="settings-section">
        <h2>Install {BRAND.appName} on your device</h2>
        <p class="about-install-note">
          {BRAND.appName} installs straight from your browser. No app store needed. Open{' '}
          <strong>{DEPLOYMENT.appOrigin.replace(/^https?:\/\//, '')}</strong> on the device you want it on, then:
        </p>
        <ul class="about-list">
          <li>
            <strong>iPhone / iPad (Safari).</strong> Tap the Share button (the square with the up arrow), scroll down,
            tap <em>Add to Home Screen</em>, then <em>Add</em>. On iOS it must be Safari; Chrome can't install.
          </li>
          <li>
            <strong>Android phone / tablet (Chrome).</strong> Tap the ⋮ menu, tap <em>Add to Home screen</em> (on some
            phones <em>Install app</em>), then confirm.
          </li>
          <li>
            <strong>Windows (Chrome or Edge).</strong> Click the install icon at the right end of the address bar, or
            ⋮ → <em>Install this site as an app</em> (Edge: ⋯ → <em>Apps</em> → <em>Install this site as an app</em>),
            then <em>Install</em>.
          </li>
          <li>
            <strong>Mac (Chrome or Safari).</strong> Chrome: click the install icon in the address bar, or ⋮ →{' '}
            <em>Install…</em>. Safari (macOS Sonoma and later): <em>File</em> → <em>Add to Dock</em>.
          </li>
        </ul>
        <a class="about-install-link" href={INSTALL_PAGE_URL} target="_blank" rel="noopener">
          Full details: {INSTALL_PAGE_URL.replace(/^https?:\/\//, '')} ↗
        </a>
      </section>

      <BrandLinks />

      <section class="settings-section">
        <h2>Version &amp; build</h2>
        <p class="about-release">
          <strong>Release {BUILD.releaseBuild}</strong> — the overall build number for this deployment, on top of
          each component's own version below.{' '}
          <a href={RELEASE_DOCS_URL} target="_blank" rel="noopener">
            Release docs ↗
          </a>
        </p>
        <ul class="about-list">
          {Object.entries(BUILD.versions).map(([pkg, ver]) => (
            <li key={pkg}>
              <strong>{pkg}.</strong> v{ver}
              {pkg === 'storylark-core' &&
                ' — the app you are using; this number matches the npm release and the "What\'s new" heading below that describes it'}
            </li>
          ))}
          <li>
            <strong>Solution build.</strong> commit <code>{BUILD.commit}</code>, built{' '}
            {new Date(BUILD.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </li>
          <li>
            <strong>Library.</strong> {BRAND.name} (brand <code>{BUILD.brandId}</code>)
          </li>
        </ul>
      </section>

      <section class="settings-section">
        <h2>What's new</h2>
        <Markdown text={changelogMd} />
      </section>

      <section class="settings-section">
        <h2>Roadmap</h2>
        <Markdown text={roadmapMd} />
      </section>

      <footer class="settings-footer">
        <p class="settings-version">
          {BRAND.appName} · {BRAND.name} · v{BUILD.coreVersion} ({BUILD.commit}) · preview
        </p>
        <p class="settings-version">
          Powered by{' '}
          <a href="https://storylark.org" target="_blank" rel="noopener">
            StoryLark
          </a>{' '}
          — free, open-source read-along storybooks ·{' '}
          <a href="https://storylark.org/docs" target="_blank" rel="noopener">
            docs
          </a>{' '}
          ·{' '}
          <a href="https://github.com/StoryLark/storylark" target="_blank" rel="noopener">
            source
          </a>
        </p>
      </footer>
    </div>
  );
}

/**
 * The brand's own links — presentation `about.links` (AB#7416 — plan §0b,
 * "About screen: extra links and credits, so a brand can point at its own site,
 * licence, or contact").
 *
 * Empty by default, so the section simply does not exist for a library that
 * states none — which is every library today, and therefore no visible change.
 * `rel="noopener"` on every one of them: these are URLs from a config file, and
 * a config file is not a trusted origin just because the operator wrote it.
 */
function BrandLinks(): JSX.Element | null {
  const links = PRESENTATION.about.links;
  if (links.length === 0) return null;
  return (
    <section class="settings-section">
      <h2>More from {BRAND.name}</h2>
      <ul class="about-list">
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label} ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Minimal markdown renderer for our own CHANGELOG/ROADMAP docs — headings,
 * bullets and paragraphs only (that's all those files use). No dependencies.
 */
function Markdown({ text }: { text: string }): JSX.Element {
  const out: JSX.Element[] = [];
  let bullets: string[] = [];
  let key = 0;
  const flush = (): void => {
    if (bullets.length > 0) {
      out.push(
        <ul key={key++} class="about-md-list">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      );
      bullets = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('# ') || line.startsWith('<!--')) {
      // Top-level doc title (the section heading covers it) or a maintainer
      // comment — not rendered. Comments must stay on a single line.
      flush();
    } else if (line.startsWith('## ')) {
      flush();
      out.push(
        <h3 key={key++} class="about-md-h">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
    } else if (line.length === 0) {
      flush();
    } else {
      flush();
      out.push(
        <p key={key++} class="about-md-p">
          {line}
        </p>
      );
    }
  }
  flush();
  return <div class="about-md">{out}</div>;
}
