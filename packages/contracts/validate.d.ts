export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export declare const BRAND_SCHEMA: Record<string, unknown>;
export declare const PRESENTATION_SCHEMA: Record<string, unknown>;
export declare const DEPLOYMENT_SCHEMA: Record<string, unknown>;

export declare const SUPPORTED_CONTRACT_VERSION: number;
export declare const MIN_SUPPORTED_CONTRACT_VERSION: number;
export declare const RELOCATED_BRAND_KEYS: Record<string, string>;
export declare const DEPLOYMENT_DEFAULTS: Readonly<{ appOrigin: string; contentOrigin: string; vapidPublicKey: string }>;

export declare function validate(
  doc: unknown,
  schema: Record<string, unknown>,
  opts?: { strict?: boolean; label?: string }
): ValidationResult;

export declare function assertValid<T>(
  doc: T,
  schema: Record<string, unknown>,
  opts?: { strict?: boolean; label?: string; onWarn?: (msg: string) => void }
): T;
