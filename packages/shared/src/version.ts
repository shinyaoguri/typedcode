/**
 * TypedCode バージョン定数
 * プロジェクト全体のバージョンを一元管理
 */

/** Proof フォーマットバージョン */
export const PROOF_FORMAT_VERSION = '1.0.0';

/** ストレージフォーマットバージョン (localStorage用、整数) */
export const STORAGE_FORMAT_VERSION = 1 as const;

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
