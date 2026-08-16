/**
 * The admin portal's brand & theme API (AB#7417 — plan §0c / §0d Phase 4).
 *
 * ── Two doors, one implementation (plan §0c) ────────────────────────────────
 * The portal uploads a zip; `npm run import-theme` POSTs the same zip to the
 * same route. They are not two paths that agree — they are one path with two
 * callers, which is the only version of "identical results" that stays true
 * after somebody changes something.
 *
 * The gate is therefore `requireAdminOrKey`, matching POST /publish exactly:
 * a browser brings its admin session cookie, a script brings `x-admin-key`.
 * The CSRF header is enforced only on the session path, because the key path is
 * not cookie-authenticated and so is not forgeable by a third-party site — the
 * same reasoning routes/admin.ts already wrote down for the publish pipeline.
 *
 * ── What "activating" a theme does, and does not, do ────────────────────────
 * It writes the deployment's own storage and nothing else. It does not rebuild,
 * redeploy, restart, or touch the static assets — those are still the build's,
 * and they are still the fallback. See lib/theme-store.ts.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';
import { requireAdmin } from '../lib/session';
import type { ContentStore } from '../lib/content-store';
import {
  KNOWN_ICONS,
  ThemePackageError,
  activateThemeVersion,
  clearActiveTheme,
  exportThemeVersion,
  importThemePackage,
  listThemeVersions,
  readActiveTheme,
  saveBrandForm,
  themeVersionLimit,
  type ThemeSource,
} from '../lib/theme-store';
import { BRAND_SCHEMA, validate } from 'storylark-contracts/validate';
import { THEME_PACKAGE_LIMITS, THEME_PACKAGE_EXT } from 'storylark-contracts/theme-package';

export const adminThemes = new Hono<AppContext>();

/** Same shape as routes/admin.ts's — spelled here so this router owns its own gate. */
function hasAdminKey(c: Context<AppContext>): boolean {
  return !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;
}

function requireAdminOrKey() {
  return async (c: Context<AppContext>, next: Next) => {
    if (hasAdminKey(c)) return next();
    return requireAdmin()(c, next);
  };
}

adminThemes.use('/themes', requireAdminOrKey());
adminThemes.use('/themes/*', requireAdminOrKey());

function storeOf(c: Context<AppContext>): ContentStore | null {
  return c.env.CONTENT_STORE ?? null;
}

function noStore(c: Context<AppContext>) {
  return c.json(
    {
      error: 'no_content_store',
      message:
        'This deployment has no writable storage bound, so a theme cannot be installed from the portal or the CLI. Bind an R2 bucket (Cloudflare) or set AZURE_STORAGE_CONNECTION_STRING / STORYLARK_LOCAL_CONTENT (Node). See docs/admin-guide.md.',
    },
    501
  );
}

/** Who to record as the importer. A key-authenticated call has no account. */
function actor(c: Context<AppContext>): { by: string; source: ThemeSource } {
  const user = c.get('user');
  if (user) return { by: user.email ?? user.username ?? 'admin', source: 'portal' };
  return { by: 'cli', source: 'cli' };
}

/**
 * GET /api/admin/themes — what is installed, what is available to roll back to,
 * and what a package has to contain.
 *
 * The `expects` block is not decoration: it is what lets the portal and the CLI
 * tell an operator the rules without either of them hard-coding a list that
 * could fall behind the validator.
 */
adminThemes.get('/themes', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const [active, versions] = await Promise.all([readActiveTheme(store), listThemeVersions(store)]);
  return c.json({
    storeAvailable: true,
    /** null = this deployment is wearing the brand its build shipped with. */
    active: active
      ? {
          versionId: active.versionId,
          themeId: active.themeId,
          name: active.name,
          version: active.version,
          importedAt: active.importedAt,
          importedBy: active.importedBy,
          source: active.source,
          hasPresentation: active.presentation !== null,
          icons: active.icons,
          brand: active.brand,
        }
      : null,
    /** The brand the BUILD carries — what "revert to built-in" goes back to. */
    builtIn: { id: c.env.BRAND, appName: c.env.APP_NAME },
    versions,
    versionLimit: themeVersionLimit(c.env),
    expects: {
      extension: THEME_PACKAGE_EXT,
      icons: KNOWN_ICONS,
      maxBytes: THEME_PACKAGE_LIMITS.maxTotalBytes,
    },
  });
});

