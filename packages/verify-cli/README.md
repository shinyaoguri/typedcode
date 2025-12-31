# @typedcode/verify-cli

CLI tool for verifying TypedCode typing proof files.

## Usage

```bash
npx typedcode-verify <proof-file>
```

Or install globally:
```bash
npm install -g @typedcode/verify-cli
typedcode-verify proof.json
```

## Supported Formats

- Single file: `.json`
- Multi-file: `.zip`

## Build

```bash
npm run build
npm run dev  # Watch mode
```

## Requirements

- Node.js >= 22.0.0

## Dependencies

- **@typedcode/shared**: Types, TypingProof
- **jszip**: ZIP handling
