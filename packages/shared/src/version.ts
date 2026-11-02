/**
 * TypedCode バージョン定数
 * プロジェクト全体のバージョンを一元管理
 */

/**
 * Proof フォーマットバージョン
 *
 * 1.1.0: 試験モード (ADR-0006) の root 束縛を追加。casual proof の構造は不変 (加算的) だが、
 * exam proof は root 式が異なる (`proof.exam` の有無で検証器が分岐)。旧検証器は exam proof の
 * root 不一致で fail-closed = 正しい挙動。`MIN_SUPPORTED_VERSION` は 1.0.0 据え置き。
 *
 * 1.2.0: セッション開始 ECDSA トークン (ADR-0017) を追加。casual/class の root を
 * `SHA256(fp ‖ localNonce ‖ serverNonce)` でサーバアンカーし、proof に `sessionStartToken` と
 * `rootAnchored` を加算する。トークン非同梱 (旧 proof / オフライン劣化) は `rootAnchored:false` で
 * 受理 = 後方互換。`MIN_SUPPORTED_VERSION` は 1.0.0 据え置き。exam root 式は不変。
 */
export const PROOF_FORMAT_VERSION = '1.2.0';

/** 試験問題パッケージ (`*.tcexam`) フォーマットバージョン (ADR-0006) */
export const EXAM_PACKAGE_FORMAT_VERSION = 1 as const;

/** proof の `exam` ブロックのバージョン (ADR-0006) */
export const EXAM_PROOF_VERSION = 1 as const;

/** チェーン根束縛の方式バージョン (ADR-0006)。root = SHA256(fp ‖ nonce ‖ packageHash ‖ startToken) */
export const EXAM_ROOT_BINDING = 'v1' as const;

/**
 * N問バンドル (ADR-0012 B-2) の root 束縛バージョン。
 * root = SHA256(fp ‖ nonce ‖ packageHash ‖ startToken ‖ problemContentHash)。
 * v1 の末尾に per-problem ハッシュを連結し、各タブを「この封印の・この問題」に束縛する。
 */
export const EXAM_ROOT_BINDING_V2 = 'v2' as const;

/** ストレージフォーマットバージョン (localStorage用、整数) */
export const STORAGE_FORMAT_VERSION = 1 as const;

/** Proof of Sequential Work の必須反復回数 */
export const POSW_ITERATIONS = 10000;

/** Signed checkpoint payload フォーマットバージョン */
export const SIGNED_CHECKPOINT_FORMAT_VERSION = 1 as const;

/** セッション開始トークン (ADR-0017) の payload フォーマットバージョン */
export const SESSION_TOKEN_FORMAT_VERSION = 1 as const;

/** 最小サポートバージョン */
export const MIN_SUPPORTED_VERSION = '1.0.0';

