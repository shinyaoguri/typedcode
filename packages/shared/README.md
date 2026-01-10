# @typedcode/shared

Core library for TypedCode - types, cryptographic proof engine, verification, and device fingerprinting.

## Installation

```typescript
import { TypingProof, Fingerprint, AttestationService } from '@typedcode/shared';
import type { FingerprintComponents, StoredEvent, ExportedProof } from '@typedcode/shared';
```

## Components

### TypingProof

Hash chain and Proof of Sequential Work (PoSW) engine with modular architecture.

```typescript
const proof = new TypingProof();
await proof.initialize(fingerprintHash, fingerprintComponents);

// Record events
await proof.recordEvent({
  type: 'contentChange',
  inputType: 'insertText',
  data: 'a',
  description: 'Character input',
});

// Verify chain integrity
const result = await proof.verify();

// Export proof data
const exported = await proof.exportProof(finalContent);
```

**Key Methods:**
| Method | Description |
|--------|-------------|
| `initialize(hash, components)` | Initialize with fingerprint |
| `recordEvent(event)` | Record event and update hash chain |
| `recordHumanAttestation(data)` | Record human verification as event #0 |
| `verify(onProgress?)` | Full hash chain verification |
| `verifySampled(checkpoints, count?)` | Sampled verification using checkpoints |
| `exportProof(content)` | Export proof data |
| `isAllowedInputType(type)` | Check if input type is allowed |
| `isProhibitedInputType(type)` | Check if input type is prohibited |
| `getStats()` | Get event statistics |
| `getTypingStatistics()` | Get typing-specific statistics |
| `reset()` | Reset chain and storage |

### Fingerprint

Browser fingerprinting and device ID management.

```typescript
// Get persistent device ID (stored in localStorage)
const deviceId = await Fingerprint.getDeviceId();

// Collect fingerprint components
const components = await Fingerprint.collectComponents();

// Generate fingerprint hash
const hash = await Fingerprint.generate();
```

**Collected Data:**
- Browser: userAgent, language, languages, platform
- Hardware: hardwareConcurrency, deviceMemory, maxTouchPoints
- Screen: width, height, colorDepth, devicePixelRatio
- Environment: timezone, timezoneOffset, cookieEnabled, doNotTrack
- Rendering: Canvas fingerprint, WebGL vendor/renderer
- Fonts: Detected system fonts

### AttestationService

Human verification via Cloudflare Turnstile.

```typescript
const attestation = new AttestationService(apiUrl);

// Verify attestation signature
const result = await attestation.verify(attestationData);
```

### File Processing

Parse and detect proof file formats.

```typescript
import {
  parseJsonString,
  parseZipBuffer,
  isMultiFileProof,
  isProofFile,
  extractFirstProofFromZip
} from '@typedcode/shared';

// Parse JSON proof
const proof = parseJsonString(jsonContent);

// Parse ZIP proof
const proof = await parseZipBuffer(arrayBuffer);

// Check if data is multi-file proof
if (isMultiFileProof(proof)) {
  // Handle multi-file proof
}
```

### Verification Functions

```typescript
import { verifyProofFile, verifyChain, verifyPoSW } from '@typedcode/shared';

// Full verification
const result = await verifyProofFile(proof);

// Chain-only verification
const chainResult = await verifyChain(events, fingerprint);

// PoSW verification
const poswResult = await verifyPoSW(event);
```

## Types

### Event Types (24 types)

```typescript
type EventType =
  // Content
  | 'contentChange' | 'contentSnapshot' | 'externalInput' | 'templateInjection'
  // Cursor
  | 'cursorPositionChange' | 'selectionChange'
  // Input
  | 'keyDown' | 'keyUp' | 'mousePositionChange'
  // Window
  | 'focusChange' | 'visibilityChange' | 'windowResize'
  // System
  | 'editorInitialized' | 'networkStatusChange'
  // Authentication
  | 'humanAttestation' | 'preExportAttestation' | 'termsAccepted'
  // Execution
  | 'codeExecution' | 'terminalInput'
  // Capture
  | 'screenshotCapture' | 'screenShareStart' | 'screenShareStop'
  // Session
  | 'sessionResumed' | 'copyOperation';
```

