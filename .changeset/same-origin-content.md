---
"storylark-worker": minor
"storylark-core": minor
"create-storylark": minor
"storylark-contracts": patch
---

CONTENT_ORIGIN is now optional: content serves same-origin by default (AB#7395).

A brand-new Cloudflare deployment no longer needs an R2 custom domain — or any
DNS work — before content loads. With `contentOrigin` unset (`""`, the scaffold
default), `contentUrl()` builds root-relative URLs and the Worker answers
`GET /manifest.json` and `GET /books/*` straight out of the CONTENT R2 bucket,
with native Range/conditional support and the same cache-control the publish
pipeline wrote each object with (manifest `max-age=60`, hashed objects
immutable). Only those two public prefixes are exposed — theme state in the
bucket is not.

- Worker: same-origin content routes in `index.ts`; `CONTENT_ORIGIN`/`CONTENT`
  are optional in `Env`; `/api/admin/status` counts books from the bound store
  instead of fetching the content origin; narration claims fall back to
  `APP_ORIGIN` for `contentUrl`; portal upload/list URLs are root-relative when
  same-origin.
- Core: the service worker recognises same-origin content requests
  (`/manifest.json`, `/books/*`) so offline downloads and content caching work
  with `contentOrigin: ""`; the admin cover thumbnail renders with a
  root-relative URL.
- create-storylark: `CONTENT_ORIGIN` removed from the Cloudflare installer's
  required values (blank = same-origin); the wizard prompt says leaving it
  blank needs no DNS setup; the scaffold's `wrangler.jsonc` defaults it to
  `""`.
- contracts: `deployment.schema.json` documents `contentOrigin: ""` as
  same-origin.

Deployments with a real `CONTENT_ORIGIN` (e.g. an R2 custom domain) are
unchanged — a separate content domain remains supported and still lets content
bypass the Worker entirely.
