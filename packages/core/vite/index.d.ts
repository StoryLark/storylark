import type { UserConfig, UserConfigFnObject } from 'vite';

export interface StorylarkConfigOptions {
  /** Directory holding brand folders, relative to the site root. Default: `brands`. */
  brandsRoot?: string;
  /** Fixed brand id — skips `--mode <id>` selection. */
  brandId?: string;
  /** Site-level Vite overrides, merged last. */
  vite?: UserConfig;
}

/**
 * The @storylark/core build preset. A site's whole vite.config.ts:
 *
 *   import { defineStorylarkConfig } from '@storylark/core/vite';
 *   export default defineStorylarkConfig();
 */
export function defineStorylarkConfig(options?: StorylarkConfigOptions): UserConfigFnObject;
