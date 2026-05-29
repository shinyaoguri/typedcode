# @typedcode/workers

Cloudflare Workers API for TypedCode - Turnstile human verification and attestation signing.

## Features

- **Turnstile Verification**: Validate Cloudflare Turnstile tokens
- **Attestation Signing**: HMAC-SHA256 signed attestations
- **Attestation Verification**: Verify signed attestation integrity
- **Signed Checkpoint Service**: ECDSA-P256 timestamped signatures for proof checkpoints, with KV-backed per-session `firstSeenAt`
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

### 3. Generate Signed Checkpoint Key (one-time, per developer)

```bash
npm run gen-checkpoint-key -w @typedcode/workers
```

This prints:
- A `CheckpointPublicKey` entry. Append it to
  `packages/shared/src/checkpointKeys/localKeys.ts`, then run:
  ```bash
  git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts
  ```
  so your personal dev key never lands in a commit. (Production keys go
  in `registry.ts` via a normal PR.)
- The matching `CHECKPOINT_SIGNING_KEY_ID` and `CHECKPOINT_SIGNING_KEY_JWK`.
  Paste both into `.dev.vars`.

Without these values the `/api/checkpoint/sign` endpoint returns
`SIGNING_KEY_NOT_CONFIGURED` (500). The rest of the API still works.

### 4. Create KV Namespace (one-time, per developer)

```bash
wrangler kv namespace create CHECKPOINT_SESSIONS
wrangler kv namespace create CHECKPOINT_SESSIONS --preview
```

Replace the two `REPLACE_WITH_*_ID` placeholders in `wrangler.toml` with
the IDs the command prints, then hide the file from accidental commits:

```bash
git update-index --skip-worktree packages/workers/wrangler.toml
```

(Undo with `--no-skip-worktree` if you ever need to edit the shared
parts of `wrangler.toml` and commit them. After committing, re-apply
skip-worktree.)

### 5. Start Development Server

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

### POST `/api/checkpoint/sign`

Sign an unsigned checkpoint payload from the editor with the server's
ECDSA-P256 key and an authoritative `serverTimestamp` / `firstSeenAt`.

**Request body** (see `SignedCheckpointInput` in `@typedcode/shared`):
```json
{
  "sessionId": "...",
  "tabId": "...",
  "checkpointIndex": 0,
  "eventIndex": 32,
  "initialEventChainHash": "...",
  "chainHash": "...",
  "contentHash": "...",
  "previousSignedCheckpointHash": null,
  "totalEventsSincePrevious": 33,
  "clientTimestamp": "2026-05-28T12:00:00.000Z"
}
```

**Response (success):**
```json
{ "envelope": { "payload": { ... }, "signature": "...", "keyId": "...", "algorithm": "ECDSA-P256" } }
```

**Error codes**: `SCHEMA_INVALID` (400), `NON_MONOTONIC` (409),
`SESSION_LIMIT_EXCEEDED` (429), `SIGNING_KEY_NOT_CONFIGURED` /
`SIGNING_KEY_UNKNOWN` / `SIGNING_ERROR` (500).

### GET `/api/checkpoint/public-keys`

Returns the git-managed registry of public keys for offline / cached
signature verification.

**Response:**
```json
{
  "keys": [
    {
      "keyId": "...",
      "algorithm": "ECDSA-P256",
      "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
      "status": "active",
      "validFrom": "..."
    }
  ],
  "cacheTtlSec": 86400
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
wrangler secret put CHECKPOINT_SIGNING_KEY_ID
wrangler secret put CHECKPOINT_SIGNING_KEY_JWK
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
| `CHECKPOINT_SIGNING_KEY_ID` | keyId for signed checkpoints (must exist in `CHECKPOINT_PUBLIC_KEYS` registry) | For `/api/checkpoint/sign` |
| `CHECKPOINT_SIGNING_KEY_JWK` | ECDSA-P256 private key JWK as a JSON string | For `/api/checkpoint/sign` |
| `ENVIRONMENT` | Environment name | No |

## KV Namespaces

| Binding | Purpose | TTL |
|---------|---------|-----|
| `CHECKPOINT_SESSIONS` | Per-session `firstSeenAt`, `lastCheckpointIndex`, `lastServerTimestamp`, `signedCount` (best-effort anti-replay; not required for verification) | 7 days |

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
