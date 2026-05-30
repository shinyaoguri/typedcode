# Implementation Plan: Hybrid Checkpoint Trigger

Status: APPROVED, READY TO IMPLEMENT
Author: prior session (memory-reset hand-off)
Branch policy: implement on whichever branch is current; no new branch required.

---

## 1. Why this exists (read first)

### Current behaviour
`CheckpointManager` creates a checkpoint every **33 events** (a fixed
modulo trigger). See [packages/shared/src/typingProof/CheckpointManager.ts](../../packages/shared/src/typingProof/CheckpointManager.ts):

```ts
static readonly CHECKPOINT_INTERVAL = 33;
shouldCreateCheckpoint(eventIndex: number): boolean {
  return (eventIndex + 1) % CheckpointManager.CHECKPOINT_INTERVAL === 0;
}
```

Each checkpoint triggers one `POST /api/checkpoint/sign` on the Worker,
which performs a KV read + KV write per session.

### Operational problem
- Fast typists generate ~24 events/sec → cp every ~1.4 sec → **~0.7 sign req/sec/user**
- Cloudflare KV sustained-write limit per key: ~1 write/sec
- 100-user × 1-hour exam scenario: ~91k cps total, ~200 req/sec peak
- Proof file size: ~2 MB/user

### Security analysis (justifies looser interval)
The cp frequency only affects **"event-timing forgery within one inter-cp
window"** — a non-meaningful attack. The real security mechanisms
(hash chain integrity, `serverTimestamp` anchoring, post-hoc temporal
ratio, content/chain hash binding) do **not** depend on cp density.

### Goal
Switch to a **hybrid trigger**: create a checkpoint when **either**
- N events have accumulated since the last checkpoint, OR
- T milliseconds have elapsed since the last checkpoint (evaluated only on `recordEvent`, never via a wall-clock timer — see §4 "edge cases")

Defaults: **N = 100 events**, **T = 10 000 ms** (10 s).

Effect: ~1/3 the cp count, max unanchored window bounded at 10 s (better
than current "depends on typing speed"), security guarantees unchanged.

---

## 2. Goal & non-goals

### In scope
- Replace `shouldCreateCheckpoint`'s pure modulo with a stateful hybrid
  evaluator inside `CheckpointManager`
- Make N and T configurable via constructor options (with sensible defaults)
- Make `Date.now` injectable for tests
- Update `cleanupForExport` so it no longer assumes a fixed modulo
- Add focused tests for the new trigger behaviour
- Update docs (`shared/README.md`, `docs/system-spec.md`)

### Out of scope
- Worker deployment / `wrangler deploy` (manual op step)
- Editor IndexedDB schema migration (no schema change needed)
- Verifier algorithm changes (verifier already makes zero assumptions
  about cp interval — confirmed by grep)
- Per-user runtime tuning UI (constants live in shared; can be wired
  to env later if needed)
- Removing `CheckpointManager.CHECKPOINT_INTERVAL` (keep it as a deprecated
  legacy export so external code that may depend on the symbol does not
  break compilation; mark `@deprecated` in JSDoc — see Step 1.5)

---

## 3. Impact map (verified via grep on prior session)

### Files that MUST change

| File | Reason |
|---|---|
| `packages/shared/src/typingProof/CheckpointManager.ts` | Core change |
| `packages/shared/src/__tests__/typingProof.test.ts` OR new test file | New trigger tests |
| `packages/shared/README.md` | Doc snippet refers to `CHECKPOINT_INTERVAL = 33` |
| `docs/system-spec.md` | §4.5 "Checkpoint" + parameter table (§ near line 552) reference the value |

### Files that DO NOT need changes (verified)

| File / area | Why safe |
|---|---|
| `packages/shared/src/typingProof/TypingProof.ts` | Calls `shouldCreateCheckpoint(eventIndex)` and `cleanupForExport()` only. New signatures stay compatible. |
| `packages/editor/src/services/SignedCheckpointService.ts` | Consumes cps via `onCheckpointCreated` hook; opaque to interval |
| `packages/verify/**` | No interval assumption (grep returned nothing for `CHECKPOINT_INTERVAL` outside dist) |
| `packages/verify-cli/**` | Same |
| `packages/workers/**` | Per-request, no interval awareness |
| IndexedDB storage (SessionStorageService, TabManager) | Stores checkpoints by `eventIndex`; no modulo assumption |
| `signedCheckpointFixtures.ts` | Manually constructs cps; not bound by `shouldCreateCheckpoint` |
| Existing tests | None create ≥33 events; verified via `buildSmallProof(N)` callers (max N=4) |

