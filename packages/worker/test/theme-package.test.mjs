// The theme package format, against the REAL brands in this repo (AB#7417).
//
// Not fixtures: `brands/storylark` and the four sample themes are the artifacts
// customers copy, so they are what the format has to be true of. A change to
// the validator that a real shipped theme would fail is a change that breaks
// every adopter, and this is where that gets caught.
//
// The round trip matters as much as the validation. `npm run package-theme`
// emits, the deployment's import endpoint reads, and the portal's download
// re-emits — so build → read → build has to be a fixed point, or a theme would
// degrade slightly every time it moved between two deployments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildThemePackage, readThemePackage, ThemePackageError, REQUIRED_ICONS } from 'storylark-contracts/theme-package';
import { zip, unzip } from 'storylark-contracts/zip';

const BRANDS = ['storylark', 'weatherglass', 'nebula', 'loveletter', 'wireless'];

function loadBrand(id) {
  const iconsDir = join('brands', id, 'assets', 'icons');
  const icons = new Map();
  for (const name of readdirSync(iconsDir)) icons.set(name, new Uint8Array(readFileSync(join(iconsDir, name))));
  const presentationFile = join('presentation', id, 'presentation.json');
  return {
    brand: JSON.parse(readFileSync(join('brands', id, 'brand.json'), 'utf8')),
    themeCss: readFileSync(join('brands', id, 'theme.css'), 'utf8'),
    icons,
    presentation: existsSync(presentationFile) ? JSON.parse(readFileSync(presentationFile, 'utf8')) : undefined,
  };
}

test('every brand shipped in this repo packages, and packages clean', async () => {
  for (const id of BRANDS) {
    const parts = loadBrand(id);
    const built = await buildThemePackage(parts);
    assert.equal(built.manifest.id, id, `${id}: manifest id`);
    assert.deepEqual(built.warnings, [], `${id}: packaged with warnings`);
    assert.ok(built.bytes.length > 1000, `${id}: suspiciously small package`);
  }
});

test('build → read → build is a fixed point, so a theme survives being moved', async () => {
  for (const id of BRANDS) {
    const first = await buildThemePackage(loadBrand(id));
    const read = await readThemePackage(first.bytes);
    const second = await buildThemePackage({
      brand: read.brand,
      presentation: read.presentation,
      themeCss: read.themeCss,
      icons: read.icons,
      version: read.manifest.version,
      engine: read.manifest.engine,
    });
    assert.deepEqual(Buffer.from(second.bytes), Buffer.from(first.bytes), `${id}: round trip changed the bytes`);
  }
});

test('theme packages are byte-for-byte identical across platform line endings', async () => {
  const lf = loadBrand('storylark');
  lf.themeCss = lf.themeCss.replace(/\r\n?/g, '\n');
  for (const [name, bytes] of lf.icons) {
    if (!name.endsWith('.svg')) continue;
    const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n');
    lf.icons.set(name, new TextEncoder().encode(text));
  }

  const crlf = {
    ...lf,
    themeCss: lf.themeCss.replace(/\n/g, '\r\n'),
    icons: new Map(lf.icons),
  };
  for (const [name, bytes] of crlf.icons) {
    if (!name.endsWith('.svg')) continue;
    const text = new TextDecoder().decode(bytes).replace(/\n/g, '\r\n');
    crlf.icons.set(name, new TextEncoder().encode(text));
  }

  const [fromLf, fromCrlf] = await Promise.all([buildThemePackage(lf), buildThemePackage(crlf)]);
  assert.deepEqual(Buffer.from(fromCrlf.bytes), Buffer.from(fromLf.bytes));
});

test('the archive contains exactly the format §0c describes', async () => {
  const { bytes } = await buildThemePackage(loadBrand('wireless'));
  const entries = [...(await unzip(bytes)).keys()].sort();
  assert.deepEqual(entries, [
    'brand.json',
    'icons/favicon-180.png',
    'icons/favicon-32.png',
    'icons/favicon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/logo.svg',
    'package.json',
    'presentation.json',
    'theme.css',
  ]);
});

test('a package with no presentation is valid — installing a look is not a request to rearrange', async () => {
  const parts = loadBrand('storylark');
  delete parts.presentation;
  const built = await buildThemePackage(parts);
  const read = await readThemePackage(built.bytes);
  assert.equal(read.presentation, undefined);
  assert.equal(read.manifest.hasPresentation, false);
});

