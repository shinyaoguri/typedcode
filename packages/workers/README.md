# @typedcode/workers

Cloudflare Workers API for TypedCode - Turnstile human verification and attestation signing.

## Features

- **Turnstile Verification**: Validate Cloudflare Turnstile tokens
- **Attestation Signing**: HMAC-SHA256 signed attestations
- **Attestation Verification**: Verify signed attestation integrity
- **CORS Support**: Configurable CORS for editor and verify apps

## Setup

### 1. Get Turnstile Keys

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
2. Create a new Turnstile widget
3. Note your **Site Key** (for editor) and **Secret Key** (for workers)

### 2. Configure Local Development

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
```
TURNSTILE_SECRET_KEY=your_secret_key_here
ATTESTATION_SECRET_KEY=any_random_string_for_signing
```

### 3. Start Development Server

```bash
npm run dev  # http://localhost:8787
```

## API Endpoints

### POST `/api/verify-captcha`

Verify Turnstile token and return signed attestation.

**Request:**
```json
{
  "token": "turnstile_response_token"
}
```

**Response (success):**
```json
{
  "success": true,
  "score": 1.0,
  "message": "Verification successful",
  "attestation": {
    "verified": true,
    "score": 1.0,
    "action": "human_verification",
    "timestamp": "2026-01-05T10:30:00.000Z",
    "hostname": "typedcode.dev",
    "signature": "hmac_sha256_signature"
  }
}
```

**Response (failure):**
```json
{
  "success": false,
  "score": 0,
  "message": "Verification failed"
}
```

### POST `/api/verify-attestation`

Verify signed attestation integrity.

**Request:**
```json
{
  "attestation": {
    "verified": true,
    "score": 1.0,
    "action": "human_verification",
    "timestamp": "2026-01-05T10:30:00.000Z",
    "hostname": "typedcode.dev",
    "signature": "hmac_sha256_signature"
  }
}
```

**Response:**
```json
{
  "valid": true,
  "message": "Attestation is valid"
}
```

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "environment": "development"
}
```

## Signature Algorithm

The attestation signature is computed using HMAC-SHA256:

```typescript
const payload = JSON.stringify({
  verified: attestation.verified,
  score: attestation.score,
  action: attestation.action,
  timestamp: attestation.timestamp,
  hostname: attestation.hostname
});

const signature = HMAC_SHA256(payload, ATTESTATION_SECRET_KEY);
```

## Deploy

### Development

```bash
npm run dev       # Start local server
```

### Production

```bash
npm run deploy       # Deploy to Cloudflare
npm run deploy:prod  # Deploy to production environment
```

### Set Production Secrets

```bash
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ATTESTATION_SECRET_KEY
```

## Configuration

### wrangler.toml

```toml
name = "typedcode-api"
main = "src/index.ts"
compatibility_date = "2025-12-26"

[vars]
ENVIRONMENT = "development"

[env.production]
vars = { ENVIRONMENT = "production" }
```

## Architecture

```
src/
└── index.ts           # Single-file implementation containing:
                       # - Router and request handling
                       # - Turnstile verification handler
                       # - Attestation verification handler
                       # - Health check handler
                       # - CORS handling
                       # - HMAC signing utilities
                       # - Type definitions
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret | Yes |
| `ATTESTATION_SECRET_KEY` | HMAC signing key | Yes |
| `ENVIRONMENT` | Environment name | No |

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| wrangler | ^4.54 | Cloudflare Workers CLI |
| @cloudflare/workers-types | * | TypeScript types |

## Security Considerations

1. **Secret Keys**: Never commit `.dev.vars` or expose secrets
2. **CORS**: Configure allowed origins appropriately
3. **Rate Limiting**: Consider adding rate limiting for production
4. **Signature Verification**: Always verify attestation signatures server-side
