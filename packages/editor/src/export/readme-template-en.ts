/**
 * README Template (English)
 * Template for the README.md file included in exported ZIP archives
 */

export interface ReadmeTemplateParams {
  timestamp: string;
  totalFiles: number;
  totalScreenshots: number;
  sourceFiles: string[];
  proofFiles: string[];
}

export function generateReadmeEn(params: ReadmeTemplateParams): string {
  const { timestamp, totalFiles, totalScreenshots, sourceFiles, proofFiles } = params;

  const sourceFilesList = sourceFiles.map(f => `- \`${f}\``).join('\n');
  const proofFilesList = proofFiles.map(f => `- \`${f}\``).join('\n');

  return `# TypedCode Proof Archive

## Overview

This archive contains typing proof data exported from TypedCode, a code editor that cryptographically records all editing operations to prove that code was typed by a human.

**Generated:** ${timestamp}
**Total Source Files:** ${totalFiles}
**Total Screenshots:** ${totalScreenshots}

---

## Archive Contents

### Source Files
${sourceFilesList}

### Proof Files
${proofFilesList}

### Screenshots
- \`screenshots/\` - Periodic screen captures
- \`screenshots/manifest.json\` - Screenshot metadata and hash mappings

---

## Hash Chain Architecture

TypedCode uses a cryptographic hash chain (similar to blockchain) to ensure the integrity of recorded events.

### How It Works

\`\`\`
Event[0] ─┐
          ├─► Hash[0] = SHA-256(Event[0] + PoSW[0])
          │
Event[1] ─┼─► Hash[1] = SHA-256(Event[1] + Hash[0] + PoSW[1])
          │
Event[2] ─┼─► Hash[2] = SHA-256(Event[2] + Hash[1] + PoSW[2])
          │
   ...    │
          │
Event[N] ─┴─► Hash[N] = SHA-256(Event[N] + Hash[N-1] + PoSW[N])
\`\`\`

Each event's hash depends on:
1. **Event Data** - The actual operation (keystroke, cursor move, etc.)
2. **Previous Hash** - The hash of the preceding event
3. **Proof of Sequential Work (PoSW)** - A computational proof that takes time to generate

### Why Tampering Is Difficult

| Attack Scenario | Why It Fails |
|-----------------|--------------|
| Modify a single event | Changes that event's hash, invalidating all subsequent hashes |
| Insert/delete events | Breaks the chain continuity |
| Recompute entire chain | PoSW makes this computationally expensive |
| Forge timestamps | Inconsistent with adjacent events and PoSW timing |

---

## Event Types

The following events are recorded in the hash chain:

### Editing Events
| Event Type | Description |
|------------|-------------|
| \`contentChange\` | Text insertion, deletion, or replacement |
| \`contentSnapshot\` | Periodic full content snapshot |
| \`cursorPositionChange\` | Cursor movement |
| \`selectionChange\` | Text selection changes |
| \`externalInput\` | Paste or drop operations (flagged) |

### Input Events
| Event Type | Description |
|------------|-------------|
| \`keyDown\` | Key press with timing data |
| \`keyUp\` | Key release with dwell time |

### Environment Events
| Event Type | Description |
|------------|-------------|
| \`visibilityChange\` | Tab visibility (active/inactive) |
| \`focusChange\` | Window focus state |
| \`windowResize\` | Browser window size changes |
| \`networkStatusChange\` | Online/offline status |

### Screen Capture Events
| Event Type | Description |
|------------|-------------|
| \`screenShareStart\` | Screen sharing initiated |
| \`screenShareStop\` | Screen sharing ended |
| \`screenshotCapture\` | Screenshot taken (hash recorded) |

### Authentication Events
| Event Type | Description |
|------------|-------------|
| \`humanAttestation\` | Cloudflare Turnstile verification |
| \`preExportAttestation\` | Pre-export verification |
| \`termsAccepted\` | Terms of service agreement |

---

## Screenshot Verification

Screenshots are captured periodically and their hashes are recorded in the chain.

### Capture Triggers
- **Periodic**: Every 60 seconds
- **Focus Lost**: 5 seconds after window loses focus
- **Manual**: User-triggered (future feature)

### Storage Format
- **Format**: JPEG (60% quality)
- **Location**: \`screenshots/\` folder in ZIP
- **Naming**: \`screenshot_SEQUENCE_TIMESTAMP.jpg\`

### Manifest File (\`screenshots/manifest.json\`)

The manifest links screenshot files to hash chain events:

\`\`\`json
[
  {
    "index": 0,
    "filename": "screenshot_000042_2025-01-15T10-30-00-000Z.jpg",
    "imageHash": "5f2a8c3d...",
    "captureType": "periodic",
    "eventSequence": 42,
    "timestamp": 123456.789,
    "createdAt": 1705312200000,
    "displayInfo": {
      "width": 1920,
      "height": 1080,
      "devicePixelRatio": 2,
      "displaySurface": "monitor"
    },
    "fileSizeBytes": 45678
  }
]
\`\`\`

### Verification Process

1. Read the manifest file
2. For each entry:
   - Locate the image file by \`filename\`
   - Compute SHA-256 hash of the image
   - Compare with \`imageHash\` in manifest
   - Find the corresponding event in the proof log by \`eventSequence\`
   - Verify the event's \`data.imageHash\` matches

---

## Proof File Structure

Each \`*_proof.json\` file contains:

\`\`\`json
{
  "version": "1.0.0",
  "typingProofHash": "final_proof_hash...",
  "typingProofData": {
    "finalContentHash": "content_hash...",
    "finalEventChainHash": "chain_hash...",
    "deviceId": "device_fingerprint...",
    "metadata": {
      "totalEvents": 1234,
      "pasteEvents": 0,
      "dropEvents": 0,
      "insertEvents": 500,
      "deleteEvents": 100,
      "totalTypingTime": 3600000,
      "averageTypingSpeed": 45.5
    }
  },
  "proof": {
    "totalEvents": 1234,
    "finalHash": "last_event_hash...",
    "startTime": 1705312200000,
    "endTime": 1705315800000,
    "signature": "hmac_signature...",
    "events": [
      {
        "sequence": 0,
        "timestamp": 0.0,
        "type": "humanAttestation",
        "hash": "event_0_hash...",
        "previousHash": null,
        "posw": {
          "iterations": 10000,
          "nonce": "random_nonce...",
          "intermediateHash": "...",
          "computeTimeMs": 50
        },
        "data": { ... }
      },
      ...
    ]
  },
  "fingerprint": {
    "hash": "device_hash...",
    "components": { ... }
  },
  "metadata": {
    "userAgent": "...",
    "timestamp": "2025-01-15T10:30:00.000Z",
    "isPureTyping": true
  },
  "filename": "example.js",
  "content": "// Source code...",
  "language": "javascript"
}
\`\`\`

---

## Verification Steps

### Manual Verification

1. **Hash Chain Integrity**
   - Start from event #0
   - For each event, compute: \`SHA-256(event_data + previous_hash + posw)\`
   - Compare with stored \`hash\` value

2. **Screenshot Verification**
   - Compute SHA-256 of each image file
   - Match against \`imageHash\` in manifest
   - Match against \`data.imageHash\` in proof events

3. **Content Verification**
   - Replay all \`contentChange\` events
   - Compare final result with \`content\` field

### Automated Verification

Visit the TypedCode verification page and upload the proof JSON file for automated verification.

---

## Security Considerations

### What This Proves
- Code was typed character-by-character (not copy-pasted in bulk)
- Editing occurred in a continuous session
- Screen was shared during the session (screenshots as evidence)
- Human verification was performed (Turnstile attestation)

### What This Does NOT Prove
- Identity of the person typing
- That the code is original (not transcribed from elsewhere)
- That no external assistance was used

### Privacy Notes
- All data is stored locally in the browser
- No automatic server uploads
- Screenshots are only included in the exported ZIP
- Device fingerprint is hashed (not reversible)

---

## Technical Specifications

| Component | Specification |
|-----------|---------------|
| Hash Algorithm | SHA-256 |
| PoSW Iterations | 10,000 |
| Screenshot Format | JPEG, 60% quality |
| Screenshot Interval | 60 seconds |
| Focus Lost Delay | 5 seconds |
| Storage | IndexedDB (local) |

---

## License

This proof archive was generated by TypedCode.
For more information, visit: https://github.com/sny/typedcode

---

*This README was automatically generated at export time.*
`;
}
