import { render } from 'preact';
import { App } from './app';
import { BRAND } from './brand';
import { bootstrap } from './lib/state';
import { startSyncLoop } from './lib/progress-sync';
import { initDownloadStates } from './lib/downloads';
import { initAutoSync } from './lib/autosync';
import { initServiceWorker } from './lib/update';
import 'virtual:brand-theme.css';
import './styles/base.css';
import './styles/reader.css';
import './styles/ui2.css';

document.title = `${BRAND.appName}: ${BRAND.name}`;

// Brand fonts are code-split so each deployment ships only its own set.
if (BRAND.id === 'gunner') {
  void import('./styles/fonts-gunner');
} else {
  void import('./styles/fonts-holdfast');
}

initServiceWorker();

void bootstrap().then(() => {
  startSyncLoop();
  void initDownloadStates().then(() => initAutoSync());
});

render(<App />, document.getElementById('app')!);
