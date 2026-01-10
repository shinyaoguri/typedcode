# @typedcode/verify

Web-based proof verification application for TypedCode exported files with VSCode-like UI.

## Features

- **File Upload**: Drag & drop, file selection, or folder sync via File System Access API
- **Hash Chain Verification**: Recalculates and verifies all SHA-256 hashes
- **PoSW Verification**: Validates Proof of Sequential Work (Web Worker)
- **Sampled Verification**: Fast verification using checkpoints
- **Timeline Visualization**: Interactive timeline with event seek bar
- **Charts**: Mouse trajectory and event distribution (Chart.js)
- **Screenshot Verification**: Hash verification for captured screenshots
- **Human Attestation**: Verify Turnstile attestation signatures
- **Multi-file Support**: Handle ZIP exports with multiple files
- **i18n**: Japanese and English UI

## Development

```bash
npm run dev      # http://localhost:5174
npm run build
npm run preview
```

## Key Concepts

### Verification Flow

```
File Selection (drag & drop / File System Access API)
    ↓
FileProcessor (JSON parse or ZIP extraction)
    ↓
Format Detection (single-file or multi-file)
    ↓
VerificationEngine.verify()
    ↓
VerificationQueue (Web Worker)
    ├─ Sequence number check
    ├─ Timestamp continuity check
    ├─ Previous hash validation
    ├─ Hash recalculation
    └─ PoSW verification (10,000 iterations)
    ↓
AttestationService.verify() (Workers API)
    ↓
UI Display (ResultPanel, charts)
```

### Sampled vs Full Verification

| Mode | When Used | Speed | Accuracy |
|------|-----------|-------|----------|
| **Sampled** | Checkpoints available | Fast (O(samples)) | Statistical guarantee |
| **Full** | No checkpoints | Slow (O(n)) | 100% verification |

**Sampled verification** randomly selects checkpoint segments and verifies:
1. First segment (initial hash → first checkpoint)
2. Last segment (last checkpoint → final hash)
3. Random intermediate segments

This provides statistical assurance while enabling fast verification of large proof files.

### Trust Level Calculation

The `TrustCalculator` computes a trust score based on:

| Factor | Impact |
|--------|--------|
| Pure typing | High trust |
| Human attestation verified | +Trust |
| Timestamps consistent | Required |
| Hash chain valid | Required |
| Paste/drop events | -Trust |
| Template injection | Noted but allowed |

### Typing Pattern Analysis

The `TypingPatternCard` analyzes:
- Typing speed (WPM) over time
- Key press intervals
- Pause patterns
- Focus/blur frequency

These metrics help identify unusual patterns that might indicate automated input.

### Chart Visualization

| Chart | Purpose |
|-------|---------|
| **IntegratedChart** | Typing speed, focus state, keystrokes over time |
| **TimelineChart** | Event distribution with annotations |
| **MouseChart** | Mouse position heatmap |

Charts support:
- Zoom and pan (chartjs-plugin-zoom)
- Screenshot overlay at capture points
- Event filtering via `ChartEventSelector`

## Supported Formats

### Single File (JSON)

```json
{
  "version": "1.0.0",
  "typingProofHash": "sha256...",
  "typingProofData": {
    "finalContentHash": "...",
    "finalEventChainHash": "...",
    "metadata": { "isPureTyping": true }
  },
  "proof": {
    "events": [...],
    "finalHash": "..."
  },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...]
}
```

### Multi-File (JSON)

```json
{
  "version": "1.0.0",
  "type": "multi-file",
  "files": {
    "main.c": { /* ExportedProof */ },
    "utils.h": { /* ExportedProof */ }
  },
  "tabSwitches": [...],
  "fingerprint": {...},
  "metadata": { "totalFiles": 2, "overallPureTyping": true }
}
```

### ZIP Format

- `proof.json` - Main proof file
- `screenshots/` - Captured screenshots (JPEG)
- `manifest.json` - Screenshot hashes and metadata
- `README.md` - Verification guide

## Verification Results

| Result | Description |
|--------|-------------|
| Verified | All checks passed, pure typing |
| Partial | Chain valid but contains paste/drop |
| Failed | Chain integrity compromised |

## Verification Errors

| Error | Description |
|-------|-------------|
| Sequence mismatch | Event order inconsistency |
| Timestamp violation | Timestamp going backwards |
| Previous hash mismatch | Chain link broken |
| PoSW verification failed | Invalid proof of work |
| Hash mismatch | Computed hash doesn't match |

## File System Access API

The verify app supports folder synchronization using the File System Access API:

```typescript
// Select folder and auto-sync
const handle = await showDirectoryPicker();
// Files are automatically re-verified when changed
```

This feature allows real-time verification during development.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @typedcode/shared | * | Core types and verification |
| chart.js | ^4.4 | Chart visualization |
| chartjs-plugin-annotation | ^3.0 | Chart annotations |
| chartjs-plugin-zoom | ^2.0 | Chart zoom/pan |
| highlight.js | ^11.11 | Syntax highlighting |
| jszip | ^3.10 | ZIP handling |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_API_URL` | Workers API endpoint (for attestation verification) | Optional |
