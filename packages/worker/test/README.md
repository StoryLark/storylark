# Worker tests

`npm test` runs everything matching `packages/worker/test/*.test.mjs` under
`node --test`.

| File | What it holds honest |
|---|---|
| `md-parity.test.mjs` | The Worker's markdown rules agree with the pipeline's, block for block — a portal edit and a CLI publish must produce identical content. |
| `content-origin.test.mjs` | Where content came from decides who owns its edit button, and `sync.mjs` has exactly two connectors. |
| `postgres-numeric-parity.test.mjs` | A D1-shaped `COUNT(*)` and a Postgres-shaped one agree in type. |
| `theme-package.test.mjs` | The theme package format, against the **real** brands in this repo: every one packages clean, build → read → build is a fixed point, and each way a package can be wrong is refused with a message that says what to fix. Also asserts the committed `themes/storylark.storylark-theme.zip` still matches `brands/storylark` byte for byte. |
| `engine-update.test.mjs` | The prebuilt engine artifact and the one-click update. The format and every way it is refused (a brand file in it, a swapped byte, a file `engine.json` never vouched for); the download and checksum over a **real** HTTP server; D1 migrations against a **real** SQLite database writing wrangler's own `d1_migrations` table; and both platform deployers driven against local servers implementing Cloudflare's and Kudu's published contracts, asserting the exact requests. The two vendors' own servers are the one thing not proven — see the file's own header, and `docs/design/update-flow.md`. If `dist-engine/*.zip` exists it also checks the real artifact this repo produces. |

## The two scripts that are not tests

Both need something the test runner cannot provide, so they are run by hand and
deliberately not named `*.test.mjs`.

**`make-broken-packages.mjs`** — writes deliberately-invalid theme packages to
`dist-themes/broken/`, for exercising an import endpoint's rejection path
against a running deployment. It goes through the zip writer directly, because
`buildThemePackage()` validates and is therefore structurally incapable of
producing one. That asymmetry is the feature.

```sh
node packages/worker/test/make-broken-packages.mjs
npm run import-theme -- --url http://127.0.0.1:8787 --key <ADMIN_KEY> \
  dist-themes/broken/missing-icon.storylark-theme.zip     # expect 422, nothing applied
```

**`theme-portal-ui.mjs`** — mounts the real admin *Brand & themes* card into a
DOM, points `fetch` at a **running** deployment with a real admin session, and
clicks the buttons an operator clicks: check, install, roll back, save the brand
form — reading back what the same server serves after each one. It needs a DOM
implementation, which this repo deliberately does not depend on, so it takes the
path to one as an argument:

```sh
npm i linkedom                      # anywhere outside this repo
TSX_TSCONFIG_PATH=packages/core/tsconfig.json \
  node --import tsx/esm packages/worker/test/theme-portal-ui.mjs \
  http://127.0.0.1:8787 "sr_session=<cookie>" /path/to/linkedom/esm/index.js
```

Get the cookie by claiming a setup link:

```sh
curl -sX POST -H "x-admin-key: $ADMIN_KEY" http://127.0.0.1:8787/api/admin/setup/reset
curl -sX POST http://127.0.0.1:8787/api/admin/setup/claim -c jar.txt \
  -H 'content-type: application/json' -H 'x-requested-with: storylark' \
  -d '{"token":"…","email":"you@example.test","password":"…"}'
```
