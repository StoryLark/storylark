# Build Your Own Theme

A **theme** in StoryLark is the *branding* layer: colors, fonts, and icons. It
does **not** change the app's structure or UX — that's the presentation layer
(see [`build-your-own-presentation.md`](build-your-own-presentation.md)). Before
building from scratch, browse the ready-made themes in the
[theme & template gallery](https://gallery.storylark.dev/themes.html) — each is a
downloadable brand folder you can drop in and retune. A theme
lives entirely in one brand folder:

```
brands/<your-id>/
  brand.json     identity + look: names, tagline, author, colors, fonts
  theme.css      the CSS custom-property (token) contract — light + dark
  assets/icons/  PWA icons (and favicons/logo)
  assets/covers/ (optional) per-book cover art shipped with the brand
```

> **`brand.json` got smaller (2026-08).** It used to hold your identity, your
> library's shape, *and* your server addresses in one file. Those are now three
> files, so that updating the StoryLark engine can never touch your brand and
> your brand can move between deployments without dragging one deployment's
> URLs along with it. Running an older single-file brand still works — the build
> warns and tells you to run `npx storylark-migrate-brand`, which splits it for you and
> keeps a backup.

| File | Holds | Travels with your brand? |
|---|---|---|
| `brands/<id>/brand.json` | Identity + look — names, tagline, author, manifest colors, default theme, fonts | **Yes** |
| `presentation/<id>/presentation.json` | Shape — `layout`, `nouns` ([presentation guide](build-your-own-presentation.md)) | **Yes** |
| `deployment/<id>/deployment.json` | Where it lives — `appOrigin`, `contentOrigin`, `vapidPublicKey`, `tts` | **No** — set per install |

The build mode selects the folder: `vite build --mode <your-id>` builds that
brand's site into `app/dist`.

> **Your brand is no longer baked into the JavaScript (2026-08).** `brand.json`
> and `theme.css` are copied into `app/dist` as **real files**, and the platform
> serving your site reads them on every request. Replace either one on a
> deployed site and the next page load has the new brand — no rebuild, no
> redeploy of the app bundle. See
> [Changing your brand without rebuilding](#changing-your-brand-without-rebuilding).

### `contractVersion`

Each of the three files starts with `"contractVersion": 1` — an integer that
says which version of the file format you wrote against. Two promises come with
it, and they are the reason a core update can't break your theme:

- **A field you leave out gets StoryLark's default, forever.** A brand file
  written today keeps working in every future version.
- **A field StoryLark doesn't recognise is ignored with a warning**, so a file
  written for a newer version still loads on an older one.

The number only changes if the format is ever reshaped in a way that genuinely
breaks old files — which is the one case the build refuses to guess about.
Adding new fields doesn't change it.

## `theme.css` — the token contract

`theme.css` defines CSS custom properties on `:root` (light, the default) and
mirrors **every** token under `:root[data-theme="dark"]`. The app switches themes
by stamping `data-theme` on the root element (Settings → theme: light / dark /
auto). Retune these values; keep the names.

| Token | Role |
|---|---|
| `color-scheme` | `light` or `dark` — makes native controls (selects, checkboxes, range sliders, scrollbars) match the theme instead of flashing the OS default. Set per block. |
| `--bg` | Page background ("paper"). Should match `themeColor`/`backgroundColor` in `brand.json`. |
| `--bg-raised` | Raised surfaces — cards, sheets, the surface above the page. |
| `--bg-sunken` | Recessed surfaces — wells, inset areas. |
| `--text` | Primary body text ("ink"). |
| `--text-muted` | Secondary text — labels, metadata. |
| `--text-faint` | Tertiary text — faint captions, disabled hints. |
| `--accent` | Primary interactive color — buttons, active states, links. |
| `--accent-strong` | A stronger/darker accent for hovers/pressed states and emphasis. |
| `--rule` | Hairline dividers and card borders (list/card chrome). |
| `--link` | Link color (often equal to `--accent`). |
| `--font-display` | Display / hero type (e.g. big titles). |
| `--font-headers` | Headings. |
| `--font-body` | Body / reading type. |
| `--font-mono` | Monospace. |
| `--highlight-word` | Read-along **word** highlight fill (the "sung" word). Deliberately a warm, distinct color so it reads against the interactive accent. |
| `--highlight-block` | Read-along **block/paragraph** highlight fill (paragraph-level read-along and the active-block wash). |

The four `--font-*` tokens are the ones your `brand.json` can take over: name a
[curated family](#fonts--pick-from-the-curated-set) for a role and that role's
token is set from the brand when the stylesheet is served, overriding the value
below. Leave a role out of `brand.json` and your theme's value stands.

Minimum shape:

```css
:root {
  color-scheme: light;
  --bg: #FBF8F2;
  --bg-raised: #FFFFFF;
  --bg-sunken: #F1EADD;
  --text: #232020;
  --text-muted: #635C54;
  --text-faint: #A69D8F;
  --accent: #0E7C7B;
  --accent-strong: #0A5F5E;
  --rule: #E6DFD2;
  --link: #0E7C7B;
  --font-display: "Newsreader", Georgia, serif;
  --font-headers: "Newsreader", Georgia, serif;
  --font-body:    "Newsreader", Georgia, serif;
  --font-mono:    "Inter", system-ui, sans-serif;
  --highlight-word:  rgba(224, 164, 35, 0.22);
  --highlight-block: rgba(224, 164, 35, 0.5);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  /* mirror EVERY token above with dark values */
}
```

## Fonts — pick from the curated set

StoryLark ships a **curated font set** with the engine. Every build carries all
of it, so switching your brand from one family to another is a `brand.json`
edit, not a rebuild.

| Family | Kind |
|---|---|
| Newsreader | serif (reading) |
| Lora | serif (reading) |
| Cormorant Garamond | serif (reading) |
| Cinzel | display |
| Inter | sans |
| IBM Plex Mono | monospace |

Name them in `brand.json`:

```json
"fonts": { "display": "Cinzel", "headers": "Cinzel", "body": "Lora", "mono": "IBM Plex Mono" }
```

Each role sets the matching CSS custom property — `fonts.body` becomes
`--font-body`, and so on — appended to your `theme.css` when it is served, so it
overrides whatever `--font-*` values your theme declares. Matching is
case- and space-insensitive (`ibm plex mono` works).

**A family that isn't in the set is ignored, with a warning in the platform
log,** and your theme's own `--font-*` value stands. Nothing else would work:
the font files ship with the engine, so a name outside the set has no faces to
render with.

To use a typeface outside the set today, self-host it: add your own `@font-face`
rules to `theme.css` and set the `--font-*` tokens there, and leave that role out
of `brand.json` so nothing overrides it. Keep it self-hosted, so the offline app
shell works without a network. **Uploading a custom font as part of a brand is a
later phase** — the curated set is deliberately what exists first.

A browser downloads a font file only when something actually renders in that
family, so the five families your brand isn't using cost you nothing over the
wire. They are also **not** in the offline precache for the same reason — a font
enters the cache the first time it is used, and stays.

## `brand.json` — fields

Identity and look. Nothing here names a server, so this file is safe to share,
publish, or copy to another deployment.

| Field | Type | Purpose |
|---|---|---|
| `contractVersion` | integer | Always `1` today. See above. |
| `id` | string | Brand id. Must equal the folder name and the build `--mode`. |
| `name` | string | Library name (shown as the manifest/app subtitle, e.g. "StoryLark: Story Library"). |
| `appName` | string | App name — document `<title>` and manifest name. |
| `shortName` | string | PWA `short_name` (home-screen label); falls back to `appName`. |
| `tagline` | string | Manifest description / marketing line. |
| `author` | string | Author/publisher label. |
| `themeColor` | string (hex) | Manifest `theme_color` — match `--bg`. |
| `backgroundColor` | string (hex) | Manifest `background_color` (splash) — match `--bg`. |
| `defaultTheme` | `"light"` \| `"dark"` | Initial theme before the user overrides it in Settings. |
| `fonts` | object | `{ display, headers, body, mono }` family names referenced by `theme.css`. |

`layout` and `nouns` moved to `presentation/<id>/presentation.json` — they
describe the shape of your library, not its identity. See
[`build-your-own-presentation.md`](build-your-own-presentation.md).

## `deployment/<id>/deployment.json` — where this copy lives

The values that differ between two deployments of the *same* brand, and only
those. Set at install time; never included when you share or package a brand.
Every one can also be supplied as an environment variable at build time, which
is how the platform installers configure a deployment they just provisioned.

| Field | Type | Purpose | Build-time env override |
|---|---|---|---|
| `contractVersion` | integer | Always `1` today. | — |
| `appOrigin` | string (URL) | Where the app is served. Also the base for admin publish notify, and (with the `app.` label dropped) the marketing origin used to resolve root-relative image `src`s. | `STORYLARK_APP_ORIGIN` |
| `contentOrigin` | string (URL) | Where published content is served (`contentUrl()` builds asset URLs from this). **Optional:** empty means same-origin — the app serves its own content at `/manifest.json` and `/books/*`, no separate content domain needed. | `STORYLARK_CONTENT_ORIGIN` |
| `vapidPublicKey` | string | Web-push VAPID **public** key (base64url). Empty disables the push toggle. Generate with `npx storylark-gen-vapid`. | `STORYLARK_VAPID_PUBLIC_KEY` |
| `tts` | object | `{ voice, rate, outputFormat, voices }` used at publish time. `voice` is a Kokoro or Azure Speech voice id; `outputFormat` an Azure output-format enum. | `STORYLARK_TTS_VOICE`, `STORYLARK_TTS_RATE`, `STORYLARK_TTS_OUTPUT_FORMAT`, `STORYLARK_TTS_VOICES` (comma-separated) |

**Keep your VAPID public key.** Every device that has already accepted push
notifications is bound to that exact key. A deployment that loses or changes it
can no longer notify any of them until each reader re-subscribes. The matching
**private** key is a platform secret (`VAPID_PRIVATE_KEY`) and never appears in
any of these files.

## Changing your brand without rebuilding

A build writes these into `app/dist`:

| File | What it is | Change it without rebuilding? |
|---|---|---|
| `dist/brand.json` | your identity, copied from `brands/<id>/brand.json` | **Yes** |
| `dist/theme.css` | your theme, copied from `brands/<id>/theme.css` | **Yes** |
| `dist/manifest.webmanifest` | generated per request from `dist/brand.json` | n/a — follows `brand.json` |
| `dist/icons/*` | your icon files, copied from `brands/<id>/assets/icons/` | **Yes** — replace the files, or install a package |
| `dist/fonts.json` | the curated font set this build shipped | No — engine data |

> **You usually want a package instead.** Everything in this section is the
> file-swapping mechanism underneath; installing a
> [theme package](#theme-packages--building-installing-rolling-back) does all of
> it for you, in one request, with validation, version history and one-click
> rollback — and it works on Cloudflare, where there is no filesystem to swap
> files on. Read on if you want to know what is actually happening.

Replace `dist/brand.json` or `dist/theme.css` on a deployed site and the next
request serves the new brand. The document's `<title>`, the brand data the app
reads, the PWA manifest and the stylesheet all come from those files at response
time, not from the JavaScript bundle. Nothing needs recompiling, and no hashed
asset changes.

The mechanics differ slightly per platform, because "the files on the deployed
site" mean different things:

- **Azure / any Node host** — the files are on disk. Overwrite them; the running
  process re-reads `brand.json` on every request. No restart.
- **Cloudflare** — Workers have no filesystem, so the files live in the deployed
  asset bundle. Upload the changed assets (`wrangler deploy` with the same
  `dist/`); the Worker reads them through its asset binding on every request.
  You are re-uploading files, not rebuilding the engine.

Keep `brands/<id>/` in sync with whatever you put in `dist/`, or the next real
build will put the old brand back.

### Things to know before you change a live brand

- **An installed PWA can keep the old name and icon until it is reinstalled.**
  Once someone installs the app, the *operating system* owns the copy of the
  manifest it installed with — the app's name on the home screen, and its icon.
  StoryLark serves a current manifest immediately, and browsers do re-read it,
  but when (and whether) an already-installed app is updated is entirely the
  platform's decision and outside this system's control. Assume existing
  installs keep the old label until they are removed and re-added. Everything
  *inside* the app — title, text, colours, fonts — updates normally.
- **The offline copy does not go stale.** `theme.css` is fetched from the
  network first and only falls back to the cached copy offline, and the service
  worker re-stamps the brand into the cached app shell every time it serves it.
  A swapped brand shows up on the next launch of an installed app, not
  eventually.
- **Icon *files* are files.** The manifest updates itself from `brand.json`, but
  the pictures at `/icons/icon-192.png` and friends change only when you replace
  those files. Keep the names.
- **There is a small cost.** Each page load carries a little extra HTML (the
  injected brand, a few hundred bytes) and fetches `theme.css` as its own
  request rather than getting it inside a bundled stylesheet. That request is
  render-blocking by design: it is what stops a flash of the wrong brand.
- **A broken file never takes the site down.** Unparseable `brand.json`, a
  `themeColor` that isn't a colour, a `defaultTheme` that isn't `light`/`dark` —
  each bad *value* is logged and ignored, and the brand compiled in at build
  time fills the gap. Check the platform log after a change.

## Swapping icons

On a **live** deployment, icons travel in a theme package — see
[Theme packages](#theme-packages--building-installing-rolling-back). In the repo:

Replace the three PNGs in `brands/<your-id>/assets/icons/` (`icon-192.png`,
`icon-512.png`, `icon-maskable-512.png` — the manifest references exactly these).
The `storylark-core` build preset copies the whole `assets/icons/` folder to
`dist/icons/` at build time, so any additional files (favicons, logo) are
shipped too. To generate
neutral placeholders in your accent color:

```
npx storylark-gen-icons --brand <your-id>
```

## Sample themes to start from

Four complete themes ship in this repo alongside `storylark` itself. They exist
to be copied and to be read: between them they use every curated family, both
values of `defaultTheme`, both `layout`s, both `nav.position`s, both
`cover.aspect`s and every `reader.defaultMode`, so whatever you are trying to
build, one of them has already made a similar decision and you can see what it
took.

| Theme | Subject | Look | Fonts (display / body) | Build |
|---|---|---|---|---|
| `weatherglass` | Weather and almanac | Light. Pulp-grey stock, admiralty chart blue, storm-rust highlight | IBM Plex Mono / Lora | `vite build --mode weatherglass` |
| `nebula` | Science fiction | Dark-first. Plate-emulsion violet-grey, reflection blue, H-alpha rose highlight | Inter / Newsreader | `vite build --mode nebula` |
| `loveletter` | Romance | Light. Rose-grey laid paper, sealing-wax carmine, faded-ink-violet highlight | Cormorant Garamond / Lora | `vite build --mode loveletter` |
| `wireless` | Vintage radio drama | Dark-first. Bakelite brown, dial-lamp amber, ON AIR red highlight | Cinzel / Newsreader | `vite build --mode wireless` |

Each is a full set — `brands/<id>/brand.json`, `brands/<id>/theme.css`,
`brands/<id>/assets/icons/`, `presentation/<id>/presentation.json` — plus a
short sample library under `examples/<id>/` so you can see the theme with
content in it rather than on an empty shelf:

```
npx storylark-publish --brand wireless \
  --source examples/wireless --no-audio --local app/dist
```

Two of them (`nebula`, `wireless`) are dark-first, which is worth reading for
one specific reason: they put the DARK tokens on bare `:root` and the light
ones under `:root[data-theme="light"]`, the opposite way round from
`brands/storylark`. `data-theme` is only stamped once the app's JavaScript
runs, so on a dark-first brand the unstamped state has to already be dark or
every cold load flashes white first.

## Theme packages — building, installing, rolling back

A theme is also a **file**. `npm run package-theme` turns a brand folder into
one zip that installs on any StoryLark deployment, from the portal or from a
terminal, with no rebuild and no repo access:

```
<id>.storylark-theme.zip
  package.json        formatVersion, id, name, version, contractVersion
  brand.json          identity + look
  theme.css           design tokens
  presentation.json   optional — the screen arrangement
  icons/…             favicon.svg, favicon-32/180.png, icon-192/512.png,
                      icon-maskable-512.png, logo.svg
```

That is exactly the folder above, with `assets/icons/` flattened to `icons/`
(where the files land in a built site).

### Build one

```sh
npm run package-theme -- <your-id>          # → themes/<your-id>.storylark-theme.zip
npm run package-theme -- --all              # every brand under brands/
npm run package-theme -- <your-id> --check  # validate, write nothing
npm run package-theme -- <your-id> --version 1.2.0
```

**The tool's real job is checking, not zipping.** It refuses to emit a package
the deployment would refuse to install, using the same code the deployment uses,
so "it packaged fine but the upload failed" cannot happen. What it catches that
a build would not:

- an unknown or missing `contractVersion`
- anything `brand.json` states that the schema does not allow — in *strict*
  mode, so a typo'd key is an error here even though a running site only warns
- a **missing icon**, or an icon at the **wrong pixel size** (the failure you
  otherwise discover weeks later, on somebody else's phone)
- a `theme.css` missing tokens the app reads — which renders as invisible text
  rather than as an error
- a `theme.css` with **no alternate colour scheme**, or one for the wrong scheme:
  a dark-first brand needs `:root[data-theme="light"]`, and getting it backwards
  makes the theme toggle silently do nothing

### Install one

Two doors, one endpoint, identical results:

```sh
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> themes/<id>.storylark-theme.zip
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --check <zip>   # validate only
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --list
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --rollback previous
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --revert
```

…or the **Brand & themes** card in `/admin`: upload a package, check it first,
see **Theme version history**, roll back with one click, download any stored version,
and edit your brand's own details (names, tagline, colours, fonts) with no
package at all.

The name and version shown there identify the theme package or brand edit. They
are deliberately separate from the StoryLark engine version shown under
Platform update / System. For example, `Theme: Holdfast Reader v1.0.0+1` is a
theme revision, not the site's StoryLark release.

`--key` is the deployment's `ADMIN_KEY` — the same credential the publish
pipeline uses. `--url`/`--key` fall back to `STORYLARK_URL` /
`STORYLARK_ADMIN_KEY`.

An installed theme takes effect **on the next request**: brand, stylesheet,
icons, PWA manifest, and the screen arrangement if the package carries one. It
lives in the deployment's own storage (the R2 bucket or blob container it
already has), *not* in the build — so `brands/<id>/` and `dist/` are untouched,
and "revert" puts the built-in brand back instantly.

### Versions and rollback

Every install is a version. The last **five** are kept (`THEME_VERSIONS`
overrides it), the live one is never aged out, and rolling back restores exactly
the bytes that were installed. Editing your brand in the portal form writes a
version too — so a colour you changed on a staging site can be **downloaded as a
package** and installed on production, rather than retyped.

### What a package deliberately does not carry

Your deployment config. No `appOrigin`, no `contentOrigin`, no VAPID key, no
narration settings — those are set per install and would follow a theme into the
wrong site. See [`deployment/README.md`](../deployment/README.md).

## Migrating an older brand

If your `brands/<id>/brand.json` is one big file with `appOrigin`, `layout` and
`tts` in it, it predates the split. It still builds — the build just warns — but
to convert it:

```
npx storylark-migrate-brand              # every brand under brands/
npx storylark-migrate-brand --dry-run    # show what would change, write nothing
```

It rewrites `brand.json` with just the identity fields, creates
`presentation/<id>/presentation.json` and `deployment/<id>/deployment.json`,
backs the original up as `brand.json.pre-split.bak`, and prints the deployment
values so you can set them on each install. Running it twice is safe — an
already-split brand is left alone.

Built something worth sharing? The gallery indexes community themes — see the
[submission guide](https://github.com/StoryLark/gallery/blob/main/CONTRIBUTING.md)
to get yours listed.
