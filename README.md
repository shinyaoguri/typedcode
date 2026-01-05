# TypedCode

<img align="right" src="icon.png" alt="TypedCode Logo" height="150">

[TypedCode](https://typedcode.dev) is a VSCode-like code editor that records every keystroke into a tamper-resistant SHA-256 hash chain with Proof of Sequential Work (PoSW). It proves code was typed character-by-character without copy/paste. Runs entirely in your browser with built-in execution for C/C++, Python, and JavaScript/TypeScript via WebAssembly.

This tool is primarily designed for programming exams that need to prevent AI-assisted copying and automated code generation, and for educators who want to verify programming processes for educational purposes.

**Free, unlimited, no sign-up. No data leaves your browser.**

## Key Features

- **Tamper-Resistant Proof**: SHA-256 hash chain with PoSW (10,000 iterations per event)
- **Human Verification**: Cloudflare Turnstile integration with HMAC-signed attestations
- **Comprehensive Event Tracking**: 22 event types including content changes, keystrokes, mouse movements, focus, visibility, paste/drop detection, and template injection
- **Multi-Tab Support**: Edit multiple files simultaneously with tab switch tracking
- **Screenshot Capture**: Periodic and focus-loss triggered screenshots with hash verification
- **In-Browser Execution**: C/C++, Python, JavaScript/TypeScript via Wasmer SDK (WebAssembly)
- **Export Formats**: ZIP archive containing proof JSON, source code, screenshots, and verification guide
- **Bilingual**: Japanese and English UI

## Packages

| Package | Description |
|---------|-------------|
| [@typedcode/editor](packages/editor/) | Monaco-based editor with keystroke tracking and code execution |
| [@typedcode/verify](packages/verify/) | Web-based proof verification |
| [@typedcode/verify-cli](packages/verify-cli/) | CLI tool for proof verification (Node.js ≥22) |
| [@typedcode/shared](packages/shared/) | Core library: TypingProof, Fingerprint, verification, types |
| [@typedcode/workers](packages/workers/) | Cloudflare Workers API for Turnstile integration |

## Live Demo

- **Editor**: [https://typedcode.dev](https://typedcode.dev)
- **Verify App**: [https://typedcode.dev/verify](https://typedcode.dev/verify)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Turnstile (optional but recommended)

Human verification requires [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/). Skip this step if you don't need human verification.

**Editor configuration:**
```bash
cp packages/editor/.env.example packages/editor/.env
```

Edit `packages/editor/.env`:
```
VITE_TURNSTILE_SITE_KEY=your_site_key
VITE_API_URL=http://localhost:8787
```

**Workers configuration:**
```bash
cp packages/workers/.dev.vars.example packages/workers/.dev.vars
```

Edit `packages/workers/.dev.vars`:
```
TURNSTILE_SECRET_KEY=your_secret_key
ATTESTATION_SECRET_KEY=any_random_string
```

Get your Turnstile keys from: https://dash.cloudflare.com/?to=/:account/turnstile

### 3. Start development servers

```bash
# Start all packages (editor + verify + workers)
npm run dev

# Or start individually
npm run dev:editor    # http://localhost:5173
npm run dev:verify    # http://localhost:5174
npm run dev:workers   # http://localhost:8787
```

## Build

```bash
# Build all packages
npm run build

# Build individually
npm run build:editor
npm run build:verify
npm run build:verify-cli
```

## Test

```bash
npm run test -w @typedcode/shared
npm run test:coverage -w @typedcode/shared
```

## Architecture

### How It Works

1. **Event Recording**: Every user action (keystroke, cursor move, paste, etc.) is captured as a typed event
2. **Hash Chain**: Each event is SHA-256 hashed and chained to the previous hash
3. **PoSW Computation**: Web Worker computes 10,000 iterations of hash for each event (non-blocking)
4. **Human Attestation**: Turnstile verification at file creation and before export
5. **Export**: Proof file contains complete event history, hash chain, fingerprint, and optional screenshots
6. **Verification**: Independent verification of chain integrity, timestamps, and PoSW

### Event Types (22 types)

| Category | Events |
|----------|--------|
| Content | `contentChange`, `contentSnapshot`, `externalInput`, `templateInjection` |
| Cursor | `cursorPositionChange`, `selectionChange` |
| Input | `keyDown`, `keyUp`, `mousePositionChange` |
| Window | `focusChange`, `visibilityChange`, `windowResize` |
| System | `editorInitialized`, `networkStatusChange` |
| Auth | `humanAttestation`, `preExportAttestation`, `termsAccepted` |
| Execution | `codeExecution`, `terminalInput` |
| Capture | `screenshotCapture`, `screenShareStart`, `screenShareStop` |

### Export File Format (ZIP)

Exported as `TC{timestamp}.zip` containing:
- `{filename}.{ext}` - Source code file
- `{filename}_proof.json` - Proof JSON (see structure below)
- `screenshots/` - Captured screenshots (JPEG)
- `screenshots/manifest.json` - Screenshot metadata and hashes
- `README.md` - Verification guide (English)
- `README.ja.md` - Verification guide (Japanese)

**Proof JSON Structure:**
```json
{
  "version": "1.0.0",
  "typingProofHash": "sha256...",
  "typingProofData": { "finalContentHash": "...", "metadata": {...} },
  "proof": { "events": [...], "finalHash": "..." },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...]
}
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Editor | Monaco Editor, xterm.js |
| Execution | Wasmer SDK (WebAssembly) |
| Verification UI | Chart.js, Highlight.js |
| Build | Vite, TypeScript 5.9 |
| Workers | Cloudflare Workers, Wrangler |
| Testing | Vitest |

## License

MIT License