### Direct references to remove or rewrite

`grep -rn CHECKPOINT_INTERVAL packages docs | grep -v "/dist/\|/.wrangler/\|node_modules"` returns exactly:

```
packages/shared/README.md:255                          (doc)
packages/shared/src/typingProof/CheckpointManager.ts:13  (definition)
packages/shared/src/typingProof/CheckpointManager.ts:115 (shouldCreateCheckpoint)
packages/shared/src/typingProof/CheckpointManager.ts:124 (cleanupForExport)
docs/system-spec.md:193                                (doc text)
docs/system-spec.md:552                                (param table)
```

Two non-trivial in-file uses (lines 115 and 124) — both inside
`CheckpointManager.ts`. Plan covers both.

---

## 4. Design decisions (with rationale)

### Trigger is event-driven only

`shouldCreateCheckpoint` is evaluated **only inside `TypingProof.recordEvent`**.
A wall-clock `setInterval` is **deliberately avoided** so that:
- Idle sessions produce zero work
- No background timer to manage / dispose / restore on reload
- Coverage is preserved (a long idle session still has a cp at the last
  event, since `exportProof` forces a final cp)

### Stateful evaluator inside CheckpointManager

`shouldCreateCheckpoint` now needs to know "how long since last cp" and
"how many events since last cp", so it becomes stateful. New private fields:

```ts
private lastCheckpointEventIndex = -1;
private lastCheckpointAt: number | null = null;  // ms epoch; null = never created
```

The pure-function nature is lost, but the new API is still simple:

```ts
shouldCreateCheckpoint(eventIndex: number): boolean
```

(same signature, no caller-side changes required).

### Configurable via constructor options

```ts
export interface CheckpointManagerOptions {
  /** N: number of events that triggers a checkpoint */
  maxEventsPerCheckpoint?: number;     // default: 100
  /** T (ms): max elapsed time before a checkpoint */
  maxIntervalMs?: number;              // default: 10_000
  /** clock source (for tests) */
  now?: () => number;                  // default: Date.now
}

constructor(hashChainManager: HashChainManager, options: CheckpointManagerOptions = {}) {
  this.hashChainManager = hashChainManager;
  this.maxEventsPerCheckpoint = options.maxEventsPerCheckpoint ?? DEFAULT_MAX_EVENTS_PER_CHECKPOINT;
  this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_CHECKPOINT_INTERVAL_MS;
  this.now = options.now ?? Date.now;
}
```

`TypingProof`'s constructor stays no-arg (no API churn). Defaults match
the production recommendation.

### Trigger condition (exact)

Evaluated on each call:

```ts
shouldCreateCheckpoint(eventIndex: number): boolean {
  // First-ever cp: fire as soon as we hit maxEventsPerCheckpoint events
  // (NOT on first event, to avoid an immediate cp at index 0).
  const eventsSinceLast =
    this.lastCheckpointEventIndex < 0
      ? eventIndex + 1
      : eventIndex - this.lastCheckpointEventIndex;
  if (eventsSinceLast >= this.maxEventsPerCheckpoint) return true;

  // Time trigger only fires after we've already created at least one cp.
  // (Before the first cp, `lastCheckpointAt` is null and there's no
  //  meaningful "elapsed since last anchor" to compare against.)
  if (this.lastCheckpointAt !== null) {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastCheckpointAt); // clock-skew clamp
    if (elapsed >= this.maxIntervalMs) return true;
  }
  return false;
}
```

`createCheckpoint` is responsible for updating both state fields after a
cp is appended:

```ts
this.lastCheckpointEventIndex = eventIndex;
this.lastCheckpointAt = this.now();
```

`setCheckpoints` and `clearCheckpoints` must also reset / rebuild state
so restore paths stay consistent. See Step 1.3.

### `cleanupForExport` redesign

The current filter `(cp.eventIndex + 1) % 33 === 0` cannot exist under a
dynamic interval. The original intent (judging from the only caller at
`TypingProof.ts:504`) is **"drop checkpoints that should not be in the
exported proof"** — i.e., a defensive sweep before forcing the final cp.

