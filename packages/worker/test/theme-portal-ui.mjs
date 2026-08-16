// Drives the REAL admin Brand & Themes card against a REAL running deployment
// (AB#7417). Not a unit test with mocks: it mounts the shipped component into a
// DOM, points `fetch` at a live server, and clicks the buttons an operator
// clicks — install a package, roll back, save the brand form — then reads back
// what the same server serves.
//
// It needs a DOM implementation, which this repo deliberately does not depend
// on, so it takes one as an argument rather than adding a devDependency for a
// manual check:
//
//   npm i linkedom          (anywhere)
//   node --import tsx/esm packages/worker/test/theme-portal-ui.mjs \
//        http://127.0.0.1:8787 <cookie-header> <path/to/linkedom>
//
// See packages/worker/test/README.md.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [base, cookie, linkedomPath] = process.argv.slice(2);
if (!base || !cookie || !linkedomPath) {
  console.error('usage: theme-portal-ui.mjs <baseUrl> <cookieHeader> <path-to-linkedom>');
  process.exit(1);
}

const { parseHTML } = await import(
  linkedomPath.startsWith('.') || linkedomPath.includes('/') || linkedomPath.includes('\\')
    ? pathToFileURL(linkedomPath).href
    : linkedomPath
);
const dom = parseHTML('<!doctype html><html><body><div id="admin"></div></body></html>');

// Preact needs these on globalThis before it is imported.
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'SVGElement', 'File', 'FormData']) {
  if (dom[key]) globalThis[key] = dom[key];
}
globalThis.navigator ??= { userAgent: 'node' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Same-origin fetch, aimed at the live server, carrying the real admin session.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const absolute = url.startsWith('http') ? url : `${base}${url}`;
  return realFetch(absolute, { ...init, headers: { ...(init.headers ?? {}), cookie } });
};

const { render, h } = await import('preact');
const { ThemeSection } = await import('../../core/src/screens/admin/ThemeSection.tsx');

const root = dom.document.getElementById('admin');
render(h(ThemeSection, {}), root);

const settle = () => new Promise((r) => setTimeout(r, 400));
const text = () => root.textContent.replace(/\s+/g, ' ').trim();
const buttons = () => [...root.querySelectorAll('button')];
const button = (label) => buttons().find((b) => b.textContent.trim() === label);
const click = async (label) => {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" button. Buttons: ${buttons().map((x) => `"${x.textContent.trim()}"`).join(', ')}`);
  b.dispatchEvent(new dom.Event('click', { bubbles: true }));
  await settle();
};

await settle();
console.log('1. rendered  ›', text().slice(0, 200));

// Attach a real package to the real file input, exactly as a file picker does.
const file = process.env.THEME_PACKAGE ?? 'themes/storylark.storylark-theme.zip';
const bytes = readFileSync(file);
const input = root.querySelector('input[type="file"]');
input.files = [new dom.File([bytes], file.split(/[\\/]/).pop(), { type: 'application/zip' })];
input.dispatchEvent(new dom.Event('change', { bubbles: true }));
await settle();

await click('Check it first');
console.log('2. check     ›', text().match(/is valid[^.]*\./)?.[0] ?? text().slice(0, 300));

await click('Install');
await settle();
console.log('3. install   ›', text().match(/Installed\.[^.]*\./)?.[0] ?? text().slice(0, 300));

const served = async () => (await realFetch(`${base}/`).then((r) => r.text())).match(/"appName":"([^"]*)"/)?.[1];
console.log('   server now serves appName =', await served());

const rollbackButtons = buttons().filter((b) => b.textContent.trim() === 'Roll back to this');
console.log(`4. history   › ${rollbackButtons.length} rollback button(s) offered`);
if (rollbackButtons.length) {
  rollbackButtons[0].dispatchEvent(new dom.Event('click', { bubbles: true }));
  await settle();
  console.log('   rolled back ›', text().match(/Rolled back\.[^.]*\./)?.[0] ?? text().slice(0, 200));
  console.log('   server now serves appName =', await served());
}

await click('Edit brand details');
const appNameInput = [...root.querySelectorAll('label')].find((l) => l.textContent.startsWith('App name'))?.querySelector('input');
appNameInput.value = 'Edited In The Portal';
appNameInput.dispatchEvent(new dom.Event('input', { bubbles: true }));
await settle();
await click('Save brand details');
console.log('5. form save ›', text().match(/Saved\.[^.]*\./)?.[0] ?? text().slice(0, 300));
console.log('   server now serves appName =', await served());

console.log('\nfinal card text:\n' + text().slice(0, 700));
