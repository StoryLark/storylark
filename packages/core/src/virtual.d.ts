// Virtual modules provided by the storylark-core Vite preset
// (defineStorylarkConfig in ../vite/index.mjs).
declare module 'virtual:storylark-config' {
  import type { Brand } from './lib/types';
  const config: Brand;
  export default config;
}

// Side-effect module: @fontsource imports generated from the brand's `fonts`.
declare module 'virtual:storylark-fonts';

// Build identity captured by the preset at build time (see resolveBuildInfo).
declare module 'virtual:storylark-build' {
  interface BuildInfo {
    /** storylark-core npm version — the release the running app corresponds to. */
    coreVersion: string;
    /** Versions of every storylark-* package installed for this site build. */
    versions: Record<string, string>;
    /** Short git SHA of the site build, or 'local' outside a checkout. */
    commit: string;
    /** ISO timestamp of when the build ran. */
    builtAt: string;
    /** Brand the build was made for. */
    brandId: string;
  }
  const build: BuildInfo;
  export default build;
}
