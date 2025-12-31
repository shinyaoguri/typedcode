# @typedcode/editor

Main editor application - Monaco Editor-based sequential typing proof editor.

## Features

- **Multi-tab editing**: Independent proof chain per tab
- **Language support**: C, C++, Python, JavaScript, TypeScript
- **Theme**: Light/Dark mode
- **Event tracking**: Keystrokes, cursor movement, paste/drop detection, window events
- **PoSW**: Proof of Sequential Work (10,000 sequential hashes per event)
- **Export**: JSON (single file) or ZIP (multiple files)

## In-Browser Code Execution

| Language | Runtime |
|----------|---------|
| C | Wasmer SDK + Clang (WASM) |
| C++ | Wasmer SDK + Clang++ (WASM) |
| Python | Pyodide (CPython 3.11) |
| JavaScript | Native browser |
| TypeScript | SWC transpile → eval |

## Development

```bash
npm run dev      # http://localhost:5173
npm run build
npm run preview
```

## Architecture

```
src/
├── main.ts                 # Entry point
├── core/
│   ├── EventRecorder.ts    # Central event dispatcher
│   └── RuntimeManager.ts   # Language runtime state
├── editor/
│   ├── EditorController.ts # Monaco change tracking
│   ├── CursorTracker.ts    # Cursor/selection events
│   └── ThemeManager.ts     # Theme switching
├── tracking/
│   ├── OperationDetector.ts   # Operation type detection
│   ├── InputDetector.ts       # Paste/drop detection
│   ├── KeystrokeTracker.ts    # Keyboard events
│   ├── MouseTracker.ts        # Mouse position tracking
│   ├── WindowTracker.ts       # Window events
│   └── VisibilityTracker.ts   # Tab visibility
├── executors/              # Language executors (C, C++, Python, JS, TS)
├── terminal/
│   └── CTerminal.ts        # xterm.js wrapper
├── ui/                     # UI components (tabs, logs, modals)
├── export/
│   └── ProofExporter.ts    # Proof export
└── services/               # Turnstile, Storage, Download
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_TURNSTILE_SITE_KEY` | Turnstile site key (optional) |
| `VITE_API_URL` | Workers API endpoint |

## Dependencies

- **monaco-editor**: ^0.55 - Editor engine
- **@xterm/xterm**: ^6.0 - Terminal emulator
- **@wasmer/sdk**: WASM runtime
- **jszip**: ^3.10 - ZIP export
- **vite**: ^7.3 - Build tool
