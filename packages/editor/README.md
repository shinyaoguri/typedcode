# @typedcode/editor

Main editor application - Monaco Editor-based sequential typing proof editor with in-browser code execution.

## Features

- **Multi-tab Editing**: Independent proof chain per tab with tab switch tracking
- **Language Support**: C, C++, Python, JavaScript, TypeScript
- **Theme**: Light/Dark mode with system preference detection
- **Event Tracking**: 24 event types including keystrokes, cursor, paste/drop, window, focus, visibility
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

## Key Concepts

### Event Recording Flow

```
User Action
    ↓
InputDetector (paste/drop detection)
    ↓
OperationDetector (Monaco change events → operation type)
    ↓
KeystrokeTracker / MouseTracker / etc.
    ↓
EventRecorder (event queuing, fire-and-forget)
    ↓
TypingProof.recordEvent() (@typedcode/shared)
    ↓
HashChainManager → PoswManager (Web Worker)
    ↓
StoredEvent → localStorage + IndexedDB
```

### Fire-and-Forget Recording

Events are recorded asynchronously without blocking the UI:

1. `record(event)` returns immediately
2. PoSW computation runs in Web Worker (10,000 iterations)
3. UI shows `queuedEventCount` for pending PoSW
4. Events are incrementally saved to IndexedDB

This ensures typing responsiveness even with cryptographic overhead.

### Internal Paste Detection

TypedCode distinguishes between external paste (Ctrl+V from outside) and internal paste (copy/paste within the same session):

1. When content is generated (typed), it's registered in `SessionContentRegistry`
2. On paste event, the pasted text is compared against registered content
3. Match → `insertFromInternalPaste` (allowed, doesn't break pure typing)
4. No match → `insertFromPaste` (blocked, marks as external input)

This allows users to copy/paste their own typed code without penalty.

### Session Recovery

When the browser is refreshed or closed unexpectedly:

1. Events are saved incrementally to IndexedDB
2. On reload, `sessionResumed` event is recorded
3. The hash chain continues from the last saved state
4. Pending PoSW computations are resumed

### Template Injection

When a template is loaded (e.g., starter code for an exam):

1. `templateInjection` event is recorded
2. The injected content is tracked separately from typed content
3. Pure typing status accounts for template vs user-typed content

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
