/// <reference path="./virtual.d.ts" />
import { render } from 'preact';
import { App } from './app';
import { BRAND } from './brand';
import { bootstrap } from './lib/state';
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

  initServiceWorker();

  void bootstrap().then(() => {
    startSyncLoop();
    void initDownloadStates().then(() => initAutoSync());
  });

  render(<App />, el);
}