### Input Types (27 types)

```typescript
// Allowed input types (18 types)
type AllowedInputType =
  | 'insertText' | 'insertLineBreak' | 'insertParagraph' | 'insertTab'
  | 'insertFromComposition' | 'insertCompositionText' | 'deleteCompositionText'
  | 'deleteContentBackward' | 'deleteContentForward'
  | 'deleteWordBackward' | 'deleteWordForward'
  | 'deleteSoftLineBackward' | 'deleteSoftLineForward'
  | 'deleteHardLineBackward' | 'deleteHardLineForward'
  | 'deleteByDrag' | 'deleteByCut'
  | 'insertFromInternalPaste';  // Internal paste (allowed)

// Blocked input types (external input, 5 types)
type BlockedInputType =
  | 'insertFromPaste' | 'insertFromDrop' | 'insertFromYank'
  | 'insertReplacementText' | 'insertFromPasteAsQuotation';

// Other types (4 types)
// 'historyUndo' | 'historyRedo' | 'replaceContent' | 'insertTab'
```

### Core Types

```typescript
import type {
  StoredEvent,            // Recorded event with hash chain data
  ExportedProof,          // Single file export format
  MultiFileExportedProof, // Multi-file export format
  VerificationResult,     // Verification result
  Checkpoint,             // Hash chain checkpoint
  PoswData,               // Proof of Sequential Work data
  AttestationData,        // Human attestation data
  FingerprintComponents,  // Browser fingerprint components
} from '@typedcode/shared';
```

## Test

```bash
npm run test
npm run test:coverage
```

## Technical Specifications

### Hash Chain Algorithm

```
h_0 = SHA-256(fingerprint || random)
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, 10000)
h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)
```

- Each event's hash includes the previous hash, creating an unbreakable chain
- JSON serialization uses deterministic key ordering for reproducibility

### Proof of Sequential Work (PoSW)

| Property | Value |
|----------|-------|
| Iterations | 10,000 per event |
| Nonce | 16 bytes random |
| Timeout | 30 seconds |
| Execution | Web Worker (non-blocking) |

PoSW ensures that events cannot be bulk-generated or back-dated, as each event requires sequential computation.

### Checkpoint System

| Property | Value |
|----------|-------|
| Interval | Every 33 events |
| Purpose | Enable sampled verification |
| Contents | eventIndex, hash, timestamp, contentHash |

Checkpoints allow efficient verification of large proof files by sampling random segments instead of verifying all events.

### Verification Steps

1. **Initial hash** matches fingerprint hash
2. **Sequence numbers** are continuous (0, 1, 2, ...)
3. **Timestamps** are monotonically increasing
4. **Previous hash** of each event matches computed value
5. **PoSW** is valid for each event (10,000 iterations)

### Pure Typing Detection

A proof is considered "pure typing" when:
- No `insertFromPaste` events
- No `insertFromDrop` events
- No other blocked input types

Note: `insertFromInternalPaste` (copying within the same editor session) does NOT break pure typing status.

### Constants

```typescript
export const PROOF_FORMAT_VERSION = '1.0.0';
export const STORAGE_FORMAT_VERSION = 1;
export const MIN_SUPPORTED_VERSION = '1.0.0';
export const POSW_ITERATIONS = 10000;
export const CHECKPOINT_INTERVAL = 33;
```

## i18n

Provides `I18nService` for internationalization with Japanese and English support.

```typescript
import { I18nService, type SupportedLocale } from '@typedcode/shared';

const i18n = new I18nService(translations);  // Auto-detects locale
const text = i18n.t('common.cancel');
i18n.setLocale('en');
```
