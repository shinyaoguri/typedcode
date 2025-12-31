# @typedcode/workers

Cloudflare Workers API for TypedCode - Turnstile human verification integration.

## Setup

### 1. Get Turnstile keys

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
2. Create a new Turnstile widget
3. Note your **Site Key** (for editor) and **Secret Key** (for workers)

### 2. Configure local development

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
```
TURNSTILE_SECRET_KEY=your_secret_key_here
ATTESTATION_SECRET_KEY=any_random_string_for_signing
```

### 3. Start development server

```bash
npm run dev  # http://localhost:8787
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/verify-captcha` | POST | Verify Turnstile token |
| `/api/verify-attestation` | POST | Verify signed attestation |
| `/health` | GET | Health check |

## Deploy

```bash
npm run deploy       # Deploy to Cloudflare
npm run deploy:prod  # Deploy to production
```

Set secrets in production:
```bash
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ATTESTATION_SECRET_KEY
```

## Dependencies

- **wrangler**: ^4.54 - Cloudflare Workers CLI
- **@cloudflare/workers-types**: TypeScript types
