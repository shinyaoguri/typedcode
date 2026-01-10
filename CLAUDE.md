# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypedCode is a browser-based code editor that records every keystroke into a tamper-resistant SHA-256 hash chain with Proof of Sequential Work (PoSW). It proves code was typed character-by-character without copy/paste. The project uses npm workspaces with 5 packages.

**Version**: 1.0.0
**Tech Stack**: TypeScript 5.9, Vite, Monaco Editor, Wasmer SDK, Chart.js, Cloudflare Workers

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
├── verify-cli/ # CLI tool for verification (Node.js ≥22)
└── workers/    # Cloudflare Workers for Turnstile integration
```

### Shared Package (`@typedcode/shared`)

Core library providing:

| Module | Purpose |
|--------|---------|
| `typingProof/TypingProof.ts` | Facade class for hash chain management |
| `typingProof/HashChainManager.ts` | SHA-256 hash computation and chaining |
| `typingProof/PoswManager.ts` | PoSW computation via Web Worker |
| `typingProof/CheckpointManager.ts` | Periodic checkpoint management |
| `typingProof/ChainVerifier.ts` | Chain verification (full/sampling) |
| `typingProof/InputTypeValidator.ts` | Input type validation (allowed/blocked) |
| `typingProof/StatisticsCalculator.ts` | Statistics computation |
| `fingerprint.ts` | Browser fingerprinting |
| `verification.ts` | Verification utility functions |
| `poswWorker.ts` | PoSW calculation Web Worker |
| `attestation.ts` | Human verification service |
| `calculations.ts` | Utility calculations (typing speed, etc.) |
| `fileProcessing/` | ZIP/JSON parsing |
| `types.ts` | All type definitions |

### Editor Package (`@typedcode/editor`)

| Directory | Purpose |
|-----------|---------|
| `core/` | `AppContext`, `EventRecorder` |
| `tracking/` | Event detectors: `InputDetector`, `OperationDetector`, `KeystrokeTracker`, `MouseTracker`, `WindowTracker`, `VisibilityTracker`, `NetworkTracker`, `ScreenshotTracker` |
| `editor/` | `EditorController`, `CursorTracker`, `ThemeManager` |
| `execution/` | `CodeExecutionController`, `RuntimeManager` |
| `executors/` | Language executors: C, C++, JavaScript, TypeScript, Python |
| `ui/components/` | UI components: Modals, Notifications, Dropdowns, Panels |
| `export/` | `ProofExporter`, README templates |
| `services/` | `TurnstileService`, `StorageService`, `ScreenshotStorageService` |
| `terminal/` | `CTerminal` (xterm.js integration) |

### Verify Package (`@typedcode/verify`)

| Directory | Purpose |
|-----------|---------|
| `core/` | `VerificationEngine`, `VerifyContext` |
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBar`, `ResultPanel`, `Sidebar`, `TypingPatternCard`, `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService` |
| `workers/` | `verificationWorker.ts` |

### Workers Package (`@typedcode/workers`)

Cloudflare Workers API endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/verify-captcha` | POST | Turnstile token verification |
| `/api/verify-attestation` | POST | HMAC signature verification |
| `/health` | GET | Health check |

## Core Concepts

### Event Types (24 types)

```typescript
// Content events
'contentChange' | 'contentSnapshot' | 'externalInput' | 'templateInjection'

// Cursor events
'cursorPositionChange' | 'selectionChange'

// Input events
'keyDown' | 'keyUp' | 'mousePositionChange'

// Window events
'focusChange' | 'visibilityChange' | 'windowResize'

// System events
'editorInitialized' | 'networkStatusChange'

// Authentication events
'humanAttestation' | 'preExportAttestation' | 'termsAccepted'

// Execution events
'codeExecution' | 'terminalInput'

// Capture events
'screenshotCapture' | 'screenShareStart' | 'screenShareStop'

