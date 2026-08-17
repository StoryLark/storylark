#!/usr/bin/env node
// The one shared setup wizard (AB#7402). Every entry path funnels here:
// clone + `npm run setup`, an npm-copied folder, or the one-experience
// installer. Asks which platform, collects that platform's install.env
// values, writes the file, then hands off to that platform's own
// install.mjs --verify (and offers --deploy). No install logic lives here —
// this only ever fills out the form and presses the button.
import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLATFORMS = {
  cloudflare: {
    label: 'Cloudflare (Workers + D1 + R2)',
    dir: 'cloudflare',
    fields: [
      ['BRAND_ID', 'Brand id (lowercase, e.g. "my-story-app")'],
      ['APP_ORIGIN', 'App URL (e.g. https://app.example.com)'],
      // Optional since AB#7395: blank = same-origin — the Worker serves
      // content from the R2 bucket at the app's own domain, so a first
      // deploy needs no R2 custom domain and no DNS work at all. A separate
      // content domain is an optimisation (content bypasses the Worker),
      // not a requirement.
      [
        'CONTENT_ORIGIN',
        'Content URL — optional. Leave blank to serve content from the app\'s own domain (recommended to start; no DNS setup). Set e.g. https://content.example.com only for a separate content domain/CDN',
      ],
      ['MAIL_FROM', 'From address for emails (e.g. "My App <noreply@example.com>")'],
      ['APP_NAME', 'App display name'],
    ],
  },
  azure: {
    label: 'Azure (App Service + PostgreSQL + Blob Storage)',
    dir: 'azure',
    fields: [
      ['BRAND_ID', 'Brand id (lowercase, e.g. "my-story-app")'],
      ['AZURE_RESOURCE_GROUP', 'Azure resource group name'],
      ['AZURE_LOCATION', 'Azure region (e.g. eastus)'],
      ['DB_ADMIN_PASSWORD', 'Postgres admin password (12+ characters)'],
      ['APP_NAME', 'App display name'],
    ],
  },
};

async function promptPlatform(rl) {
  const keys = Object.keys(PLATFORMS);
  console.log('Which platform are you deploying to?\n');
  keys.forEach((k, i) => console.log(`  ${i + 1}. ${PLATFORMS[k].label}`));
  const answer = await rl.question('\n> ');
  const choice = keys[Number(answer) - 1];
  if (!choice) {
    console.error('Not a valid choice.');
    process.exit(1);
  }
  return choice;
}

async function collectValues(rl, platform) {
  console.log(`\nSetting up ${PLATFORMS[platform].label}:\n`);
  const values = {};
  for (const [key, prompt] of PLATFORMS[platform].fields) {
    values[key] = await rl.question(`${prompt}: `);
  }
  return values;
}

function writeEnvFile(platform, values) {
  const path = join(__dirname, PLATFORMS[platform].dir, 'install.env');
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(path, body);
  return path;
}

async function main() {
  // Non-interactive mode for the one-experience installer / CI: pass
  // --platform=<name> plus KEY=value pairs as remaining args.
  const argv = process.argv.slice(2);
  const platformArg = argv.find((a) => a.startsWith('--platform='))?.split('=')[1];

  let platform;
  let values;
  if (platformArg && PLATFORMS[platformArg]) {
    platform = platformArg;
    values = {};
    for (const arg of argv.filter((a) => a.includes('=') && !a.startsWith('--platform='))) {
      const [k, ...rest] = arg.split('=');
      values[k] = rest.join('=');
    }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    platform = await promptPlatform(rl);
    values = await collectValues(rl, platform);
    rl.close();
  }

  const envPath = writeEnvFile(platform, values);
  console.log(`\nWrote ${envPath}`);

  // Best-effort: publish.yml (content publishing, AB#7405) reads this repo
  // variable to know which storage flag to pass. Skips silently if gh isn't
  // installed/authenticated or this isn't a git repo yet — the workflow's own
  // comments document setting it by hand as a fallback. Nothing about platform
  // *updates* depends on this: those run from your own machine via the
  // installer's --update mode, with no CI and no GitHub credential involved.
  try {
    execFileSync('gh', ['variable', 'set', 'STORYLARK_PLATFORM', '--body', platform], {
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
    console.log(`✓ Set the STORYLARK_PLATFORM=${platform} repo variable for publish.yml`);
  } catch {
    console.log(`(Skipped setting STORYLARK_PLATFORM automatically — set it by hand in your repo's Actions variables for publish.yml to work: ${platform})`);
  }

  const installerDir = join(__dirname, PLATFORMS[platform].dir);
  console.log(`\nRunning ${PLATFORMS[platform].dir}'s installer (--verify)...\n`);
  const result = spawnSync(process.execPath, [join(installerDir, 'install.mjs'), '--verify'], {
    stdio: 'inherit',
    cwd: installerDir,
  });
  process.exit(result.status ?? 0);
}

main();
