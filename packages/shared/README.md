# @typedcode/shared

Shared library for TypedCode - types, cryptographic proof engine, and device fingerprinting.

## Installation

```typescript
import { TypingProof, Fingerprint } from '@typedcode/shared';
import type { FingerprintComponents, StoredEvent } from '@typedcode/shared';
```

## Components

### TypingProof

Hash chain and Proof of Sequential Work (PoSW) engine.

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
| `recordEvent(event)` | Record event and update hash |
| `recordHumanAttestation(data)` | Record human verification as event #0 |
| `verify(onProgress?)` | Full hash chain verification |
| `verifySampled(checkpoints, count?)` | Sampled verification using checkpoints |
| `exportProof(content)` | Export proof data |
| `isAllowedInputType(type)` | Check if input type is allowed |
| `isProhibitedInputType(type)` | Check if input type is prohibited |

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
- Browser: userAgent, language, platform
- Hardware: hardwareConcurrency, deviceMemory
- Screen: width, height, colorDepth, devicePixelRatio
- Environment: timezone, timezoneOffset
- Rendering: Canvas fingerprint, WebGL info

## Types

```typescript
import type {
  EventType,              // 'contentChange' | 'cursorPositionChange' | ...
  InputType,              // 'insertText' | 'insertFromPaste' | ...
  StoredEvent,            // Recorded event
  ExportedProof,          // Single file export
  MultiFileExportedProof, // Multi-file export
  VerificationResult,     // Verification result
} from '@typedcode/shared';

import { isMultiFileProof } from '@typedcode/shared';
```

## Test

```bash
npm run test
npm run test:coverage
```

## Technical Details

### Hash Chain

```
h_0 = SHA-256(fingerprint || random)
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, 10000)
h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)
```

- PoSW: 10,000 sequential hash iterations (runs in Web Worker)
- Checkpoints: Created every 100 events for efficient sampling verification
