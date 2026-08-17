// Reader-choosable looks, end to end (AB#7412).
//
// Four things are held honest here, and only the first is about data:
//
//  1. The token values bundled in storylark-core/src/lib/reader-themes.ts ARE
//     the real brands/<id>/theme.css files. Not "close to" — every token, both
//     variants, parsed out of the stylesheets on disk. That is the whole reason
//     it is safe to duplicate a designer's colours into a TypeScript module:
//     retuning brands/nebula and forgetting this file is a red test rather than
//     a look that quietly disagrees with the theme it is named after.
//
//  2. An ADMIN-FORCED look beats a reader's SAVED choice. This is the one rule
//     that is easy to implement wrongly and impossible to notice: hiding the
//     picker while a stale preference carries on being applied looks correct
//     from the operator's chair and is broken from every reader's.
//
//  3. Applying a look, and then unapplying it, leaves the deployment's own
//     stylesheet in charge with nothing stuck on.
//
//  4. The whole round trip over the REAL app: an operator PUTs a presentation
//     through the real admin route into a real content store, the real serving
//     record comes back carrying it, the rest of the arrangement survives, and
//     feeding that stored value into the real reader-side resolver produces the
//     forced look. Both halves of "the admin forces it, the reader gets it" are
//     the shipped code; nothing in between is mocked.
//
// No DOM is needed: applyReaderTheme takes anything with a `style` that can
// set and remove a property, which is exactly why it is typed that way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDeployment } from './sqlite-env.mjs';
import { readPresentationAsset } from '../src/lib/presentation.ts';
import { validate, PRESENTATION_SCHEMA } from 'storylark-contracts/validate';
import {
  BRAND_LOOK,
  DEFAULT_READER_THEME,
  READER_THEMES,
  READER_THEME_IDS,
  THEME_TOKEN_NAMES,
  applyReaderTheme,
  readerTheme,
  resolveReaderTheme,
  resolveVariant,
} from '../../core/src/lib/reader-themes.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ── the stylesheets on disk ─────────────────────────────────────────────────

/** `:root` and `:root[data-theme="…"]` blocks, in source order. */
function cssBlocks(css) {
  const out = [];
  const re = /(:root(?:\[data-theme="(light|dark)"\])?)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ variant: m[2] ?? null, body: m[3] });
  return out;
}

