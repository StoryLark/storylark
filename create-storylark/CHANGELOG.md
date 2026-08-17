# create-storylark

## 0.1.2

### Patch Changes

- [`d234b67`](https://github.com/StoryLark/storylark/commit/d234b67bc585af610dff76c5ca4e128b5f466def) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Fix Azure's installer silently defaulting `APP_NAME` to the lowercase
  brand-folder id (e.g. `"storylark"`) instead of a real display name.
  `infra.bicep`'s `appName` parameter used to default to the `brand` folder
  parameter, while the Cloudflare installer already required `APP_NAME` as an
  explicit, human-entered value with no default. A fresh Azure deploy's
  `APP_NAME` — the WebAuthn passkey prompt name and the transactional/
  update-check email `From:` display name — ended up as a resource-naming
  slug, diverging from what a Cloudflare install of the same brand shows.

  `APP_NAME` is now a required field in `platforms/wizard.mjs`'s Azure prompt
  and `platforms/azure/install.mjs`'s `REQUIRED` list (matching Cloudflare's
  own installer exactly), always passed explicitly to `infra.bicep`, which no
  longer has a default for `appName` at all. Does not touch the admin
  portal's own title, which already reads `brand.json`'s `appName` at runtime
  via `BRAND.appName` (fixed earlier this session) rather than echoing
  `APP_NAME`.