test('a wrong contractVersion is refused — the one hard gate', async () => {
  const parts = loadBrand('storylark');
  await assert.rejects(
    () => buildThemePackage({ ...parts, brand: { ...parts.brand, contractVersion: 99 } }),
    (err) => err instanceof ThemePackageError && /contractVersion 99/.test(err.errors[0])
  );
});

test('a missing required icon is refused, by name and with the reason', async () => {
  for (const missing of Object.keys(REQUIRED_ICONS)) {
    const parts = loadBrand('storylark');
    parts.icons.delete(missing);
    await assert.rejects(
      () => buildThemePackage(parts),
      (err) => err instanceof ThemePackageError && err.errors.some((e) => e.includes(`icons/${missing} is missing`)),
      `${missing} was accepted while absent`
    );
  }
});

test('an icon at the wrong pixel size is refused — the failure nobody notices for weeks', async () => {
  const parts = loadBrand('storylark');
  parts.icons.set('icon-512.png', parts.icons.get('icon-192.png')); // a real PNG, wrong size
  await assert.rejects(
    () => buildThemePackage(parts),
    (err) => err instanceof ThemePackageError && err.errors.some((e) => /icon-512\.png is 192×192/.test(e))
  );
});

test('a stylesheet missing tokens, or missing the alternate scheme, is refused', async () => {
  const parts = loadBrand('storylark');
  await assert.rejects(
    () => buildThemePackage({ ...parts, themeCss: ':root { --bg: #fff; }' }),
    (err) =>
      err instanceof ThemePackageError &&
      err.errors.some((e) => /does not set --bg-raised/.test(e)) &&
      err.errors.some((e) => /:root\[data-theme="dark"\]/.test(e))
  );
});

test('a dark-first brand needs a LIGHT alternate block, not a dark one', async () => {
  const parts = loadBrand('wireless'); // defaultTheme: dark, so :root IS the dark theme
  const swapped = parts.themeCss.replace('data-theme="light"', 'data-theme="dark"');
  await assert.rejects(
    () => buildThemePackage({ ...parts, themeCss: swapped }),
    (err) => err instanceof ThemePackageError && err.errors.some((e) => /the block that is missing is `:root\[data-theme="light"\]`/.test(e))
  );
});

test('a package zipped with its own folder around it still reads', async () => {
  const parts = loadBrand('nebula');
  const built = await buildThemePackage(parts);
  const inner = await unzip(built.bytes);
  const wrapped = await zip([...inner].map(([name, data]) => ({ name: `nebula/${name}`, data, store: true })));
  const read = await readThemePackage(wrapped);
  assert.equal(read.brand.id, 'nebula');
});

test('a zip entry that escapes the archive root is refused', async () => {
  // Hand-built: the writer refuses to produce one of these, which is the point.
  await assert.rejects(() => zip([{ name: '../evil.txt', data: 'x' }]), /relative path segment/);
  await assert.rejects(() => zip([{ name: '/etc/passwd', data: 'x' }]), /absolute path/);
});

test('a truncated upload is caught by the checksum, not applied', async () => {
  const { bytes } = await buildThemePackage(loadBrand('loveletter'));
  const truncated = bytes.slice(0, bytes.length - 40);
  await assert.rejects(() => readThemePackage(truncated), (err) => err instanceof ThemePackageError);
});

test('something that is not a zip at all fails with an explanation, not a stack trace', async () => {
  await assert.rejects(
    () => readThemePackage(new TextEncoder().encode('this is a brand, honest'.repeat(10))),
    (err) => err instanceof ThemePackageError && /not a zip archive|too small/.test(err.errors[0])
  );
});

test('the committed default package is the real brands/storylark, byte for byte', async (t) => {
  const file = 'themes/storylark.storylark-theme.zip';
  if (!existsSync(file)) return t.skip('no committed default package');
  const committed = new Uint8Array(readFileSync(file));
  const rebuilt = await buildThemePackage({ ...loadBrand('storylark'), engine: JSON.parse(readFileSync('packages/core/package.json', 'utf8')).version });
  assert.deepEqual(
    Buffer.from(committed),
    Buffer.from(rebuilt.bytes),
    'themes/storylark.storylark-theme.zip is stale — re-run `npm run package-theme -- storylark`'
  );
});
