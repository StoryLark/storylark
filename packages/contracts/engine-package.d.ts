export declare const BRAND_OWNED_OUTPUTS: string[];
export declare const BRAND_OWNED_PREFIXES: string[];
export declare function isBrandOwned(path: string): boolean;

export declare const ENGINE_PACKAGE_EXT: string;
export declare const ENGINE_PACKAGE_LIMITS: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number };

export declare class EnginePackageError extends Error {
  errors: string[];
  warnings: string[];
  constructor(errors: string[], warnings?: string[]);
}

export interface EngineManifest {
  formatVersion: 1;
  coreVersion: string;
  workerVersion: string;
  commit: string | null;
  builtAt: string | null;
  brandOwned: string[];
  files: Record<string, { sha256: string; size: number }>;
}

export declare function engineAssetName(version: string): string;
export declare function engineChecksumName(version: string): string;
export declare function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string>;
export declare function parseChecksumFile(text: string, filename: string): string | null;

export declare function buildEnginePackage(args: {
  dist: Map<string, Uint8Array>;
  worker?: Uint8Array;
  migrations?: Map<string, Uint8Array>;
  migrationsPostgres?: Map<string, Uint8Array>;
  coreVersion: string;
  workerVersion: string;
  commit?: string;
  builtAt?: string;
}): Promise<{ bytes: Uint8Array; manifest: EngineManifest }>;

export declare function readEnginePackage(
  bytes: Uint8Array | ArrayBuffer,
  limits?: Partial<typeof ENGINE_PACKAGE_LIMITS>
): Promise<{
  manifest: EngineManifest;
  dist: Map<string, Uint8Array>;
  worker?: Uint8Array;
  migrations: Map<string, Uint8Array>;
  migrationsPostgres: Map<string, Uint8Array>;
  warnings: string[];
}>;
