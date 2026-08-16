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
> warns and tells you to run `npm run migrate-brand`, which splits it for you and
> keeps a backup.

| File | Holds | Travels with your brand? |
|---|---|---|
| `brands/<id>/brand.json` | Identity + look — names, tagline, author, manifest colors, default theme, fonts | **Yes** |
| `presentation/<id>/presentation.json` | Shape — `layout`, `nouns` ([presentation guide](build-your-own-presentation.md)) | **Yes** |
| `deployment/<id>/deployment.json` | Where it lives — `appOrigin`, `contentOrigin`, `vapidPublicKey`, `tts` | **No** — set per install |

The build mode selects the folder: `vite build --mode <your-id>` bakes that
brand's `brand.json`, its presentation and deployment files, `theme.css`,
manifest, and icons into `app/dist`.

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

## Fonts

`brand.json` names the font families in `fonts` (`display`, `headers`, `body`,
`mono`), and `theme.css` references those families in the `--font-*` tokens.
The **font files** are bundled automatically: at build time the
`storylark-core` Vite preset turns each family name into the matching
`@fontsource/*` imports (e.g. `Newsreader` → `@fontsource/newsreader`), with
sensible weights per role (body text gets italics; mono doesn't). Families
bundled with core today: Newsreader, Inter, Lora, Cinzel, Cormorant Garamond,
IBM Plex Mono.

To ship a typeface outside that set, add your own self-hosted `@font-face` CSS
to `theme.css` and reference the family in the `--font-*` tokens — unknown
family names simply produce no `@fontsource` import. Keep fonts self-hosted so
the offline app shell works without a network.

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
| `contentOrigin` | string (URL) | Where published content is served (`contentUrl()` builds asset URLs from this). | `STORYLARK_CONTENT_ORIGIN` |
| `vapidPublicKey` | string | Web-push VAPID **public** key (base64url). Empty disables the push toggle. Generate with `packages/pipeline/gen-vapid.mjs`. | `STORYLARK_VAPID_PUBLIC_KEY` |
| `tts` | object | `{ voice, rate, outputFormat, voices }` used at publish time. `voice` is a Kokoro or Azure Speech voice id; `outputFormat` an Azure output-format enum. | `STORYLARK_TTS_VOICE`, `STORYLARK_TTS_RATE`, `STORYLARK_TTS_OUTPUT_FORMAT`, `STORYLARK_TTS_VOICES` (comma-separated) |

**Keep your VAPID public key.** Every device that has already accepted push
notifications is bound to that exact key. A deployment that loses or changes it
can no longer notify any of them until each reader re-subscribes. The matching
**private** key is a platform secret (`VAPID_PRIVATE_KEY`) and never appears in
any of these files.

## Swapping icons

Replace the three PNGs in `brands/<your-id>/assets/icons/` (`icon-192.png`,
`icon-512.png`, `icon-maskable-512.png` — the manifest references exactly these).
The `storylark-core` build preset copies the whole `assets/icons/` folder to
`dist/icons/` at build time, so any additional files (favicons, logo) are
shipped too. To generate
neutral placeholders in your accent color:

```
node packages/pipeline/gen-icons.mjs --brand <your-id>
```

## Publishing themes (naming convention — planned)

Today a theme is a folder you copy and edit in-repo. The direction is to make
themes **installable packages** so a brand can consume one without vendoring it:

- Official themes: `storylark-theme-*` (e.g. `storylark-theme-daybreak`).
- Community themes: `storylark-theme-*`.

This packaging/distribution model is **planned**, not available today — for now,
copy `brands/storylark/` and retune it, or start from a theme in the
[gallery](https://gallery.storylark.dev/themes.html). The split above is the
groundwork for it: a package is `brand.json` + `theme.css` + `assets/icons/`
(+ optionally `presentation.json`), and never your deployment config.

## Migrating an older brand

If your `brands/<id>/brand.json` is one big file with `appOrigin`, `layout` and
`tts` in it, it predates the split. It still builds — the build just warns — but
to convert it:

```
npm run migrate-brand              # every brand under brands/
npm run migrate-brand -- --dry-run # show what would change, write nothing
```

It rewrites `brand.json` with just the identity fields, creates
`presentation/<id>/presentation.json` and `deployment/<id>/deployment.json`,
backs the original up as `brand.json.pre-split.bak`, and prints the deployment
values so you can set them on each install. Running it twice is safe — an
already-split brand is left alone.

Built something worth sharing? The gallery indexes community themes — see the
[submission guide](https://github.com/StoryLark/gallery/blob/main/CONTRIBUTING.md)
to get yours listed.