/**
 * POST /api/admin/themes/import — the one door, used by two callers.
 *
 * multipart/form-data with a `file` part. On success the deployment is wearing
 * the new theme by the time this responds; on failure nothing has been written
 * at all, and the response carries EVERY problem found rather than the first, so
 * an operator fixing a theme gets the whole list in one round trip.
 */
adminThemes.post('/themes/import', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);

  const bytes = await uploadedBytes(c);
  if (bytes instanceof Response) return bytes;

  const { by, source } = actor(c);
  try {
    const result = await importThemePackage({ store, env: c.env, bytes, importedBy: by, source });
    return c.json({
      ok: true,
      version: result.version,
      warnings: result.warnings,
      active: {
        versionId: result.active.versionId,
        themeId: result.active.themeId,
        name: result.active.name,
        version: result.active.version,
        brand: result.active.brand,
        hasPresentation: result.active.presentation !== null,
        icons: result.active.icons,
      },
    });
  } catch (err) {
    return packageError(c, err);
  }
});

/**
 * POST /api/admin/themes/validate — the same validation, applied to nothing.
 *
 * Exists because "will this be accepted?" is a question worth answering without
 * changing a live site, and because the CLI's `--check` mode and the portal's
 * pre-upload feedback must not be a second, laxer implementation of the rules.
 */
adminThemes.post('/themes/validate', async (c) => {
  const bytes = await uploadedBytes(c);
  if (bytes instanceof Response) return bytes;
  const { readThemePackage } = await import('storylark-contracts/theme-package');
  try {
    const pkg = await readThemePackage(bytes);
    return c.json({
      ok: true,
      manifest: pkg.manifest,
      brand: pkg.brand,
      hasPresentation: pkg.presentation !== undefined,
      icons: [...pkg.icons.keys()].sort(),
      warnings: pkg.warnings,
    });
  } catch (err) {
    return packageError(c, err);
  }
});

/** POST /api/admin/themes/versions/:versionId/activate — one-click rollback. */
adminThemes.post('/themes/versions/:versionId/activate', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const versionId = c.req.param('versionId');
  const result = await activateThemeVersion(store, c.env, versionId);
  if (!result) {
    return c.json(
      {
        error: 'no_such_version',
        message: `There is no stored theme version "${versionId}". It may have aged out — this deployment keeps the last ${themeVersionLimit(c.env)}.`,
      },
      404
    );
  }
  return c.json({
    ok: true,
    version: result.version,
    active: { versionId: result.active.versionId, themeId: result.active.themeId, name: result.active.name, brand: result.active.brand },
  });
});

/** GET /api/admin/themes/versions/:versionId/package — download it back out. */
adminThemes.get('/themes/versions/:versionId/package', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const versionId = c.req.param('versionId');
  const built = await exportThemeVersion(store, versionId);
  if (!built) return c.json({ error: 'no_such_version', message: `There is no stored theme version "${versionId}".` }, 404);
  return c.body(built.bytes.buffer as ArrayBuffer, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${built.version.themeId}${THEME_PACKAGE_EXT}"`,
    'Cache-Control': 'no-store',
  });
});

/** DELETE /api/admin/themes/active — stop overriding; wear what the build ships. */
adminThemes.delete('/themes/active', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  await clearActiveTheme(store);
  return c.json({ ok: true, active: null });
});