New behaviour: **drop duplicates only**. The new `shouldCreateCheckpoint`
+ `createCheckpoint` flow produces well-formed unique cps by construction;
the only thing that could go wrong is double-registration via legacy
restore paths. Keep that defensive sweep:

```ts
cleanupForExport(): void {
  // Defensive: drop any duplicate-eventIndex entries (last wins).
  const byIndex = new Map<number, CheckpointData>();
  for (const cp of this.checkpoints) byIndex.set(cp.eventIndex, cp);
  this.checkpoints = [...byIndex.values()].sort((a, b) => a.eventIndex - b.eventIndex);
}
```

This preserves the call site in `TypingProof.exportProof` without
changing its semantics in a way verify could detect.

### State restoration after session reload

When the editor restores from IndexedDB, it calls `setCheckpoints(...)`.
The new code must rebuild trigger state from the restored array:

```ts
setCheckpoints(checkpoints: CheckpointData[]): void {
  this.checkpoints = checkpoints;
  const last = this.checkpoints[this.checkpoints.length - 1];
  if (last) {
    this.lastCheckpointEventIndex = last.eventIndex;
    // We don't know the original wall-clock time; use "now" so the
    // first post-restore time trigger is T ms after restore, not
    // immediately. Acceptable: we lose some unanchored coverage at the
    // boundary in exchange for sane behaviour.
    this.lastCheckpointAt = this.now();
  } else {
    this.lastCheckpointEventIndex = -1;
    this.lastCheckpointAt = null;
  }
}

clearCheckpoints(): void {
  this.checkpoints = [];
  this.lastCheckpointEventIndex = -1;
  this.lastCheckpointAt = null;
}
```

### Backward compatibility

