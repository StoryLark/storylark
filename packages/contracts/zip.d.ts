export declare const ZIP_LIMITS: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number };

export declare function crc32(bytes: Uint8Array): number;

export declare function zip(
  entries: { name: string; data: Uint8Array | string; store?: boolean }[],
  opts?: { date?: Date }
): Promise<Uint8Array>;

export declare function unzip(
  input: Uint8Array | ArrayBuffer,
  limits?: Partial<typeof ZIP_LIMITS>
): Promise<Map<string, Uint8Array>>;

export declare class ZipError extends Error {}

export declare function assertSafeName(name: string): void;
