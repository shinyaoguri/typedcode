# @typedcode/verify

Web-based proof verification page for TypedCode exported files.

## Features

- **File upload**: Drag & drop or file selection
- **Hash chain verification**: Recalculates and verifies all SHA-256 hashes
- **PoSW verification**: Validates Proof of Sequential Work
- **Sampled verification**: Fast verification using checkpoints
- **Timeline**: Seek bar to navigate event history
- **Visualization**: Mouse trajectory and event distribution charts

## Development

```bash
npm run dev      # http://localhost:5174
npm run build
```

## Supported Formats

### Single File (JSON)
```json
{
  "version": "3.2.0",
  "typingProofHash": "...",
  "proof": { "events": [...] },
  "fingerprint": {...},
  "checkpoints": [...]
}
```

### Multi-File (ZIP)
```json
{
  "version": "3.1.0",
  "type": "multi-file",
  "files": { "main.c": {...}, "utils.h": {...} },
  "tabSwitches": [...],
  "fingerprint": {...}
}
```

## Verification Process

1. **File parsing**: JSON parse or ZIP extraction
2. **Format detection**: `isMultiFileProof()` check
3. **Hash chain verification**:
   - Sequence number check
   - Timestamp continuity check
   - Previous hash validation
   - PoSW verification
   - Hash recalculation

## Verification Errors

| Error | Description |
|-------|-------------|
| Sequence mismatch | Event order inconsistency |
| Timestamp violation | Timestamp going backwards |
| Previous hash mismatch | Previous hash doesn't match |
| PoSW verification failed | PoSW validation failed |
| Hash mismatch | Hash value doesn't match |

## Dependencies

- **@typedcode/shared**: Types, TypingProof
- **highlight.js**: ^11.11 - Syntax highlighting
- **jszip**: ^3.10 - ZIP handling
