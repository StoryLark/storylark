# deployment/

Per-install config: where a deployment lives and how it publishes. One folder
per brand id, matching `brands/<id>/` and `presentation/<id>/`.

```
deployment/<id>/deployment.json   appOrigin, contentOrigin, vapidPublicKey, tts
```

These values are **not** part of a brand. Two deployments of the same brand —
the Cloudflare site and the Azure box, say — differ here and nowhere else, which
is why they are not in `brands/<id>/brand.json` and are never included when a
brand is shared or packaged.

Every value can be overridden at build time by an environment variable, which is
how the platform installers configure a deployment they have just provisioned:

| Field | Env override |
|---|---|
| `appOrigin` | `STORYLARK_APP_ORIGIN` |
| `contentOrigin` | `STORYLARK_CONTENT_ORIGIN` |
| `vapidPublicKey` | `STORYLARK_VAPID_PUBLIC_KEY` |
| `tts.voice` / `.rate` / `.outputFormat` / `.voices` | `STORYLARK_TTS_VOICE` / `_RATE` / `_OUTPUT_FORMAT` / `_VOICES` (comma-separated) |

## No secrets here

Everything in this folder is public by definition — it is compiled into the
browser bundle. The VAPID **public** key belongs here; the **private** key,
database URLs, storage connection strings and the admin key are platform
secrets (`platforms/*/install.env`, `.env`, or `wrangler secret`) and must never
be written to these files.

Schema: `packages/core/schemas/deployment.schema.json`.