/** `--name: value` and `color-scheme: value` declarations, comments stripped. */
function cssDecls(body) {
  const out = {};
  for (const line of body.split(';')) {
    const m = /^\s*(--[\w-]+|color-scheme)\s*:\s*([\s\S]+?)\s*$/.exec(line.replace(/\/\*[\s\S]*?\*\//g, ''));
    if (m) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}

/**
 * Flatten one brand's theme.css into a complete token set per variant — the
 * same flattening reader-themes.ts states by hand, derived here independently.
 *
 * A brand states one variant on bare `:root` and the other as an override, and
 * which is which differs per brand (brands/nebula and brands/wireless are
 * dark-first). So the base block's variant is read off WHICH override the file
 * carries, not assumed.
 */
function flattenTheme(id) {
  const css = readFileSync(join(REPO, 'brands', id, 'theme.css'), 'utf8');
  const blocks = cssBlocks(css);
  const base = blocks.find((b) => b.variant === null);
  const override = blocks.find((b) => b.variant !== null);
  assert.ok(base, `brands/${id}/theme.css has no :root block`);
  assert.ok(override, `brands/${id}/theme.css has no [data-theme] block`);
  const baseVariant = override.variant === 'dark' ? 'light' : 'dark';
  const baseDecls = cssDecls(base.body);
  const overrideDecls = cssDecls(override.body);
  return {
    defaultVariant: baseVariant,
    light: baseVariant === 'light' ? baseDecls : { ...baseDecls, ...overrideDecls },
    dark: baseVariant === 'dark' ? baseDecls : { ...baseDecls, ...overrideDecls },
  };
}

test('every bundled look is the real brands/<id>/theme.css, token for token', () => {
  assert.equal(READER_THEMES.length, 5);
  for (const look of READER_THEMES) {
    const real = flattenTheme(look.id);
    assert.equal(look.defaultVariant, real.defaultVariant, `${look.id}: default variant`);
    assert.deepEqual({ ...look.light }, real.light, `${look.id}: light tokens have drifted from brands/${look.id}/theme.css`);
    assert.deepEqual({ ...look.dark }, real.dark, `${look.id}: dark tokens have drifted from brands/${look.id}/theme.css`);
  }
});

test('every look states every token in both variants, so switching cannot leave a gap', () => {
  for (const look of READER_THEMES) {
    for (const variant of ['light', 'dark']) {
      assert.deepEqual(
        Object.keys(look[variant]).sort(),
        [...THEME_TOKEN_NAMES].sort(),
        `${look.id} ${variant} does not state exactly the token set`
      );
    }
  }
});

test('a look never carries brand identity — a reader cannot change what the site IS', () => {
  const identity = ['appName', 'shortName', 'name', 'tagline', 'author', 'themeColor', 'backgroundColor', 'icons'];
  for (const look of READER_THEMES) {
    for (const key of identity) {
      assert.equal(key in look, false, `${look.id} carries "${key}", which is brand identity, not a look`);
    }
    for (const variant of ['light', 'dark']) {
      for (const token of Object.keys(look[variant])) {
        assert.ok(
          token === 'color-scheme' || token.startsWith('--'),
          `${look.id} ${variant} sets "${token}", which is not a custom property`
        );
      }
    }
  }
});

// ── resolution: who wins ────────────────────────────────────────────────────

test("core's default offers every bundled look and forces none", () => {
  assert.deepEqual(DEFAULT_READER_THEME.options, [...READER_THEME_IDS]);
  assert.equal(DEFAULT_READER_THEME.forced, null);
  // The default is an OFFER: a reader who has chosen nothing still gets the
  // deployment's own stylesheet, which is what makes turning it on by default
  // safe for every existing library.
  const resolved = resolveReaderTheme(DEFAULT_READER_THEME, BRAND_LOOK);
  assert.equal(resolved.active, null);
  assert.equal(resolved.forced, false);
  assert.equal(resolved.options.length, 5);
});

test('a reader who has chosen gets their look', () => {
  const resolved = resolveReaderTheme(DEFAULT_READER_THEME, 'nebula');
  assert.equal(resolved.active?.id, 'nebula');
  assert.equal(resolved.forced, false);
});

test('a FORCED look beats a reader who had already chosen another one', () => {
  const config = { options: [...READER_THEME_IDS], forced: 'wireless' };
  for (const chosen of [BRAND_LOOK, 'nebula', 'loveletter', undefined, null]) {
    const resolved = resolveReaderTheme(config, chosen);
    assert.equal(resolved.active?.id, 'wireless', `a reader holding "${chosen}" escaped the forced look`);
    assert.equal(resolved.forced, true);
    assert.deepEqual(
      resolved.options.map((t) => t.id),
      ['wireless'],
      'a forced deployment must not still offer alternatives'
    );
  }
});

test('a forced look wins even over a reader whose choice IS still in the offer list', () => {
  // The narrow case that a naive "hide the picker" implementation gets wrong:
  // the stored preference is perfectly valid, so nothing about it looks stale.
  const resolved = resolveReaderTheme({ options: ['nebula', 'wireless'], forced: 'nebula' }, 'wireless');
  assert.equal(resolved.active?.id, 'nebula');
});

test('a choice the admin has stopped offering falls back to the site’s own look', () => {
  const resolved = resolveReaderTheme({ options: ['loveletter'], forced: null }, 'nebula');
  assert.equal(resolved.active, null);
  assert.deepEqual(resolved.options.map((t) => t.id), ['loveletter']);
});

test('no options means no picker, and no override', () => {
  const resolved = resolveReaderTheme({ options: [], forced: null }, 'nebula');
  assert.deepEqual(resolved.options, []);
  assert.equal(resolved.active, null);
  assert.equal(resolved.forced, false);
});

test('ids this engine does not ship are ignored rather than fatal', () => {
  // Rule 2 of the presentation contract, at the value level: a file written for
  // an engine with a sixth look must still offer the five this one has.
  const resolved = resolveReaderTheme({ options: ['nebula', 'aurora', 'storylark'], forced: null }, 'aurora');
  assert.deepEqual(resolved.options.map((t) => t.id), ['storylark', 'nebula']);
  assert.equal(resolved.active, null);
  // And an unknown FORCED id must not lock everyone out of the picker.
  const bogus = resolveReaderTheme({ options: [...READER_THEME_IDS], forced: 'aurora' }, 'nebula');
  assert.equal(bogus.forced, false);
  assert.equal(bogus.active?.id, 'nebula');
});

test('the picker order is the bundle order, whatever order the file lists', () => {
  const resolved = resolveReaderTheme({ options: ['wireless', 'storylark', 'nebula'], forced: null }, BRAND_LOOK);
  assert.deepEqual(resolved.options.map((t) => t.id), ['storylark', 'nebula', 'wireless']);
});

test('light and dark still work inside whichever look is active', () => {
  const nebula = readerTheme('nebula');
  assert.equal(resolveVariant('auto', nebula, 'light'), 'dark', "auto follows the LOOK's design, not the brand's");
  assert.equal(resolveVariant('light', nebula, 'light'), 'light');
  assert.equal(resolveVariant('dark', nebula, 'light'), 'dark');
  // With no look chosen, auto is the brand's own default, exactly as before.
  assert.equal(resolveVariant('auto', null, 'dark'), 'dark');
  assert.equal(resolveVariant('auto', null, 'light'), 'light');
});

// ── applying it ─────────────────────────────────────────────────────────────

/** The smallest thing applyReaderTheme can write to: an inline style bag. */
function styleTarget() {
  const props = new Map();
  return {
    props,
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
  };
}

test('applying a look writes its variant, and switching variant rewrites it', () => {
  const el = styleTarget();
  const wireless = readerTheme('wireless');
  applyReaderTheme(el, wireless, 'dark');
  assert.equal(el.props.get('--bg'), '#191310');
  assert.equal(el.props.get('color-scheme'), 'dark');
  assert.equal(el.props.get('--font-display'), '"Cinzel", Optima, Georgia, serif');
  applyReaderTheme(el, wireless, 'light');
  assert.equal(el.props.get('--bg'), '#EDE3D1');
  assert.equal(el.props.get('color-scheme'), 'light');
  // The fonts are the look's in both variants — a look is a typeface as well as
  // a palette, and theme.css states them only once, on the base block.
  assert.equal(el.props.get('--font-display'), '"Cinzel", Optima, Georgia, serif');
});

test('going back to the site’s own look leaves nothing behind', () => {
  const el = styleTarget();
  applyReaderTheme(el, readerTheme('nebula'), 'dark');
  assert.ok(el.props.size > 0);
  applyReaderTheme(el, null, 'dark');
  assert.equal(el.props.size, 0, 'a cleared look must leave the deployment’s own stylesheet unopposed');
});

test('switching between looks leaves no token from the previous one', () => {
  const el = styleTarget();
  applyReaderTheme(el, readerTheme('weatherglass'), 'light');
  applyReaderTheme(el, readerTheme('loveletter'), 'light');
  const loveletter = readerTheme('loveletter');
  assert.deepEqual(Object.fromEntries(el.props), { ...loveletter.light });
});

test('applying a look never touches a property that is not a theme token', () => {
  // --reader-font-scale and --reader-line-height live on the same element and
  // are a different reader preference; a look must not clear them.
  const el = styleTarget();
  el.style.setProperty('--reader-font-scale', '1.15');
  applyReaderTheme(el, readerTheme('nebula'), 'dark');
  applyReaderTheme(el, null, 'dark');
  assert.equal(el.props.get('--reader-font-scale'), '1.15');
});

// ── the presentation contract ───────────────────────────────────────────────

test('the injector lets readerTheme travel, and drops it when it is not an object', () => {
  const good = readPresentationAsset(JSON.stringify({ contractVersion: 1, readerTheme: { options: ['nebula'], forced: null } }), () => {});
  assert.deepEqual(good.readerTheme, { options: ['nebula'], forced: null });

  const warnings = [];
  const bad = readPresentationAsset(JSON.stringify({ contractVersion: 1, layout: 'flat', readerTheme: 'nebula' }), (m) => warnings.push(m));
  assert.equal(bad.readerTheme, undefined, 'a malformed group must be dropped, not travel');
  assert.equal(bad.layout, 'flat', 'and must not take its neighbours down with it');
  assert.match(warnings.join('\n'), /readerTheme/);
});

test('presentation.schema.json accepts the group and refuses a look that does not exist', () => {
  const ok = validate(
    { contractVersion: 1, readerTheme: { options: [...READER_THEME_IDS], forced: 'nebula' } },
    PRESENTATION_SCHEMA,
    { strict: true, label: 'presentation.json' }
  );
  assert.deepEqual(ok.errors, []);

  const nulled = validate({ contractVersion: 1, readerTheme: { forced: null } }, PRESENTATION_SCHEMA, {
    strict: true,
    label: 'presentation.json',
  });
  assert.deepEqual(nulled.errors, [], 'null is how "nothing is forced" is written');

  const bogus = validate({ contractVersion: 1, readerTheme: { options: ['aurora'] } }, PRESENTATION_SCHEMA, {
    strict: true,
    label: 'presentation.json',
  });
  assert.ok(bogus.errors.length > 0, 'a look this engine does not ship should be flagged when an operator writes it');
});

// ── the round trip, over the real app ───────────────────────────────────────

/** The kind of presentation a real deployment carries — nouns, tabs, copy. */
const LIVE_PRESENTATION = {
  contractVersion: 1,
  layout: 'series',
  nouns: { unit: 'log', unitPlural: 'logs', Unit: 'Log', UnitPlural: 'Logs', collection: 'mission', Collection: 'Mission' },
  nav: { position: 'side', items: ['home', 'library', 'settings'] },
  emptyState: { library: 'The archive holds nothing yet.' },
};

const LIVE_BRAND = {
  contractVersion: 1,
  id: 'nebula',
  name: 'The Long Archive',
  appName: 'Nebula',
  tagline: 'Every log the expedition sent back, kept in order.',
  author: 'Long Archive Press',
  themeColor: '#171A21',
  backgroundColor: '#171A21',
  defaultTheme: 'dark',
};

test('an operator forcing a look: the real route, the real store, the real resolver', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // Nothing installed: the deployment wears its build, and the portal has only
  // what was injected into its own page to send.
  const before = await dep.call('GET', '/api/admin/themes');
  assert.equal(before.status, 200);
  assert.equal(before.json.active, null);

  const saved = await dep.call('PUT', '/api/admin/themes/presentation', {
    presentation: { ...LIVE_PRESENTATION, readerTheme: { options: [...READER_THEME_IDS], forced: 'wireless' } },
    brand: LIVE_BRAND,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.active.presentation.readerTheme.forced, 'wireless');

  // What the SERVING path will read, not what the route echoed.
  const after = await dep.call('GET', '/api/admin/themes');
  assert.equal(after.json.active.hasPresentation, true);
  const live = after.json.active.presentation;
  assert.equal(live.readerTheme.forced, 'wireless');

  // The rest of the arrangement survived. This is the failure the route's
  // whole-document contract exists to prevent: storing the one key on its own
  // would have deleted the library's nouns and its tab order.
  assert.equal(live.layout, 'series');
  assert.deepEqual(live.nouns, LIVE_PRESENTATION.nouns);
  assert.deepEqual(live.nav.items, ['home', 'library', 'settings']);
  assert.equal(live.emptyState.library, 'The archive holds nothing yet.');

  // The identity survived too — a theme-preference save must not blank a brand.
  assert.equal(after.json.active.brand.appName, 'Nebula');
  assert.equal(after.json.active.brand.tagline, LIVE_BRAND.tagline);

  // And now the reader half, with the reader-side resolver fed exactly what the
  // server stored: a reader holding a different saved choice is moved onto the
  // forced look, and Settings will show it as fixed.
  const forDeviceHoldingNebula = resolveReaderTheme(live.readerTheme, 'nebula');
  assert.equal(forDeviceHoldingNebula.forced, true);
  assert.equal(forDeviceHoldingNebula.active.id, 'wireless');
  const el = styleTarget();
  applyReaderTheme(el, forDeviceHoldingNebula.active, resolveVariant('auto', forDeviceHoldingNebula.active, 'dark'));
  assert.equal(el.props.get('--bg'), '#191310');
});

test('un-forcing gives readers the picker back, and the saved version is a normal one', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await dep.call('PUT', '/api/admin/themes/presentation', {
    presentation: { ...LIVE_PRESENTATION, readerTheme: { options: [...READER_THEME_IDS], forced: 'wireless' } },
    brand: LIVE_BRAND,
  });
  const second = await dep.call('PUT', '/api/admin/themes/presentation', {
    presentation: { ...LIVE_PRESENTATION, readerTheme: { options: ['nebula', 'loveletter'], forced: null } },
    brand: LIVE_BRAND,
  });
  assert.equal(second.status, 200);

  const state = await dep.call('GET', '/api/admin/themes');
  const live = state.json.active.presentation;
  const resolved = resolveReaderTheme(live.readerTheme, 'nebula');
  assert.equal(resolved.forced, false);
  assert.equal(resolved.active.id, 'nebula');
  assert.deepEqual(resolved.options.map((x) => x.id), ['loveletter', 'nebula']);

  // Two versions in the history, the newer one live, rollback offered — this
  // save is not a special case in the version machinery.
  assert.equal(state.json.versions.length, 2);
  assert.equal(state.json.versions.filter((v) => v.live).length, 1);
  const older = state.json.versions.find((v) => !v.live);
  const rolled = await dep.call('POST', `/api/admin/themes/versions/${older.id}/activate`);
  assert.equal(rolled.status, 200);
  const back = await dep.call('GET', '/api/admin/themes');
  assert.equal(back.json.active.presentation.readerTheme.forced, 'wireless');
});

test('a presentation the engine cannot use at all is refused, and nothing is written', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const notObject = await dep.call('PUT', '/api/admin/themes/presentation', { presentation: 'nebula' });
  assert.equal(notObject.status, 400);

  const unknownLook = await dep.call('PUT', '/api/admin/themes/presentation', {
    presentation: { ...LIVE_PRESENTATION, readerTheme: { options: ['aurora'], forced: null } },
    brand: LIVE_BRAND,
  });
  assert.equal(unknownLook.status, 400);
  assert.match(unknownLook.json.message, /aurora|options/);

  const state = await dep.call('GET', '/api/admin/themes');
  assert.equal(state.json.active, null, 'a refused save must leave the deployment wearing what it wore');
  assert.equal(state.json.versions.length, 0);
});
