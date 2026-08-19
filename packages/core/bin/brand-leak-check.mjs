import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
]);

/**
 * Find brand-authored strings in an engine build.
 *
 * A string that also exists in engine source or an installed dependency is not
 * evidence of a leak: dependencies legitimately contain words such as
 * "serial". Remove that independent vocabulary before scanning the output so
 * the check stays strict without producing dependency-driven false positives.
 */
export function findBrandLeaks({ root, coreDir, distDir, engineSourceRoots }) {
  const needles = collectBrandNeedles(root);
  const independentRoots = engineSourceRoots ?? [
    join(coreDir, 'src'),
    join(coreDir, 'vite'),
    join(coreDir, 'schemas'),
    join(root, 'packages', 'contracts'),
    join(root, 'app', 'index.html'),
    ...directDependencyRoots(root, coreDir),
  ];

  for (const file of independentRoots.flatMap((source) => sourceFiles(source))) {
    removeMatches(needles, readFileSync(file));
    if (!needles.size) return [];
  }

  const leaks = [];
  for (const file of allFiles(distDir)) {
    const body = readFileSync(file);
    for (const [needle, source] of needles) {
      if (body.includes(Buffer.from(needle, 'utf8'))) {
        leaks.push(`${relative(distDir, file).split(sep).join('/')}  <- ${JSON.stringify(needle)} (${source})`);
      }
    }
  }
  return leaks;
}

function collectBrandNeedles(root) {
  const needles = new Map();
  const brandsDir = join(root, 'brands');
  if (!existsSync(brandsDir)) return needles;

  const collect = (file, source) => {
    if (!existsSync(file)) return;
    const push = (value) => {
      if (typeof value === 'string') {
        if (value.length > 4) needles.set(value, source);
      } else if (Array.isArray(value)) value.forEach(push);
      else if (value && typeof value === 'object') Object.values(value).forEach(push);
    };
    push(JSON.parse(readFileSync(file, 'utf8')));
  };

  for (const id of readdirSync(brandsDir)) {
    collect(join(brandsDir, id, 'brand.json'), `brands/${id}/brand.json`);
    collect(join(root, 'presentation', id, 'presentation.json'), `presentation/${id}/presentation.json`);
  }
  return needles;
}

function removeMatches(needles, body) {
  for (const needle of needles.keys()) {
    if (body.includes(Buffer.from(needle, 'utf8'))) needles.delete(needle);
  }
}

function directDependencyRoots(root, coreDir) {
  const manifest = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'));
  return Object.keys(manifest.dependencies ?? {}).map((name) => join(root, 'node_modules', ...name.split('/')));
}

function sourceFiles(path) {
  return allFiles(path).filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
}

function allFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => allFiles(join(path, entry.name)));
}
