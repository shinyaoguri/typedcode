

# TypedCode

<img align="right" src="icon.png" alt="TypedCode Logo" height="150">

A VSCode-like code editor that records every keystroke into a tamper-resistant hash chain, proving code was typed character-by-character. Runs entirely in your browser with built-in execution for C/C++, Python, and JavaScript/TypeScript via WebAssembly.

**Free, unlimited, no sign-up. No data leaves your browser.**

**Key Features:**
- Tamper-resistant proof logs (SHA-256 + PoSW hash chain)
- Copy/paste detection and recording
- In-browser code execution (no server required)
- Export code with independently verifiable proof

## Packages

| Package | Description |
|---------|-------------|
| [@typedcode/editor](packages/editor/) | Main editor application (Monaco-based) |
| [@typedcode/verify](packages/verify/) | Web-based proof verification |
| [@typedcode/verify-cli](packages/verify-cli/) | CLI tool for proof verification |
| [@typedcode/shared](packages/shared/) | Shared library (types, TypingProof, Fingerprint) |
| [@typedcode/workers](packages/workers/) | Cloudflare Workers API (Turnstile integration) |

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

## Use Cases

- Programming exams with paste detection
- Educational progress tracking
- Coding assignment transparency
- Typing behavior research

## License

MIT License
