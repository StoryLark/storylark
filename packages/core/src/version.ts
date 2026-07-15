/// <reference path="./virtual.d.ts" />
import build from 'virtual:storylark-build';

/**
 * Build identity, injected by the Vite preset at build time. The app version
 * IS storylark-core's npm version (single source of truth — matches the
 * Changesets CHANGELOG and the RELEASE-NOTES.md headings shown on About), and
 * the commit/timestamp pin exactly which site build is running. There is no
 * hand-bumped counter anymore: what you see on screen names a real release.
 */
export const BUILD = build;

/** The user-visible app version — storylark-core's npm version. */
export const APP_VERSION = build.coreVersion;