/**
 * バージョン文字列を**ゆるく**パースする (不正な部分は NaN / 0 になる)。
 *
 * 検証の入口のゲートには使わないこと。`Number('abc')` = NaN を素通しするので、`'abc'` や
 * `'1.2.0-beta'` を判定できない。ゲートは `parseVersionStrict` / `classifyProofVersion` を使う (#223)。
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const [major, minor, patch] = version.split('.').map(Number);
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 };
}

/** `MAJOR.MINOR.PATCH` (各成分は先頭ゼロなしの 10 進数 9 桁まで)。pre-release / build metadata は受け付けない */
const STRICT_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * バージョン文字列を厳密にパースする。`MAJOR.MINOR.PATCH` 以外 (`'abc'` / `'1'` / `'1.2.0-beta'` /
 * 空文字 / 文字列以外) は `null`。proof の自己申告 `version` はこの関数を通してから使う (#223)。
 */
export function parseVersionStrict(version: unknown): ParsedVersion | null {
  if (typeof version !== 'string') return null;
  const m = STRICT_VERSION_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** バージョン比較 (-1: a < b, 0: a == b, 1: a > b)。ゆるいパースなのでゲートには使わない (`classifyProofVersion` を使う) */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return compareParsed(parseVersion(a), parseVersion(b));
}

/**
 * サポートされているバージョンかチェックする (`MIN_SUPPORTED_VERSION` 以上の正しい形式)。
 * `MAJOR.MINOR.PATCH` でない文字列は false。
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersionStrict(version);
  const min = parseVersionStrict(MIN_SUPPORTED_VERSION);
  return parsed !== null && min !== null && compareParsed(parsed, min) >= 0;
}

/**
 * proof の `version` を検証器から見て分類した結果 (#223)。
 *
 * - `current`: `PROOF_FORMAT_VERSION` と同じ
 * - `supported`: `MIN_SUPPORTED_VERSION` 以上で、この検証器が知る major の範囲内 (旧 minor も、
 *   同じ major の新しい minor も含む。minor / patch の増加は加算的変更という約束 — `PROOF_FORMAT_VERSION` 参照)
 * - `newer`: この検証器が知る major を超える。意味が変わったフィールドを旧規則で読む恐れがあるので
 *   **warning** として表示層へ渡す (reject はしない。`valid` は他の検査で決まる)
 * - `tooOld`: `MIN_SUPPORTED_VERSION` 未満 → reject
 * - `malformed`: 欠落・文字列でない・`MAJOR.MINOR.PATCH` 以外 → reject
 */
export type ProofVersionStatus = 'current' | 'supported' | 'newer' | 'tooOld' | 'malformed';

/** proof の `version` を分類する。`reject` が必要かどうかは `isProofVersionRejected` */
export function classifyProofVersion(version: unknown): ProofVersionStatus {
  const parsed = parseVersionStrict(version);
  const min = parseVersionStrict(MIN_SUPPORTED_VERSION);
  const current = parseVersionStrict(PROOF_FORMAT_VERSION);
  if (!parsed || !min || !current) return 'malformed';
  if (compareParsed(parsed, min) < 0) return 'tooOld';
  if (parsed.major > current.major) return 'newer';
  return compareParsed(parsed, current) === 0 ? 'current' : 'supported';
}

/** 検証を不合格にすべき分類か (下限未満・不正形式) */
export function isProofVersionRejected(status: ProofVersionStatus): boolean {
  return status === 'tooOld' || status === 'malformed';
}

/**
 * 不合格の `errorMessage`。`version` は攻撃者が書ける自己申告値なので、不正形式のときは値を**埋め込まない**
 * (表示層が stdout / DOM に補間する — AGENTS.md 不変条件 11)。下限未満は正規にパースできた数字だけを出す。
 */
export function proofVersionRejectionMessage(status: ProofVersionStatus, version: unknown): string | undefined {
  if (status === 'malformed') {
    return `Proof version is missing or not in MAJOR.MINOR.PATCH form (this verifier supports ${MIN_SUPPORTED_VERSION} or later)`;
  }
  if (status === 'tooOld') {
    const p = parseVersionStrict(version);
    const shown = p ? `${p.major}.${p.minor}.${p.patch}` : 'unknown';
    return `Proof version ${shown} is older than the minimum supported version ${MIN_SUPPORTED_VERSION}`;
  }
  return undefined;
}

// ============================================================================
// ビルド時情報（Viteで注入される）
// ============================================================================

/** ビルド情報の型定義 */
export interface BuildInfo {
  /** アプリバージョン (package.json) */
  appVersion: string;
  /** Gitコミットハッシュ (短縮形) */
  gitCommit: string;
  /** Gitコミット日時 */
  gitCommitDate: string;
  /** ビルド日時 */
  buildDate: string;
}

/** グローバル定義の型宣言 */
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __GIT_COMMIT_DATE__: string;
declare const __BUILD_DATE__: string;

/** ビルド情報を取得 */
export function getBuildInfo(): BuildInfo {
  return {
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    gitCommit: typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'unknown',
    gitCommitDate: typeof __GIT_COMMIT_DATE__ !== 'undefined' ? __GIT_COMMIT_DATE__ : '',
    buildDate: typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : new Date().toISOString(),
  };
}

/** GitHub リポジトリ情報 */
export const GITHUB_REPO = 'shinyaoguri/typedcode';
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
export const AUTHOR_GITHUB = 'shinyaoguri';
