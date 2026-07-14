import type { JSX } from 'preact';
import { BRAND, NOUNS, countUnits } from '../brand';
import { APP_VERSION } from '../version';
import { navigate } from '../router';
import { manifest } from '../lib/state';
// Single source of truth: the About screen renders the repo's own docs.
import changelogMd from '../../CHANGELOG.md?raw';
import roadmapMd from '../../ROADMAP.md?raw';

/**
 * The brand's marketing install-guide page. Brand config carries app/content
 * origins only; the marketing-site origin is the app origin without its `app.`
 * label (e.g. https://app.example.com → https://example.com/app).
 */
const INSTALL_PAGE_URL = `${BRAND.appOrigin.replace('://app.', '://')}/app`;

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
        <p class="about-version">Version {APP_VERSION}</p>
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
          <strong>{BRAND.appOrigin.replace(/^https?:\/\//, '')}</strong> on the device you want it on, then:
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
          {BRAND.appName} · {BRAND.name} · v{APP_VERSION} · preview
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
