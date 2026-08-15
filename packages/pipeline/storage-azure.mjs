// Azure Blob Storage driver (AB#7399) — the pipeline's upload seam for
// Azure deployments. Mirrors r2-upload.mjs's interface exactly (same
// function names/signatures) so storage.mjs can select between them with no
// call-site changes in publish.mjs. Same local-mirror fallback as r2-upload
// for offline/no-account development.
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';

let serviceClient;
function client() {
  if (!serviceClient) {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is required for the azure-blob storage provider');
    serviceClient = BlobServiceClient.fromConnectionString(conn);
  }
  return serviceClient;
}

export async function putObject(bucket, key, file, contentType, cacheControl) {
  const localDir = process.env.STORYLARK_LOCAL_R2;
  if (localDir) {
    const dest = join(localDir, key);
    await mkdir(dirname(dest), { recursive: true });
    await cp(file, dest);
    return;
  }
  // Azure containers can't embed a slash-containing bucket-per-brand name the
  // way R2 does; the brand id becomes the container, matching one container
  // per brand the same way R2 uses one bucket per brand.
  const container = client().getContainerClient(bucket);
  await container.createIfNotExists({ access: 'blob' });
  const blockBlob = container.getBlockBlobClient(key);
  await blockBlob.uploadFile(file, {
    blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: cacheControl },
  });
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=60';

export async function putJson(bucket, key, file, immutable = true) {
  await putObject(bucket, key, file, 'application/json', immutable ? IMMUTABLE : SHORT);
}

export async function putAudio(bucket, key, file) {
  await putObject(bucket, key, file, 'audio/mpeg', IMMUTABLE);
}

export async function putImage(bucket, key, file) {
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  await putObject(bucket, key, file, type, IMMUTABLE);
}