/**
 * PUT /api/admin/themes/brand — the portal's brand form (plan §0c).
 *
 * The tweak door: change a colour, a tagline, a font, without cloning a repo or
 * making a zip. It writes a normal version, so it shows up in the same history,
 * rolls back the same way, and can be downloaded as a package — which is what
 * keeps "form" and "package" one feature rather than two.
 *
 * Validated against brand.schema.json in STRICT mode, exactly as an imported
 * package's brand.json is. The form is a nicer way to type the same file, not a
 * looser one.
 */
adminThemes.put('/themes/brand', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Expected a JSON brand object.' }, 400);
  }
  const brand = body as Record<string, unknown>;
  if (brand && typeof brand === 'object' && brand.contractVersion === undefined) brand.contractVersion = 1;

  const { errors, warnings } = validate(brand, BRAND_SCHEMA, { strict: true, label: 'brand.json' });
  if (errors.length) {
    return c.json({ error: 'invalid_brand', message: errors[0], errors, warnings }, 400);
  }

  const user = c.get('user');
  const result = await saveBrandForm({ store, env: c.env, brand, savedBy: user?.email ?? user?.username ?? 'cli' });
  return c.json({ ok: true, version: result.version, active: { versionId: result.active.versionId, brand: result.active.brand } });
});

// ── shared ──────────────────────────────────────────────────────────────────

/** The uploaded archive, or the 400/413 to return instead. */
async function uploadedBytes(c: Context<AppContext>): Promise<Uint8Array | Response> {
  const type = c.req.header('content-type') ?? '';

  // A raw zip body is what a shell one-liner sends (`curl --data-binary`), and
  // supporting it costs one branch. multipart is what a browser sends.
  if (!type.includes('multipart/form-data')) {
    if (type.includes('application/zip') || type.includes('application/octet-stream')) {
      const buf = await c.req.arrayBuffer();
      return sized(c, new Uint8Array(buf));
    }
    return c.json({ error: 'bad_request', message: 'Expected a multipart upload with a `file` part, or a zip body.' }, 400);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'bad_request', message: 'That upload could not be read as a multipart form.' }, 400);
  }
  // Duck-typed rather than `instanceof File`, for the same reason
  // admin-content.ts's /upload is: @cloudflare/workers-types declares no global
  // File constructor, and the Node entry's FormData yields its own class.
  const candidate = form.get('file') as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!candidate || typeof candidate === 'string' || typeof candidate.arrayBuffer !== 'function') {
    return c.json({ error: 'bad_request', message: 'No file was attached. Send the .zip as the `file` part.' }, 400);
  }
  return sized(c, new Uint8Array(await candidate.arrayBuffer()));
}

function sized(c: Context<AppContext>, bytes: Uint8Array): Uint8Array | Response {
  if (bytes.byteLength === 0) return c.json({ error: 'bad_request', message: 'That file is empty.' }, 400);
  if (bytes.byteLength > THEME_PACKAGE_LIMITS.maxTotalBytes) {
    return c.json(
      {
        error: 'too_large',
        message: `That package is ${Math.round(bytes.byteLength / 1024)}KB; the limit is ${Math.round(THEME_PACKAGE_LIMITS.maxTotalBytes / 1024)}KB. A theme is text plus a handful of icons — the real ones are 30-80KB.`,
      },
      413
    );
  }
  return bytes;
}

/**
 * A rejection an operator can act on.
 *
 * 422, not 400: the request itself is well-formed — a real multipart upload of a
 * real file — and what failed is the CONTENT of that file against the contract.
 * `errors` carries every problem; `message` is the first, for the callers that
 * only show one line.
 */
function packageError(c: Context<AppContext>, err: unknown): Response {
  if (err instanceof ThemePackageError) {
    return c.json(
      {
        error: 'invalid_package',
        message: err.errors[0],
        errors: err.errors,
        warnings: err.warnings,
        /** Nothing was written. Stated explicitly because it is the guarantee that matters. */
        applied: false,
      },
      422
    );
  }
  throw err;
}