// Session events
'sessionResumed' | 'copyOperation'
```

### Input Types (27 types)

**Allowed (18 types)**: `insertText`, `insertLineBreak`, `insertParagraph`, `insertTab`, `insertFromComposition`, `insertCompositionText`, `deleteCompositionText`, `deleteContentBackward`, `deleteContentForward`, `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`, `deleteSoftLineForward`, `deleteHardLineBackward`, `deleteHardLineForward`, `deleteByDrag`, `deleteByCut`, `insertFromInternalPaste`

**Blocked (external input, 5 types)**: `insertFromPaste`, `insertFromDrop`, `insertFromYank`, `insertReplacementText`, `insertFromPasteAsQuotation`

**Other (4 types)**: `historyUndo`, `historyRedo`, `replaceContent`, `insertTab`

Note: `insertFromInternalPaste` is allowed - it detects when users copy/paste within the same editor session.

### PoSW (Proof of Sequential Work)

- Fixed 10,000 iterations per event
- Computed in Web Worker (non-blocking)
- Includes random nonce (16 bytes)
- Timeout: 30 seconds

### Hash Chain Verification

1. Initial hash matches fingerprint hash
2. Sequence numbers are continuous
3. Timestamps are monotonically increasing
4. Each event's `previousHash` matches expected value
5. PoSW is valid for each event

### Proof File Format

**Single File (`ExportedProof`)**:
```json
{
  "version": "1.0.0",
  "typingProofHash": "sha256...",
  "typingProofData": {
    "finalContentHash": "...",
    "finalEventChainHash": "...",
    "deviceId": "...",
    "metadata": { "totalEvents": 123, "isPureTyping": true }
  },
  "proof": { "events": [...], "finalHash": "..." },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...]
}
```

**Multi-File (`MultiFileExportedProof`)**:
```json
{
  "type": "multi-file",
  "files": { "file1.js": {...}, "file2.py": {...} },
  "tabSwitches": [...],
  "metadata": { "totalFiles": 2, "overallPureTyping": true }
}
```

**ZIP Format**: `proof.json`, `screenshots/`, `manifest.json`, `README.md`

## Key Data Flow

### Editor Flow

```
User Action → InputDetector → OperationDetector → EventRecorder
    → TypingProof.recordEvent() → HashChainManager → PoswManager (Worker)
    → StoredEvent → localStorage
```

### Export Flow

```
ProofExporter.export() → performPreExportVerification() (Turnstile)
    → getProofData() → ScreenshotTracker.getAllScreenshots()
    → JSZip → Download
```

### Verification Flow

```
File Selection → FileProcessor → VerificationEngine.verify()
    → VerificationQueue (Worker) → ChainVerifier + PoSW verification
    → AttestationService.verify() (Workers API) → UI Display
```

## Environment Configuration

### Editor (.env)
```
VITE_TURNSTILE_SITE_KEY=your_site_key
VITE_API_URL=http://localhost:8787
```

### Workers (.dev.vars)
```
TURNSTILE_SECRET_KEY=your_secret_key
ATTESTATION_SECRET_KEY=any_random_string
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `shared/src/types.ts` | All type definitions (22KB) |
| `shared/src/typingProof/TypingProof.ts` | Main facade class |
| `editor/src/core/EventRecorder.ts` | Central event recording |
| `editor/src/tracking/InputDetector.ts` | Paste/drop detection |
| `editor/src/export/ProofExporter.ts` | Proof file generation |
| `verify/src/core/VerificationEngine.ts` | Verification logic |
| `verify/src/workers/verificationWorker.ts` | Worker-based verification |
| `workers/src/index.ts` | API endpoints |

## Version Constants

```typescript
export const PROOF_FORMAT_VERSION = '1.0.0';
export const STORAGE_FORMAT_VERSION = 1;
export const MIN_SUPPORTED_VERSION = '1.0.0';
export const POSW_ITERATIONS = 10000;
```

## i18n

Supported locales: `ja` (Japanese), `en` (English)

Detection order: localStorage → browser language → default (ja)
