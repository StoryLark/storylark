import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  librarySortLabel,
  personalLibrarySortOptions,
  resolvePersonalLibrarySort,
} from '../../core/src/lib/library-order.ts';

function library(overrides = {}) {
  return {
    defaultSort: 'order',
    sortOptions: ['order', 'timeframe', 'recent'],
    groupBy: 'none',
    groupOptions: ['group'],
    view: 'list',
    showSearch: true,
    ...overrides,
  };
}

test('an ungrouped story shelf offers and resolves a personal default order', () => {
  const config = library();
  assert.deepEqual(personalLibrarySortOptions(config), ['order', 'timeframe', 'recent']);
  assert.equal(resolvePersonalLibrarySort(config, 'timeframe'), 'timeframe');
  assert.equal(resolvePersonalLibrarySort(config, ''), 'order');
  assert.equal(librarySortLabel('order', 'Story'), 'Story order');
  assert.equal(librarySortLabel('timeframe', 'Story'), 'Chronological');
});

test('a removed sort falls back to the deployment default', () => {
  const config = library({ sortOptions: ['order', 'recent'] });
  assert.equal(resolvePersonalLibrarySort(config, 'timeframe'), 'order');
});

test('grouped book libraries do not offer a personal shelf-order override', () => {
  const config = library({ groupBy: 'collection' });
  assert.deepEqual(personalLibrarySortOptions(config), []);
  assert.equal(resolvePersonalLibrarySort(config, 'timeframe'), 'order');
});

test('the preference is wired through Settings, account sync, and Library startup', async () => {
  const [settingsSource, stateSource, librarySource] = await Promise.all([
    readFile(new URL('../../core/src/screens/Settings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../core/src/lib/state.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../core/src/screens/Library.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(settingsSource, /Default library order/);
  assert.match(settingsSource, /saveSettings\(\{ librarySort:/);
  assert.match(stateSource, /'librarySort'/);
  assert.match(stateSource, /librarySort: settings\.value\.librarySort/);
  assert.match(librarySource, /resolvePersonalLibrarySort\(PRESENTATION\.library, settings\.value\.librarySort\)/);
});
