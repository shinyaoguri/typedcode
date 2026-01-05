# @typedcode/editor

Main editor application - Monaco Editor-based sequential typing proof editor with in-browser code execution.

## Features

- **Multi-tab Editing**: Independent proof chain per tab with tab switch tracking
- **Language Support**: C, C++, Python, JavaScript, TypeScript
- **Theme**: Light/Dark mode with system preference detection
- **Event Tracking**: 21 event types including keystrokes, cursor, paste/drop, window, focus, visibility
- **PoSW**: Proof of Sequential Work (10,000 sequential hashes per event via Web Worker)
- **Screenshot Capture**: Periodic and focus-loss triggered screenshots with hash verification
- **Human Verification**: Cloudflare Turnstile integration at file creation and export
- **Export**: ZIP archive containing proof JSON, source code, screenshots, and README
- **i18n**: Japanese and English UI

## In-Browser Code Execution

| Language | Runtime | Details |
|----------|---------|---------|
| C | Wasmer SDK | Clang WASM, stdin/stdout support |
| C++ | Wasmer SDK | Clang++ WASM |
| Python | Wasmer SDK | Python WASM runtime |
| JavaScript | Native | Browser eval with console capture |
| TypeScript | SWC | Transpile to JS then eval |

## Development

```bash
npm run dev      # http://localhost:5173
npm run build
npm run preview
```

## Architecture

```
src/
├── main.ts                    # Entry point
├── app/
│   ├── DataCleaner.ts         # Data cleanup utilities
│   ├── TermsHandler.ts        # Terms of service handling
│   └── UrlParamHandler.ts     # URL parameter processing
├── core/
│   ├── AppContext.ts          # Application context and state
│   └── EventRecorder.ts       # Central event dispatcher
├── editor/
│   ├── EditorController.ts    # Monaco change tracking
│   ├── CursorTracker.ts       # Cursor/selection events
│   └── ThemeManager.ts        # Theme switching
├── tracking/
│   ├── OperationDetector.ts   # Operation type detection from Monaco
│   ├── InputDetector.ts       # Paste/drop detection
│   ├── KeystrokeTracker.ts    # Keyboard events (keyDown/keyUp)
│   ├── MouseTracker.ts        # Mouse position tracking
│   ├── WindowTracker.ts       # Window resize events
│   ├── VisibilityTracker.ts   # Tab visibility changes
│   ├── NetworkTracker.ts      # Network status changes
│   ├── ScreenshotTracker.ts   # Screenshot capture (IndexedDB storage)
│   └── TrackersInitializer.ts # Initialize all trackers
├── execution/
│   ├── CodeExecutionController.ts  # Code execution orchestration
│   └── RuntimeManager.ts           # Wasmer SDK management
├── executors/
│   ├── base/BaseExecutor.ts        # Base executor class
│   ├── interfaces/ILanguageExecutor.ts  # Executor interface
│   ├── c/CExecutor.ts              # C language executor
│   ├── cpp/CppExecutor.ts          # C++ executor
│   ├── javascript/JavaScriptExecutor.ts
│   ├── typescript/TypeScriptExecutor.ts
│   ├── python/PythonExecutor.ts
│   └── registry/ExecutorRegistry.ts
├── terminal/
│   └── CTerminal.ts           # xterm.js wrapper
├── ui/
│   ├── tabs/
│   │   ├── TabManager.ts      # Tab state management
│   │   └── TabUIController.ts # Tab UI rendering
│   ├── dialogs/
│   │   └── ScreenCaptureDialogs.ts  # Screen capture dialogs
│   └── components/
│       ├── Modal.ts           # Modal dialogs
│       ├── NotificationManager.ts
│       ├── SettingsDropdown.ts
│       ├── DownloadDropdown.ts
│       ├── MainMenuDropdown.ts
│       ├── ProofStatusDisplay.ts
│       ├── TerminalPanel.ts
│       ├── LogViewerPanel.ts
│       ├── LogViewer.ts       # Log viewer component
│       ├── BrowserPreviewPanel.ts
│       ├── ProcessingDialog.ts     # Hash calculation progress
│       ├── ExportProgressDialog.ts # Export progress display
│       ├── AboutDialog.ts          # About dialog
│       └── ScreenShareGuide.ts     # Screen share guide
├── export/
│   ├── ProofExporter.ts       # Proof export (JSON/ZIP)
│   ├── readme-template-en.ts  # README template (English)
│   └── readme-template-ja.ts  # README template (Japanese)
├── services/
│   ├── TurnstileService.ts    # Cloudflare Turnstile integration
│   ├── StorageService.ts      # localStorage/sessionStorage
│   ├── ScreenshotStorageService.ts  # IndexedDB for screenshots
│   ├── ScreenCaptureService.ts     # Screen capture API
│   └── DownloadService.ts     # File download
├── workers/
│   └── poswWorker.ts          # PoSW computation Web Worker
├── config/
│   ├── MonacoConfig.ts        # Monaco worker configuration
│   └── SupportedLanguages.ts  # Supported language definitions
├── styles/                    # CSS stylesheets
└── i18n/
    └── translations/          # ja.ts, en.ts
```

## Event Flow

```
User Action
    ↓
InputDetector (paste/drop detection)
    ↓
OperationDetector (Monaco change events → operation type)
    ↓
KeystrokeTracker / MouseTracker / etc.
    ↓
EventRecorder (event queuing)
    ↓
TypingProof.recordEvent() (@typedcode/shared)
    ↓
HashChainManager (SHA-256 hash computation, @typedcode/shared)
    ↓
PoswManager (Web Worker: 10,000 iterations, @typedcode/shared)
    ↓
StoredEvent (event array storage, @typedcode/shared)
    ↓
localStorage (tab state persistence)
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_TURNSTILE_SITE_KEY` | Turnstile site key | Optional |
| `VITE_API_URL` | Workers API endpoint | Optional |

## Build Info Injection

The build process injects the following variables:

```typescript
__APP_VERSION__      // package.json version
__GIT_COMMIT__       // Git commit hash
__GIT_COMMIT_DATE__  // Git commit date
__BUILD_DATE__       // Build timestamp
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| monaco-editor | ^0.55 | Code editor engine |
| @xterm/xterm | ^6.0 | Terminal emulator |
| @xterm/addon-fit | ^0.11 | Terminal auto-resize |
| @wasmer/sdk | ^0.10 | WebAssembly runtime |
| jszip | ^3.10 | ZIP export |
| vite | ^7.3 | Build tool |
| vite-plugin-wasm | ^3.5 | WASM support |
| vite-plugin-top-level-await | ^1.6 | Top-level await support |

## Screenshot Feature

Screenshots are captured:
- Periodically (configurable interval)
- On focus loss (window blur)
- Manually (user triggered)

Storage: IndexedDB with SHA-256 hash verification
Export: Included in ZIP with manifest.json
