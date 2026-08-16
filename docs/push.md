# Web Push

## The trick that keeps it simple: payload-less pushes

Standard web push encrypts a payload per subscriber (RFC 8291) — real crypto code in
the Worker. We skip it entirely: the push is an **empty wake-up call**. The service
worker wakes, fetches the fresh `manifest.json` itself, and composes the notification
("Chapter Two: <title> — The Keepers") from what it finds. Same UX, a fraction of the
moving parts, and the notification text is always as fresh as the manifest.

## Flow

```
publish pipeline ── POST /api/admin/publish {version} + X-Admin-Key ──► worker
  worker: update library_state → for each subscription (batches of 50, waitUntil):
    sign VAPID JWT (ES256, aud = push-service origin, exp +12h)
    POST <endpoint> with empty body, TTL 86400
phone push service → SW 'push' event → fetch manifest → showNotification
tap → focus or open the app at /
```

## Hygiene

- `404`/`410` from the push service → subscription row deleted immediately.
- Other failures increment `failed_count`; 5 strikes → deleted.
- Re-subscribing upserts by endpoint and resets the counter.

## Keys

Per-brand VAPID P-256 keypair (`packages/pipeline/gen-vapid.mjs`): private key = deployment
secret; public key = the deployment's `VAPID_PUBLIC_KEY` (Worker var / App Service setting),
injected into the app at request time (AB#7414), with `deployment/<id>/deployment.json` — or
`STORYLARK_VAPID_PUBLIC_KEY` at build — as the fallback for a context nothing injects into.
Rotating keys = new keypair + set both halves on the deployment + users re-toggle notifications
(old subscriptions die off via the strike rule). No site rebuild needed for the public half.

## Platform notes

- **iOS**: push requires the PWA installed to the Home Screen (16.4+). The Settings
  screen detects this and shows install guidance instead of the toggle.
- **Android/desktop Chrome**: works in-browser and installed.
- Permission is only requested on an explicit toggle tap — never on page load.
