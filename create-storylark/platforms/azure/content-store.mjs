// Writable content storage for the Node entry (AB#7420).
//
// Cloudflare gets this for free: `env.CONTENT` is already an R2 binding the
// Worker can write through, so packages/worker/src/lib/content-store.ts's
// r2ContentStore() needs no credential and no configuration. Everywhere else,
// the process has to be told where content lives and how to authenticate — and
// that is deliberately the PLATFORM entry's job, not the engine's: it keeps the
// Azure SDK (and any other provider's) out of the Worker bundle entirely, and
// it means adding a provider is a file here rather than a change to the engine.
//
// Two drivers, selected by environment:
//
//   AZURE_STORAGE_CONNECTION_STRING + CONTENT_CONTAINER
//       Azure Blob. Same container-per-brand model, the same key space and the
//       same cache-control policy packages/pipeline/storage-azure.mjs writes
//       with, so a portal edit and a CLI publish are interchangeable.
//
//   STORYLARK_LOCAL_CONTENT=<dir>
//       A directory on disk, mirroring the object layout one-for-one. This is
//       the same shape `publish.mjs --local <dir>` produces, so a site can be
//       published, served and edited end-to-end with no cloud account at all —
//       which is also what makes this path testable for real.
//
// Without either, the entry binds nothing, and the portal's content routes
// answer 501 with an explanation instead of failing in a confusing way.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * A ContentStore over a local directory.
 *
 * Every key is resolved inside `root` and rejected if it escapes — the keys
 * come from route parameters that are already id-validated, but a path
 * traversal here would be a filesystem write from an HTTP request, so it gets
 * a second check rather than a comment saying it can't happen.
 */
export function localContentStore(root) {
  const base = resolve(root);
  const pathFor = (key) => {
    const full = resolve(base, key);
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`content key escapes the content root: ${key}`);
    return full;
  };
  return {
    async get(key) {
      try {
        const buf = await readFile(pathFor(key));
        return { body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
    async put(key, body, opts) {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      // Content type and caching come from the serving layer by extension here,
      // exactly as they do for `publish.mjs --local` — a directory has nowhere
      // to record them, and the layout is the point, not the metadata.
      void opts;
      await writeFile(file, typeof body === 'string' ? body : Buffer.from(body));
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

/** A ContentStore over an Azure Blob container. */
export function azureBlobContentStore(connectionString, container) {
  let containerClient;
  const client = async () => {
    if (!containerClient) {
      // Imported lazily so a deployment that never edits content doesn't pay
      // the SDK's load cost on every cold start, and so a site running without
      // AZURE_STORAGE_CONNECTION_STRING boots fine whatever is installed.
      const { BlobServiceClient } = await import('@azure/storage-blob').catch(() => {
        throw new Error(
          '@azure/storage-blob is not installed, so content cannot be written to Blob storage. Run `npm install` in platforms/azure, or unset AZURE_STORAGE_CONNECTION_STRING to run without portal content editing.'
        );
      });
      containerClient = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container);
      await containerClient.createIfNotExists({ access: 'blob' });
    }
    return containerClient;
  };
  return {
    async get(key) {
      const blob = (await client()).getBlockBlobClient(key);
      try {
        const buf = await blob.downloadToBuffer();
        return { body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      } catch (err) {
        if (err?.statusCode === 404) return null;
        throw err;
      }
    },
    async put(key, body, opts) {
      const blob = (await client()).getBlockBlobClient(key);
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      await blob.upload(buf, buf.length, {
        blobHTTPHeaders: {
          blobContentType: opts?.contentType ?? 'application/octet-stream',
          blobCacheControl: opts?.cacheControl ?? IMMUTABLE,
        },
      });
    },
    async delete(key) {
      await (await client()).getBlockBlobClient(key).deleteIfExists();
    },
  };
}

/** Whichever driver this process's environment describes, or null for none. */
export function contentStoreFromEnv(processEnv = process.env) {
  if (processEnv.STORYLARK_LOCAL_CONTENT) {
    return { store: localContentStore(processEnv.STORYLARK_LOCAL_CONTENT), driver: `local (${processEnv.STORYLARK_LOCAL_CONTENT})` };
  }
  if (processEnv.AZURE_STORAGE_CONNECTION_STRING) {
    const container = processEnv.CONTENT_CONTAINER || `${processEnv.BRAND ?? 'storylark'}-content`;
    return {
      store: azureBlobContentStore(processEnv.AZURE_STORAGE_CONNECTION_STRING, container),
      driver: `azure-blob (${container})`,
    };
  }
  return { store: null, driver: null };
}

export { join };
