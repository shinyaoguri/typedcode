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

/** バージョン文字列をパース */
export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const [major, minor, patch] = version.split('.').map(Number);
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 };
}

/** バージョン比較 (-1: a < b, 0: a == b, 1: a > b) */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

/** サポートされているバージョンかチェック */
export function isVersionSupported(version: string): boolean {
  return compareVersions(version, MIN_SUPPORTED_VERSION) >= 0;
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
