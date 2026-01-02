# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypedCode is a browser-based code editor that records every keystroke into a tamper-resistant SHA-256 hash chain with Proof of Sequential Work (PoSW). It proves code was typed character-by-character without copy/paste. The project uses npm workspaces with 5 packages.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Development (all packages concurrently)
npm run dev

# Development (individual packages)
npm run dev:editor    # http://localhost:5173
npm run dev:verify    # http://localhost:5174
npm run dev:workers   # http://localhost:8787

# Build
npm run build              # All packages
npm run build:editor
npm run build:verify
npm run build:verify-cli

# Test (only shared package has tests)
npm run test -w @typedcode/shared
npm run test:coverage -w @typedcode/shared
```

## Architecture

### Package Structure

```
packages/
├── shared/     # Core library: TypingProof, Fingerprint, verification, types
├── editor/     # Monaco-based editor with keystroke tracking
├── verify/     # Web app for proof verification (VSCode-like UI)
├── verify-cli/ # CLI tool for verification
└── workers/    # Cloudflare Workers for Turnstile integration
```

### Core Concepts

**TypingProof** (`shared/src/typingProof.ts`): Central class managing the hash chain. Each event is hashed with SHA-256, chained to the previous hash, and periodically checkpointed. PoSW computation runs in a Web Worker.

**Event Types**: All user actions are recorded as typed events (`EventType` in `shared/src/types.ts`): content changes, cursor movements, mouse positions, keystrokes, visibility changes, paste/drop detection, and human attestation.

**Proof File Format**: Exported as JSON containing events array, hash chain, PoSW data, fingerprint, and optional screenshots with manifest.

### Key Data Flow

1. **Editor** (`editor/`):
   - `InputDetector` + `OperationDetector` capture all editor operations
   - `EventRecorder` queues events to `TypingProof`
   - `ProofExporter` creates final proof file with PoSW

2. **Verification** (`verify/` or `verify-cli/`):
   - `FileProcessor` parses JSON/ZIP proof files
   - `VerificationQueue` processes proofs via Web Worker
   - `TrustCalculator` computes overall trust level (verified/partial/failed)
   - `ScreenshotService` handles screenshot hash verification

### Shared Module Exports

The `@typedcode/shared` package exports:
- `TypingProof` - Hash chain management
- `Fingerprint` - Browser fingerprinting
- `verifyProofFile`, `verifyChain`, `verifyPoSW` - Verification functions
- `AttestationService` - Human verification via Turnstile
- Common types and calculations

## Environment Configuration

For Turnstile (human verification), see README.md for `.env` and `.dev.vars` setup.
