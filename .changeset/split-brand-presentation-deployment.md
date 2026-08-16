---
'storylark-core': minor
'storylark-pipeline': patch
---

Brand, presentation and deployment config are three files, not one (AB#7413).

`brands/<id>/brand.json` used to hold your identity, your library's shape, and
your server addresses in one place. That made a brand unportable and a
deployment unconfigurable — it is the direct cause of the Azure deployment that
served Cloudflare's content origin, because `contentOrigin` was baked into the
brand both platforms share. The three concerns now have three files, three JSON
Schemas, and a `contractVersion` each:

```
brands/<id>/brand.json                identity + look  — portable
presentation/<id>/presentation.json   layout, nouns    — portable
deployment/<id>/deployment.json       origins, VAPID public key, tts — per install
```

- **`npm run migrate-brand`** (also `npx storylark-migrate-brand`) splits an
  existing brand, backs the original up as `brand.json.pre-split.bak`, and
  prints the deployment values — including a loud warning about the VAPID
  public key, which every already-subscribed device is bound to. It is
  idempotent; re-running it is a no-op.
- **A pre-split `brand.json` still builds**, unchanged, with a warning telling
  you to migrate. A core update never breaks a brand that worked yesterday.
- **Schemas ship with the engine** (`storylark-core/schemas`) and are enforced
  by the build. A missing key takes the core default; an unknown key is ignored
  with a warning; only an unsupported `contractVersion` fails the build.
- **Deployment config gained the env overrides the origins already had** —
  `STORYLARK_VAPID_PUBLIC_KEY` and `STORYLARK_TTS_VOICE` / `_RATE` /
  `_OUTPUT_FORMAT` / `_VOICES` join `STORYLARK_APP_ORIGIN` and
  `STORYLARK_CONTENT_ORIGIN`. The Cloudflare installer now passes its
  `install.env` origins to the build, as the Azure one already did.

No behaviour change: the built bundle for an unchanged brand is byte-identical
apart from the build timestamp. Brand and presentation are still baked at build
time — serving them at runtime is a later phase.
