# Theme packages

Built theme packages — the installable form of a brand (plan §0c, AB#7417).

A package is a zip of exactly what `brands/<id>/` and `presentation/<id>/`
already contain:

```
<id>.storylark-theme.zip
  package.json        manifest: formatVersion, id, name, version, contractVersion
  brand.json          identity + look
  theme.css           design tokens
  presentation.json   optional — the §0b screen arrangement
  icons/…             favicon.svg, favicon-32/180.png, icon-192/512.png,
                      icon-maskable-512.png, logo.svg
```

## Building one

```sh
npm run package-theme -- storylark          # one brand
npm run package-theme -- --all              # every brand under brands/
npm run package-theme -- wireless --check   # validate, write nothing
```

The tool's real job is **validation**, not zipping: it refuses to emit a package
the import endpoint would refuse to accept, using literally the same code
(`storylark-contracts/theme-package`). Missing design tokens, an icon at the
wrong pixel size, a dark-first theme with a dark alternate block, an unknown
`contractVersion` — all caught before the file exists.

Output is reproducible: no clock is read unless you pass `--dated`, so
re-running on an unchanged brand produces an unchanged file.

## Installing one

Either door — both hit the same endpoint, both validate identically:

```sh
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> themes/storylark.storylark-theme.zip
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --list
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --rollback previous
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --revert
```

…or the **Brand & themes** card in `/admin`: upload, check-first, roll back,
download any stored version, and edit the brand's own details without a package
at all.

Installing takes effect on the next request. No rebuild, no redeploy, no
restart — brand, stylesheet, icons, manifest and (if the package carries one)
the screen arrangement.

## What is committed here

Only **`storylark.storylark-theme.zip`** — the default brand this engine ships
with, as a real, downloadable, importable artifact rather than a description of
one. Everything else `--all` produces is a build output of a brand folder that
is already in this repo, and is git-ignored.