- `CheckpointManager.CHECKPOINT_INTERVAL` remains as a `static readonly`
  with the new default value (100) and a JSDoc `@deprecated` note. This
  keeps the symbol available for any external reader (the shared
  package's README explicitly documented it).
- Existing proofs (with cps at 33-boundaries) continue to verify because
  the verifier makes no assumption about interval.
- Storage format unchanged.

---

## 5. Step-by-step implementation

Follow in order. Run TSC + tests after Step 1 to catch regressions early.

### Step 1.1: New constants

Add to **the top of** `packages/shared/src/typingProof/CheckpointManager.ts`,
above the class declaration:

```ts
/** Default N: number of events that triggers a checkpoint */
export const DEFAULT_MAX_EVENTS_PER_CHECKPOINT = 100;

/** Default T (ms): max elapsed time before a checkpoint */
export const DEFAULT_MAX_CHECKPOINT_INTERVAL_MS = 10_000;
```

### Step 1.2: Options interface

Add directly after the constants:

```ts
export interface CheckpointManagerOptions {
  /** N: number of events that triggers a checkpoint */
  maxEventsPerCheckpoint?: number;
  /** T (ms): max elapsed time before a checkpoint */
  maxIntervalMs?: number;
  /** clock source (overridable for tests) */
  now?: () => number;
}
```

### Step 1.3: Class field + constructor changes

Replace the existing `static readonly CHECKPOINT_INTERVAL = 33;` and the
existing constructor with:

```ts
/**
 * @deprecated Kept for backward compatibility with consumers that
 * referenced the static value. The runtime behaviour is now driven by
 * the hybrid (events + elapsed time) trigger in shouldCreateCheckpoint.
 * Use DEFAULT_MAX_EVENTS_PER_CHECKPOINT instead.
 */
static readonly CHECKPOINT_INTERVAL = DEFAULT_MAX_EVENTS_PER_CHECKPOINT;

private readonly maxEventsPerCheckpoint: number;
private readonly maxIntervalMs: number;
private readonly now: () => number;
private lastCheckpointEventIndex = -1;
private lastCheckpointAt: number | null = null;

constructor(
  hashChainManager: HashChainManager,
  options: CheckpointManagerOptions = {}
) {
  this.hashChainManager = hashChainManager;
  this.maxEventsPerCheckpoint =
    options.maxEventsPerCheckpoint ?? DEFAULT_MAX_EVENTS_PER_CHECKPOINT;
  this.maxIntervalMs =
    options.maxIntervalMs ?? DEFAULT_MAX_CHECKPOINT_INTERVAL_MS;
  this.now = options.now ?? Date.now;
}
```

### Step 1.4: shouldCreateCheckpoint

Replace the existing body with the design from §4 "Trigger condition":

```ts
shouldCreateCheckpoint(eventIndex: number): boolean {
  const eventsSinceLast =
    this.lastCheckpointEventIndex < 0
      ? eventIndex + 1
      : eventIndex - this.lastCheckpointEventIndex;
  if (eventsSinceLast >= this.maxEventsPerCheckpoint) return true;
  if (this.lastCheckpointAt !== null) {
    const elapsed = Math.max(0, this.now() - this.lastCheckpointAt);
    if (elapsed >= this.maxIntervalMs) return true;
  }
  return false;
}
```

### Step 1.5: createCheckpoint — record trigger state

Inside `createCheckpoint`, immediately after `this.checkpoints.push(checkpoint);`, append:

```ts
this.lastCheckpointEventIndex = eventIndex;
this.lastCheckpointAt = this.now();
```

(before the `console.log(...)` is fine; keep ordering local + simple.)

### Step 1.6: cleanupForExport rewrite

Replace the body with the dedupe-only version from §4 "cleanupForExport
redesign".

### Step 1.7: setCheckpoints / clearCheckpoints sync trigger state

Update both to rebuild `lastCheckpointEventIndex` / `lastCheckpointAt`
per §4 "State restoration".

### Step 2: TypingProof — no change required

`TypingProof.constructor` keeps `new CheckpointManager(this.hashChainManager)`
(zero-arg options → defaults). The hot loop call
`this.checkpointManager.shouldCreateCheckpoint(eventIndex)` works because
the signature is unchanged.

**Confirm by running TSC after Step 1; should be 0 errors.**

### Step 3: Tests — new file

Create `packages/shared/src/__tests__/checkpointTrigger.test.ts`. Use
`vitest`. Test directly against `CheckpointManager` (no need to go
through `TypingProof` — these tests are about trigger semantics).

Required test cases:

1. **Default N trigger**:
   - Construct with `now: () => 1000` (frozen clock).
   - Call `shouldCreateCheckpoint(i)` for i=0..99; expect false for i<99.
   - At i=99, expect `true`. (eventsSinceLast = 100 → trigger.)

2. **N is configurable**:
   - Construct with `{ maxEventsPerCheckpoint: 5, now: () => 0 }`.
   - i=0..3 → false, i=4 → true.

3. **Time trigger fires after a cp + elapsed T**:
   - Construct with `{ maxEventsPerCheckpoint: 1000, maxIntervalMs: 5000 }` and
     mock clock starting at 1000.
   - Simulate a first cp by calling `createCheckpoint(0, [synthEvent(0)])`
     (you'll need a tiny event-array fixture and a HashChainManager
     stub or real instance — real instance is fine and simpler; see
     existing tests for patterns).
   - Advance the mock clock to 5999 (4999ms after cp). `shouldCreateCheckpoint(1)`
     → false (under T, under N).
   - Advance to 6001. `shouldCreateCheckpoint(1)` → true.

4. **First event never time-fires**:
   - Construct with `maxIntervalMs: 1`, clock starts at 1_000_000_000_000.
   - `shouldCreateCheckpoint(0)` → false (lastCheckpointAt is null pre-first-cp).

5. **Hybrid: whichever first wins (event-side)**:
   - `{ maxEventsPerCheckpoint: 3, maxIntervalMs: 60_000 }`.
   - i=0,1 → false. i=2 → true (event trigger wins).

6. **Hybrid: whichever first wins (time-side)**:
   - `{ maxEventsPerCheckpoint: 100, maxIntervalMs: 1000 }`.
   - Create initial cp at clock=1000. Advance clock to 2500.
     `shouldCreateCheckpoint(1)` → true.

7. **Restore via setCheckpoints rebuilds state**:
   - Set checkpoints to `[{ eventIndex: 50, ... }, { eventIndex: 99, ... }]`.
   - Verify subsequent `shouldCreateCheckpoint(100)` returns false
     (eventsSinceLast = 1, under N) and `shouldCreateCheckpoint(199)`
     returns true (eventsSinceLast = 100).

8. **clearCheckpoints resets state**:
   - After creating a cp, call `clearCheckpoints()`.
   - Verify `shouldCreateCheckpoint(0)` returns false again (no time
     fire, lastCheckpointAt should be null).

9. **cleanupForExport drops duplicates**:
   - Append two cps with the same eventIndex. Call `cleanupForExport`.
     Verify only one remains and at the right index.

10. **CHECKPOINT_INTERVAL legacy export equals new default**:
    - `expect(CheckpointManager.CHECKPOINT_INTERVAL).toBe(DEFAULT_MAX_EVENTS_PER_CHECKPOINT)`.
    - Reads guard against accidental drift between the deprecated symbol
      and the new default.

### Step 3.5: Verify existing tests still pass

Run `npm run test:run -w @typedcode/shared` after Step 3.

Expected baseline (from prior session): 147 passing + 20 pre-existing
`fingerprint.test.ts` failures (happy-dom env issue — unrelated, do
**not** attempt to fix here). After Step 3 we should see roughly
147 + new-test-count passing.

### Step 4: Documentation

#### 4.1 `packages/shared/README.md`

Find:

```
export const CHECKPOINT_INTERVAL = 33;
```

Replace with:

```
// Hybrid checkpoint trigger (whichever fires first):
export const DEFAULT_MAX_EVENTS_PER_CHECKPOINT = 100;       // N
export const DEFAULT_MAX_CHECKPOINT_INTERVAL_MS = 10_000;   // T (ms)
```

If README has a longer description paragraph about cps, update it to
reflect the hybrid trigger.

#### 4.2 `docs/system-spec.md`

In §4.5 (around line 193), replace the existing line:

```
33 イベント (`CHECKPOINT_INTERVAL = 33`) ごとに自動作成される構造。
```

with something like:

```
以下のいずれかが先に成立した時点で自動作成される構造。
- 直前 cp から **100 イベント** が経過 (`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`)
- 直前 cp から **10 秒** が経過 (`DEFAULT_MAX_CHECKPOINT_INTERVAL_MS`)

時間トリガは `recordEvent` の呼び出し時にのみ評価されるため、無入力中は
新しい cp は作られない。最終 cp は `exportProof` 時に強制発火する。
```

In the parameter table near line 552, replace the `CHECKPOINT_INTERVAL` row with:

```
| `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` | 100 | `CheckpointManager.ts` |
| `DEFAULT_MAX_CHECKPOINT_INTERVAL_MS` | 10_000 | `CheckpointManager.ts` |
```

(Keep `CHECKPOINT_INTERVAL` out of the table since it's now legacy. If
you want to be explicit: mention in a footnote that
`CheckpointManager.CHECKPOINT_INTERVAL` is preserved as a deprecated
alias of the events default.)

### Step 5: Verify

Run, in order, from repo root:

```sh
# typecheck all packages
for p in shared editor verify verify-cli workers; do
  echo "=== $p ===";
  npx tsc --noEmit -p packages/$p/tsconfig.json 2>&1 | grep -cE 'error TS'
done

# tests
npm run test:run -w @typedcode/shared 2>&1 | grep -E "Test Files|Tests "

# full build
npm run build 2>&1 | grep -E "built in|error" | head
```

Expected:
- All packages: 0 tsc errors
- shared tests: 147 + N new (where N is your new test count) passing,
  20 fingerprint failures (pre-existing, unrelated — confirmed via
  `git stash` reproduction in prior session)
- full build: `exit 0`, "built in ..." for editor + verify

### Step 6: Commit

Single commit. Suggested message:

```
Switch checkpoint trigger to hybrid (events OR elapsed time)

CheckpointManager previously created a checkpoint every 33 events. Under
heavy typing this pushed the per-session sign rate close to the
Cloudflare KV ~1-write-per-second-per-key ceiling, and left the
inter-checkpoint time window proportional to typing speed (≤2s for fast
typists, but >10s during slow input).

Replace the fixed-modulo trigger with a hybrid evaluator:
- N: max events since last checkpoint (default 100)
- T: max elapsed milliseconds since last checkpoint (default 10000)
- evaluated only on recordEvent, so idle sessions produce no work
- triggered checkpoint when EITHER threshold is reached

Both thresholds are configurable through new CheckpointManagerOptions;
defaults are exported as DEFAULT_MAX_EVENTS_PER_CHECKPOINT and
DEFAULT_MAX_CHECKPOINT_INTERVAL_MS. A clock injection (now: () => number)
is provided for deterministic testing.

cleanupForExport no longer assumes a fixed modulo; it now de-duplicates
by eventIndex, preserving its original "defensive sweep before forcing a
final cp" intent without depending on the legacy interval value.

CheckpointManager.CHECKPOINT_INTERVAL is preserved as @deprecated, set
to DEFAULT_MAX_EVENTS_PER_CHECKPOINT, so any external code that read the
symbol continues to compile and gets the new default.

Effect for the canonical 100-user × 1-hour exam scenario: ~1/3 the
checkpoint count, ~1/3 the per-user proof size, max unanchored window
upper-bounded at 10 s. Cryptographic guarantees (chain integrity,
serverTimestamp anchoring, post-hoc temporal ratio, content/chain hash
binding) are unchanged — cp density was never the load-bearing security
mechanism.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## 6. Acceptance criteria

- [ ] `packages/shared/src/typingProof/CheckpointManager.ts` updated per Step 1
- [ ] No changes to `TypingProof.ts` (sanity-confirm by `git diff packages/shared/src/typingProof/TypingProof.ts` → empty)
- [ ] New test file `packages/shared/src/__tests__/checkpointTrigger.test.ts` exists with the 10 test cases from Step 3
- [ ] All 10 new tests pass
- [ ] Existing `signedCheckpoints` test suite still passes (53 cases per prior session)
- [ ] Existing `typingProof` test suite still passes (70 cases per prior session)
- [ ] `tsc --noEmit` is 0 errors across all 5 packages
- [ ] `npm run build` succeeds (exit 0)
- [ ] `shared/README.md` and `docs/system-spec.md` updated per Step 4
- [ ] Single git commit with the message in Step 6
- [ ] `git status` is clean after commit

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A consumer outside the grep'd paths references `CHECKPOINT_INTERVAL` | Low | Symbol preserved as deprecated alias. Compilation breaks if missing → tsc step catches. |
| Tests rely on the 33 modulo implicitly | Very low | Grep confirmed no test creates ≥33 events. Existing tests should be unaffected. |
| Clock injection makes constructor noisier for production callers | Low | Options is optional; default arg `= {}` keeps zero-arg construction working. `TypingProof` does not change. |
| `cleanupForExport` losing the "drop INTERVAL-misaligned" sweep masks a real bug | Very low | Only one caller (`TypingProof.exportProof`). Default code path always produces well-formed cps. Dedupe is a safer superset of the prior intent. |
| Time-trigger fires on first `recordEvent` after long idle and surprises tests | Mitigated | Trigger condition explicitly requires `lastCheckpointAt !== null`. Tested by Step-3 case 4. |
| `Date.now()` going backward (system clock adjustment) | Low | `Math.max(0, now - lastAt)` clamp in `shouldCreateCheckpoint`. |
| Restore path leaves trigger state mismatched | Mitigated | `setCheckpoints` rebuilds state from the restored array; Step-3 case 7 covers this. |

---

## 8. Things deliberately NOT done (and why)

- **No `setInterval`-based wakeup** — adds resource management cost and
  fires cps during idle time for no security benefit. Coverage is
  preserved by the forced-final-cp at export.
- **No env-var or build-time config of N/T** — defaults at the class are
  enough for now. Adding a config layer can come later if needed
  (`VITE_CHECKPOINT_N`, etc.) without changing the API.
- **No proof format version bump** — the cp data structure is unchanged;
  only the schedule is different. Old proofs and new proofs are
  interoperable.
- **No Worker change** — server is stateless w.r.t. cp density, and the
  recent idempotency work already absorbs duplicate requests.
- **No verify-side change** — verify makes no interval assumption; the
  signed-checkpoint linked-list chain works regardless of density.

---

## 9. After implementation: what to communicate to the user

A summary covering:
1. Files changed and the commit hash.
2. Test count delta (e.g., "147 → 147 + 10 new = 157 passing").
3. Confirmation that the 20 pre-existing fingerprint failures are still
   present and unrelated (do not present as a regression).
4. Concrete numbers from §1 for the new defaults so the user can sanity-check.
5. Note that **Pages re-deploy via GitHub Actions** is needed for the
   change to take effect on the preview / production URL. Worker
   re-deploy is **not** required (server side unchanged).
