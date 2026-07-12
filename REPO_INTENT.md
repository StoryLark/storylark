# Repository intent: storyreader-gunner (private base copy)

## What this repository is

This is a private copy of the StoryReader progressive web app, kept mostly as-is to
serve as a base for new plans. StoryReader is a Vite + Preact app served by a Cloudflare
Worker (an API on D1 and R2), with a content pipeline that turns Markdown into JSON plus
narrated audio.

The intent of this copy is to be a working starting point that the owner can build a new
product on. The product direction is still to be decided, including a new name (see
`todo.md`).

## Provenance

- Copied from the private original that lives in a different GitHub org.
- Full git history was intentionally preserved, because this copy is private and the
  history is useful while building on it.

## Status: PRIVATE, as-is

- This is a normal copy. No scrub or genericization has been done, and none is needed
  yet.
- Open-sourcing this app is a FUTURE decision that has not been made. Keep this
  repository private until that decision is made.

## Immediate tasks

See `todo.md` in the repository root:

1. Screen Awake setting (a read-along feature). Captured, not yet built.
2. Choose a new name for the product.

## If this is open-sourced later (do NOT do this now)

When and if the owner decides to open-source this, treat the following as a checklist.
It is recorded here for later and is not work for today.

- [ ] Decide the scope: publish the whole app or extract a reusable template.
- [ ] Remove or rotate any secrets, and remove environment-specific configuration
      (Cloudflare account and resource identifiers, database identifiers, custom domains,
      and mail-from addresses).
- [ ] Genericize or remove brand-specific assets and content (brand configs, icons,
      covers, themes).
- [ ] Choose and apply a LICENSE.
- [ ] Apply the new product name and branding.
- [ ] Owner reviews before any public release.
