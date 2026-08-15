// Storage seam (AB#7399) — publish.mjs imports from here instead of a
// specific provider, selected by --storage flag or STORYLARK_STORAGE
// env var. Cloudflare (r2-upload.mjs, the reference driver) stays default
// so every existing deployer's publish command is unchanged.
import * as r2 from './r2-upload.mjs';
import * as azureBlob from './storage-azure.mjs';

const PROVIDERS = { r2, 'azure-blob': azureBlob };

export function resolveProvider(name) {
  const provider = PROVIDERS[name ?? process.env.STORYLARK_STORAGE ?? 'r2'];
  if (!provider) {
    throw new Error(`Unknown storage provider "${name}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}
