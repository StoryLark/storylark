/// <reference path="./virtual.d.ts" />
import { render } from 'preact';
import { App } from './app';
import { BRAND } from './brand';
import { PRESENTATION } from './presentation';
import { bootstrap, preapplyForcedReaderTheme } from './lib/state';
import { startSyncLoop } from './lib/progress-sync';
import { initDownloadStates } from './lib/downloads';
import { initAutoSync } from './lib/autosync';
import { initServiceWorker } from './lib/update';
// The brand's theme.css is NOT imported here any more (AB#7415 — plan §0d
// Phase 2). It ships as dist/theme.css and is linked from the document, so
// replacing that one file restyles a deployed site with no rebuild. What is
// imported is the curated font set — @font-face declarations for every family
// a brand may pick, so the pick itself can change at runtime.
import 'virtual:storylark-fonts';
import './styles/base.css';
import './styles/reader.css';
import './styles/ui2.css';

/**
 * Boots the StoryLark app into `el`. This is the whole client API a site
 * needs: the theme, fonts, and site config arrive through the virtual modules
 * provided by `defineStorylarkConfig` (see storylark-core/vite).
 */
export function mount(el: HTMLElement): void {
  document.title = `${BRAND.appName}: ${BRAND.name}`;
  // Cover shape (AB#7416 — presentation `cover.aspect`). An attribute on <html>
  // rather than a class on a container, so the CSS that reads it is a single
  // :root selector and the value is in place before the first component renders.
  document.documentElement.dataset.coverAspect = PRESENTATION.cover.aspect;
  // A look the deployment FORCES needs no stored state, so it goes on before
  // bootstrap's first await rather than after it (AB#7412 — see the function's
  // own comment). An unforced one waits for the reader's saved preference.
  preapplyForcedReaderTheme();

  initServiceWorker();

  void bootstrap().then(() => {
    startSyncLoop();
    void initDownloadStates().then(() => initAutoSync());
  });

  render(<App />, el);
}
