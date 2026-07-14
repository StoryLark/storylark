/// <reference path="./virtual.d.ts" />
import { render } from 'preact';
import { App } from './app';
import { BRAND } from './brand';
import { bootstrap } from './lib/state';
import { startSyncLoop } from './lib/progress-sync';
import { initDownloadStates } from './lib/downloads';
import { initAutoSync } from './lib/autosync';
import { initServiceWorker } from './lib/update';
import 'virtual:storylark-theme.css';
import 'virtual:storylark-fonts';
import './styles/base.css';
import './styles/reader.css';
import './styles/ui2.css';

/**
 * Boots the StoryLark app into `el`. This is the whole client API a site
 * needs: the theme, fonts, and site config arrive through the virtual modules
 * provided by `defineStorylarkConfig` (see @storylark/core/vite).
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
