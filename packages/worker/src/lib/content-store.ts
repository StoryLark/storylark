/**
 * The Worker's content-storage seam (AB#7420).
 *
 * The publish pipeline already has one of these — `packages/pipeline/storage.mjs`,
 * with an R2 driver and an Azure Blob driver — but it is a Node module built on
 * `wrangler r2 object put` and `@azure/storage-blob`, neither of which exists
 * inside a request. This is the same seam expressed for the serving side:
 * the same key space, the same cache-control policy, the same one-container-
 * per-brand model, reachable from a route handler.
 *
 * Two drivers ship here:
 *   • `r2ContentStore` — Cloudflare, over the CONTENT binding already declared
 *     in wrangler.jsonc. No credential, no network hop, no new configuration.
 *   • `httpContentStore` is deliberately NOT provided. Reading content over its
 *     public origin would work; writing to it would need a credential in the
 *     deployment, which is the thing this project keeps refusing to do.
 *
 * Everything else (Azure Blob, a local directory for `wrangler`-free dev) is
 * bound by the platform entry that already holds those credentials — see
 * `platforms/azure/content-store.mjs`. Route code only ever sees `ContentStore`.
 *
 * Deliberately no `list()`. Every read path here is index-driven — the manifest
 * lists books and chapters, a per-chapter `index.json` lists revisions — so a
 * new driver needs three trivial methods rather than an ordered, paginated,
 * metadata-carrying listing API that each provider spells differently.
 */

export interface StoredObject {
  body: ArrayBuffer;
  contentType?: string;
}

export interface PutOptions {
  contentType: string;
  /** Defaults to IMMUTABLE — every key this Worker writes except the manifest is content-hashed. */
  cacheControl?: string;
}

export interface ContentStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: ArrayBuffer | Uint8Array | string, opts: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Matches packages/pipeline/r2-upload.mjs exactly — the CLI and the portal must agree. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=60';

export function r2ContentStore(bucket: R2Bucket): ContentStore {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType };
    },
    async put(key, body, opts) {
      await bucket.put(key, body as ArrayBuffer | string, {
        httpMetadata: { contentType: opts.contentType, cacheControl: opts.cacheControl ?? IMMUTABLE },
      });
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** Read a stored object as UTF-8 text, or null when it isn't there. */
export async function getText(store: ContentStore, key: string): Promise<string | null> {
  const obj = await store.get(key);
  return obj === null ? null : new TextDecoder().decode(obj.body);
}

/** Read + parse a stored JSON object. A corrupt body reads as null, never throws. */
export async function getJson<T>(store: ContentStore, key: string): Promise<T | null> {
  const text = await getText(store, key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function putJson(store: ContentStore, key: string, value: unknown, immutable = true): Promise<void> {
  await store.put(key, JSON.stringify(value), {
    contentType: 'application/json',
    cacheControl: immutable ? IMMUTABLE : SHORT,
  });
}

export async function putText(store: ContentStore, key: string, value: string, immutable = false): Promise<void> {
  await store.put(key, value, {
    contentType: 'text/markdown; charset=utf-8',
    cacheControl: immutable ? IMMUTABLE : SHORT,
  });
}
