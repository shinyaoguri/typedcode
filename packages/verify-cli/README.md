# @typedcode/verify-cli

Command-line tool for verifying TypedCode typing proof files.

## Installation

### Global Install

```bash
npm install -g @typedcode/verify-cli
```

### npx (no install)

```bash
npx typedcode-verify <proof-file>
```

## Usage

```bash
# Verify a single JSON file
typedcode-verify proof.json

# Verify a ZIP file with screenshots
typedcode-verify proof.zip

# Verify multiple files
typedcode-verify file1.json file2.zip
```

## Output

```
Verifying: proof.json

Result: VERIFIED

Summary:
  Total Events: 1,234
  Pure Typing: Yes
  Duration: 45m 30s
  Typing Speed: 45.2 WPM (avg)

Chain Verification:
  Sequence: OK
  Timestamps: OK
  Hash Chain: OK
  PoSW: OK (1,234/1,234)

Attestation:
  Human Verified: Yes
  Timestamp: 2026-01-05T10:30:00Z
```

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Verification passed |
| 1 | Verification failed or error |

## Supported Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| Single File | `.json` | Single proof file |
| Multi-File | `.json` | Multiple files in one proof |
| ZIP | `.zip` | Proof with screenshots |

## Verification Process

1. **File Parsing**: Read and parse JSON/ZIP
2. **Format Detection**: Detect single-file or multi-file format
3. **Chain Verification**:
   - Sequence number continuity
   - Timestamp monotonicity
   - Previous hash validation
   - Hash recalculation
4. **PoSW Verification**: Validate 10,000 iteration proofs
5. **Attestation Check**: Verify human attestation if present

## Build

```bash
npm run build      # Build CLI
npm run dev        # Watch mode
```

## Architecture

```
src/
├── cli.ts         # CLI entry point
├── verify.ts      # Verification logic
├── output.ts      # Result formatting
├── progress.ts    # Progress display
└── zip.ts         # ZIP file handling
```

## Requirements

- Node.js >= 22.0.0

## Dependencies

| Package | Purpose |
|---------|---------|
| @typedcode/shared | Core types and verification (includes ZIP handling) |
