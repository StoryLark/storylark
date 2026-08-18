import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { copyTemplate, installDependencies, runWizard, wizardArgs, writeProjectMarker } from '../bin/create-storylark.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function tempFolder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'create-storylark-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('template declares all three exact StoryLark packages and doctor', async (t) => {
  const dir = await tempFolder(t);
  copyTemplate(dir, 'my-library', 'My Library', '1.2.3', '1.2.4', '1.2.5');
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['storylark-core'], '1.2.3');
  assert.equal(pkg.dependencies['storylark-worker'], '1.2.4');
  assert.equal(pkg.devDependencies['storylark-pipeline'], '1.2.5');
  assert.equal(pkg.scripts.doctor, 'node platforms/doctor.mjs');
});

test('project marker records non-secret npm-create provenance', async (t) => {
  const dir = await tempFolder(t);
  writeProjectMarker(dir, 'my-library', {
    'storylark-core': '1.2.3',
    'storylark-worker': '1.2.4',
    'storylark-pipeline': '1.2.5',
  });
  const marker = JSON.parse(await readFile(join(dir, '.storylark', 'project.json'), 'utf8'));
  assert.equal(marker.contractVersion, 1);
  assert.equal(marker.installMethod, 'npm-create');
  assert.equal(marker.brandId, 'my-library');
  assert.equal(marker.platform, null);
  assert.deepEqual(Object.keys(marker.packages).sort(), ['storylark-core', 'storylark-pipeline', 'storylark-worker']);
});

test('default dependency installation runs npm install and propagates failure', () => {
  let call;
  installDependencies('C:/site', (command, args, options) => {
    call = { command, args, options };
    return { status: 0 };
  });
  assert.match(call.command, /^npm(?:\.cmd)?$/);
  assert.deepEqual(call.args, ['install']);
  assert.equal(call.options.cwd, 'C:/site');

  assert.throws(
    () => installDependencies('C:/site', () => ({ status: 17 })),
    /npm install failed with exit code 17/
  );
});

test('only setup arguments are forwarded to the wizard', () => {
  assert.deepEqual(
    wizardArgs([
      'site',
      '--name=site',
      '--brand=brand',
      '--app-name=App',
      '--deploy',
      '--yes',
      '--platform=cloudflare',
      'BRAND_ID=brand',
      'APP_ORIGIN=https://example.test',
    ]),
    ['--deploy', '--yes', '--platform=cloudflare', 'BRAND_ID=brand', 'APP_ORIGIN=https://example.test']
  );
});

test('wizard verifies before deploy and invokes the installer with --deploy --yes', async (t) => {
  const dir = await tempFolder(t);
  const platforms = join(dir, 'platforms');
  const cloudflare = join(platforms, 'cloudflare');
  await mkdir(cloudflare, { recursive: true });
  await mkdir(join(dir, '.storylark'), { recursive: true });
  await writeFile(
    join(dir, '.storylark', 'project.json'),
    JSON.stringify({ contractVersion: 1, installMethod: 'npm-create', platform: null, brandId: 'test' })
  );
  await copyFile(join(ROOT, 'platforms', 'wizard.mjs'), join(platforms, 'wizard.mjs'));
  await writeFile(
    join(cloudflare, 'install.mjs'),
    "import { appendFileSync } from 'node:fs'; appendFileSync(new URL('./calls.txt', import.meta.url), process.argv.slice(2).join(' ') + '\\n');\n"
  );

  await execFileAsync('node', [
    join(platforms, 'wizard.mjs'),
    '--platform=cloudflare',
    '--deploy',
    '--yes',
    'BRAND_ID=test',
    'APP_ORIGIN=https://example.test',
    'CONTENT_ORIGIN=',
    'MAIL_FROM=Test <test@example.test>',
    'APP_NAME=Test',
  ], { cwd: dir });

  const calls = (await readFile(join(cloudflare, 'calls.txt'), 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(calls, ['--verify', '--deploy --yes']);
  const marker = JSON.parse(await readFile(join(dir, '.storylark', 'project.json'), 'utf8'));
  assert.equal(marker.platform, 'cloudflare');
});

test('runWizard fails loudly when setup fails', () => {
  assert.throws(() => runWizard('C:/site', ['--deploy'], () => ({ status: 9 })), /setup failed with exit code 9/);
});
