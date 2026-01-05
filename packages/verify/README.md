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

## Architecture

```
src/
├── main.ts                       # Entry point
├── core/
│   ├── VerificationEngine.ts     # Core verification logic (UI-independent)
│   └── VerifyContext.ts          # Application context
├── config/
│   └── VerificationTypes.ts      # Verification type definitions
├── ui/
│   ├── AppController.ts          # Main application controller
│   ├── TabBar.ts                 # Tab bar component
│   ├── ActivityBar.ts            # Activity bar (sidebar icons)
│   ├── StatusBar.ts              # Status bar (VerifyStatusBar class)
│   ├── StatusBarUI.ts            # Status bar UI rendering
│   ├── WelcomePanel.ts           # Welcome/drop zone panel
│   ├── VerifyFileListController.ts  # File list management
│   ├── ResultPanel.ts            # Result panel UI layer
│   ├── Sidebar.ts                # File explorer sidebar
│   ├── ScreenshotLightbox.ts     # Screenshot viewer
│   ├── ThemeManager.ts           # Theme management
│   └── AboutDialog.ts            # About dialog
├── ui/panels/
│   ├── ResultPanel.ts            # Verification result display
│   ├── MetadataPanel.ts          # Proof metadata display
│   ├── ChainPanel.ts             # Hash chain visualization
│   ├── PoswPanel.ts              # PoSW statistics display
│   └── AttestationPanel.ts       # Human attestation info
├── ui/controllers/
│   ├── VerificationController.ts # Verification flow controller
│   ├── TabController.ts          # Tab management controller
│   ├── FileController.ts         # File handling controller
│   ├── FolderController.ts       # Folder handling controller
│   └── ChartController.ts        # Chart management controller
├── state/
│   ├── VerificationQueue.ts      # Verification queue (Web Worker)
│   ├── UIStateManager.ts         # UI state management
│   ├── VerifyTabManager.ts       # Tab state management
│   └── ChartState.ts             # Chart state
├── charts/
│   ├── TimelineChart.ts          # Event timeline (Chart.js)
│   ├── MouseChart.ts             # Mouse position distribution
│   ├── IntegratedChart.ts        # Integrated chart with typing speed, focus, keystrokes
│   ├── SeekbarController.ts      # Timeline seekbar controller
│   ├── ScreenshotOverlay.ts      # Screenshot overlay on chart
│   └── ChartUtils.ts             # Chart utilities
├── services/
│   ├── FileProcessor.ts          # JSON/ZIP file parsing
│   ├── FileSystemAccessService.ts  # File System Access API
│   ├── FolderSyncManager.ts      # Folder synchronization
│   ├── SyntaxHighlighter.ts      # Highlight.js wrapper
│   ├── AttestationService.ts     # Attestation verification (re-export from shared)
│   ├── TrustCalculator.ts        # Trust level calculation
│   ├── ScreenshotService.ts      # Screenshot handling
│   └── ResultDataService.ts      # Result data processing
├── workers/
│   └── verificationWorker.ts     # Web Worker for verification
├── types/
│   └── file-system-access.d.ts   # File System Access API types
├── styles/                       # CSS stylesheets
└── i18n/
    └── translations/             # ja.ts, en.ts
```

## Verification Flow

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
    ├─ VerificationEngine.verifyChain()
    │   ├─ Sequence number check
    │   ├─ Timestamp continuity check
    │   ├─ Previous hash validation
    │   └─ Hash recalculation
    ├─ PoSW verification (10,000 iterations)
    └─ Metadata validation (isPureTyping)
    ↓
AttestationService.verify() (Workers API, @typedcode/shared)
    ↓
UI Display (panels, charts)
```

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

## Chart Features

### Timeline Chart
- Event distribution over time
- Annotations for important events (paste, attestation)
- Zoom and pan support (chartjs-plugin-zoom)

### Mouse Chart
- Mouse position distribution
- Heatmap-style visualization

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
