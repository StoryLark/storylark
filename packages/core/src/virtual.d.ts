// Virtual modules provided by the storylark-core Vite preset
// (defineStorylarkConfig in ../vite/index.mjs).
declare module 'virtual:storylark-config' {
  import type { Brand } from './lib/types';
  const config: Brand;
  export default config;
}

// Deployment config as it stood at BUILD time (deployment/<id>/deployment.json
// plus any STORYLARK_* build overrides). This is the fallback only — the live
// values come from the serving platform at request time. Always read
// ../deployment.ts's DEPLOYMENT rather than importing this directly.
declare module 'virtual:storylark-deployment' {
  import type { DeploymentConfig } from './lib/types';
  const deployment: DeploymentConfig;
  export default deployment;
}

// The presentation as the file STATED it at BUILD time
// (presentation/<id>/presentation.json, unknown keys removed). This is the
// fallback only — the live values come from the serving platform at request
// time, and everything absent comes from DEFAULT_PRESENTATION. Always read
// ../presentation.ts's PRESENTATION rather than importing this directly.
declare module 'virtual:storylark-presentation' {
  import type { PresentationInput } from './lib/types';
  const presentation: PresentationInput;
  export default presentation;
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
    /**
     * The overall release/build number, `YYMM.BUILD.PATCH` — separate from
     * each package's own independently-versioned semver (AB#7653). See
     * computeReleaseBuild in ../vite/index.mjs for how it's derived. Always
     * present (an ordinal of 1 rather than absent, outside a git checkout),
     * so this is not optional — but a build made by an OLDER core still
     * lacks it in dist/outputs.json, so every reader of THAT file must treat
     * it as optional.
     */
    releaseBuild: string;
  }
  const build: BuildInfo;
  export default build;
}
