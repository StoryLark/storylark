// Types for theme-package.mjs. Hand-written rather than generated: the module
// is plain ESM with JSDoc, and `storylark-worker` (the one TypeScript consumer)
// needs only this surface.

export declare const THEME_PACKAGE_FORMAT: number;
export declare const THEME_PACKAGE_EXT: string;
export declare const MANIFEST_ENTRY: string;
export declare const BRAND_ENTRY: string;
export declare const THEME_CSS_ENTRY: string;
export declare const PRESENTATION_ENTRY: string;
export declare const ICONS_PREFIX: string;

export declare const THEME_PACKAGE_LIMITS: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number };

export interface IconSpec {
  kind: 'png' | 'svg';
  width?: number;
  height?: number;
}
export declare const REQUIRED_ICONS: Record<string, IconSpec>;
export declare const OPTIONAL_ICONS: Record<string, IconSpec>;
export declare const REQUIRED_COLOR_TOKENS: string[];
export declare const REQUIRED_FONT_TOKENS: string[];

export declare class ThemePackageError extends Error {
  constructor(errors: string[], warnings?: string[]);
  errors: string[];
  warnings: string[];
}

export interface ThemeManifest {
  formatVersion: number;
  id: string;
  name: string;
  version: string;
  contractVersion?: number;
  hasPresentation?: boolean;
  engine?: string;
  createdAt?: string;
}

export interface ThemeParts {
  brand: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  themeCss: string;
  icons: Map<string, Uint8Array>;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export declare function validateThemeParts(
  parts: ThemeParts,
  opts?: { fontFamilies?: string[]; strict?: boolean }
): ValidationResult;

export declare function validateThemeCss(
  css: string,
  brand: Record<string, unknown>,
  fontFamilies?: string[]
): ValidationResult;

export declare function validateIcons(icons: Map<string, Uint8Array>): ValidationResult;

export declare function pngSize(bytes: Uint8Array): { width: number; height: number } | null;

export declare function buildThemePackage(
  parts: ThemeParts & { version?: string; engine?: string; fontFamilies?: string[]; createdAt?: Date }
): Promise<{ bytes: Uint8Array; manifest: ThemeManifest; warnings: string[] }>;

export declare function readThemePackage(
  bytes: Uint8Array | ArrayBuffer,
  opts?: { fontFamilies?: string[] }
): Promise<{
  manifest: ThemeManifest;
  brand: Record<string, unknown>;
  presentation: Record<string, unknown> | undefined;
  themeCss: string;
  icons: Map<string, Uint8Array>;
  warnings: string[];
}>;
