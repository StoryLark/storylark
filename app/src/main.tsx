import { render } from 'preact';
import { App } from './app';
import { BRAND } from './brand';
import { bootstrap } from './lib/state';
import { startSyncLoop } from './lib/progress-sync';
import { initDownloadStates } from './lib/downloads';
import { initAutoSync } from './lib/autosync';
import { initServiceWorker } from './lib/update';
import 'virtual:brand-theme.css';
import './styles/fonts';
import './styles/base.css';
import './styles/reader.css';
import './styles/ui2.css';

document.title = `${BRAND.appName}: ${BRAND.name}`;

initServiceWorker();

void bootstrap().then(() => {
  startSyncLoop();
  void initDownloadStates().then(() => initAutoSync());
});

render(<App />, document.getElementById('app')!);
