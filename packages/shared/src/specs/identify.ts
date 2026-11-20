/**
 * 入力から検証器を 1 つだけ選ぶ (#809 / ADR-0053 §2)。
 *
 * 選び方は**静的な registry への完全一致だけ**。大小比較や「同じ major だから」で対応済みにしない。
 * 1.0.0・1.1.0 は現行の `verifyProofFile` (`classifyProofVersion`) なら受理するが、当時の出力を固定した
 * ファイルが無く、元の規則で検証できていると確かめられないので、ここでは `unsupported` を返す
 * (2026-11-20 メンテナ決定)。公式 Web / CLI はまだ `verifyProofFile` を使っており、切り替えは #811。
 */

import { parseVersionStrict } from '../version.js';
import { verifyEventArrayStructure } from '../verification.js';
import type { SpecDeclaredIdentifier, SpecId, SpecSupport } from './types.js';

/** legacy の `version` → 仕様。キーは `MAJOR.MINOR.PATCH` の完全一致 */
const LEGACY_PROOF_SPECS: ReadonlyMap<string, SpecId> = new Map([['1.2.0', 'legacy-typing-proof@1.2.0']]);

/**
 * 新形式 (`kind` + 整数 `specVersion`。#810) → 仕様。キーは `${kind}@${specVersion}`。
 * いまは登録が無いので、新形式の識別子を持つ入力は形が正しくても `unsupported` になる。
 */
const KIND_SPECS: ReadonlyMap<string, SpecId> = new Map();

/** 結果に載せてよい `kind` の文字種 (不変条件 11。生の文字列を載せない) */
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 新形式の `specVersion` として受ける値 (1 以上の安全な整数) */
function isSpecVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 新形式の識別子 (`kind` / `specVersion` のどちらかのキーを持つ入力) を識別する */
function identifyKind(input: Record<string, unknown>): SpecSupport {
  const { kind, specVersion } = input;
  const declared: SpecDeclaredIdentifier = {};
  if (typeof kind === 'string' && KIND_PATTERN.test(kind)) declared.kind = kind;
  if (isSpecVersion(specVersion)) declared.specVersion = specVersion;

  if (declared.kind === undefined || declared.specVersion === undefined) {
    return { status: 'malformed', declared, code: 'kind-malformed' };
  }
  const spec = KIND_SPECS.get(`${declared.kind}@${declared.specVersion}`);
  return spec
    ? { status: 'supported', spec, declared }
    : { status: 'unsupported', declared, code: 'kind-not-registered' };
}

/** `undefined` / `null` か、object であること */
function isAbsentOrObject(value: unknown): boolean {
  return value === undefined || value === null || isPlainObject(value);
}

/**
 * legacy 1.2.0 の検証器 (`verifyProofFile`) に渡せる構造か。中身の正しさ (ハッシュ・署名) は見ない。
 *
 * 見るのは、既存の検証器が欠けていると `Typing proof metadata is missing` などで落とす値と、
 * 型が違うと検証の途中で例外になる値:
 * - `typingProofHash` (文字列)・`typingProofData` (object、`metadata` も object)・`content` (文字列)
 * - `proof.events` (`verifyEventArrayStructure`。#221)
 * - `checkpoints` (配列、要素は object、`signature` があれば `payload` を持つ object)
 * - `sessionStartToken` (あれば `payload` を持つ object)・`exam`・`fingerprint` (あれば object)
 */
export function isLegacyTypingProofStructure(input: Record<string, unknown>): boolean {
  if (typeof input.typingProofHash !== 'string') return false;
  const data = input.typingProofData;
  if (!isPlainObject(data) || !isPlainObject(data.metadata)) return false;
  if (typeof input.content !== 'string') return false;
  const proof = input.proof;
  if (!isPlainObject(proof) || !verifyEventArrayStructure(proof.events).valid) return false;

  const checkpoints = input.checkpoints;
  if (checkpoints !== undefined) {
    if (!Array.isArray(checkpoints)) return false;
    for (const cp of checkpoints) {
      if (!isPlainObject(cp)) return false;
      const signature = cp.signature;
      if (!isAbsentOrObject(signature)) return false;
      if (isPlainObject(signature) && !isPlainObject(signature.payload)) return false;
    }
  }

  const token = input.sessionStartToken;
  if (!isAbsentOrObject(token)) return false;
  if (isPlainObject(token) && !isPlainObject(token.payload)) return false;

  return isAbsentOrObject(input.exam) && isAbsentOrObject(input.fingerprint);
}

/**
 * 入力を識別する。返す `support` は結果にそのまま載る。
 *
 * - object でない → `malformed`
 * - `kind` か `specVersion` のキーを持つ → 新形式の識別子として扱う (`version` と同居していても legacy へ落とさない)
 * - `version` が無い・`MAJOR.MINOR.PATCH` でない → `malformed`
 * - `version` が registry にある (いまは `1.2.0` だけ) → 構造が合えば `supported`、合わなければ `malformed`
 * - それ以外の正しい形の版 → `unsupported`
 */
export function identifyProofSpec(input: unknown): SpecSupport {
  if (!isPlainObject(input)) {
    return { status: 'malformed', code: 'not-an-object' };
  }
  if (Object.hasOwn(input, 'kind') || Object.hasOwn(input, 'specVersion')) {
    return identifyKind(input);
  }
  if (!Object.hasOwn(input, 'version')) {
    return { status: 'malformed', code: 'version-missing' };
  }
  const parsed = parseVersionStrict(input.version);
  if (!parsed) {
    return { status: 'malformed', code: 'version-malformed' };
  }
  // 結果に載せるのは parse できた数字から組み直した値だけ (入力の文字列そのものは載せない)
  const declared: SpecDeclaredIdentifier = { version: `${parsed.major}.${parsed.minor}.${parsed.patch}` };
  const spec = LEGACY_PROOF_SPECS.get(declared.version as string);
  if (!spec) {
    return { status: 'unsupported', declared, code: 'version-not-registered' };
  }
  if (!isLegacyTypingProofStructure(input)) {
    return { status: 'malformed', declared, code: 'structure-invalid' };
  }
  return { status: 'supported', spec, declared };
}
