# Deploy & bootstrap

## One-time per-brand bootstrap

Everything below uses wrangler with `CLOUDFLARE_API_TOKEN` set (account `5d8be56e19f1f800b8e482a449472dd9`).

```powershell
# 1. Database
wrangler d1 create storyreader-<brand>            # paste database_id into wrangler.jsonc env.<brand>
wrangler d1 migrations apply storyreader-<brand> --env <brand> --remote

# 2. Content bucket
wrangler r2 bucket create storyreader-<brand>-content
# Dashboard (R2 → bucket → Settings): attach custom domain content.<brand-domain>
# CORS rule: AllowedOrigins [https://app.<brand-domain>], AllowedMethods [GET, HEAD], AllowedHeaders [Range]

# 3. Keys & secrets
node tools/gen-vapid.mjs                          # public → brands/<brand>/brand.json vapidPublicKey
wrangler secret put VAPID_PUBLIC_KEY  --env <brand>
wrangler secret put VAPID_PRIVATE_KEY --env <brand>
wrangler secret put RESEND_API_KEY    --env <brand>
wrangler secret put GOOGLE_CLIENT_ID  --env <brand>
wrangler secret put GOOGLE_CLIENT_SECRET --env <brand>
wrangler secret put ADMIN_KEY         --env <brand>   # any long random string; also used by tools/publish.mjs

# 4. Deploy (creates DNS + cert for app.<brand-domain> automatically)
npm run deploy:<brand>
```

## External accounts

| Service | What | Notes |
|---|---|---|
| Resend | API key + verified sending domain | holdfastpress.com already verified; verify gunnerthelab.com before Gunner launch |
| Google Cloud Console | OAuth client per brand | Authorized redirect: `https://app.<domain>/api/auth/google/callback`; scopes openid email profile |
| Azure (thisismydemo) | Speech F0 resource | `az cognitiveservices account create -n storyreader-tts -g rg-storyreader --kind SpeechServices --sku F0 -l eastus --yes` |

## CI

`.github/workflows/deploy.yml` deploys on push to main (matrix per brand). Repo secrets needed: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. D1 migrations run only via manual dispatch with `migrate: true` — schema changes stay deliberate.

## Publishing content

```powershell
$env:AZURE_SPEECH_KEY = '<key>'; $env:AZURE_SPEECH_REGION = 'eastus'; $env:ADMIN_KEY = '<admin key>'
node tools/publish.mjs --brand holdfast --dry-run     # see what would change
node tools/publish.mjs --brand holdfast               # full publish incl. TTS
node tools/publish.mjs --brand gunner --no-audio      # text-only (F0 char budget)
```

The pipeline is idempotent (per-chapter content hash in `tools/.state/<brand>.json`) and enforces a 450K/month TTS character ledger against the F0 500K free limit.

## The one rule

**holdfastpress.com/app is the marketing page and is never touched by this repo.** The app lives at app.holdfastpress.com only.
