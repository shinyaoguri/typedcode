/**
 * Supported Languages Configuration
 * アプリケーション全体で使用する言語定義を一元管理
 */

/** 言語ID */
export type LanguageId =
  | 'c'
  | 'cpp'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'html'
  | 'css'
  | 'plaintext';

/** 言語定義 */
export interface LanguageDefinition {
  /** 言語ID (Monaco/内部で使用) */
  id: LanguageId;
  /** 表示名 */
  displayName: string;
  /** ファイル拡張子 (ドットなし) */
  fileExtension: string;
  /** コード実行が可能か */
  executable: boolean;
  /** ランタイム表示名 (実行可能な言語のみ) */
  runtimeName?: string;
  /** SVGアイコンが存在するか */
  hasSvgIcon: boolean;
}

/**
 * サポートされている全言語の定義
 * UIでの表示順序もこの配列の順序に従う
 */
export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: 'c',
    displayName: 'C',
    fileExtension: 'c',
    executable: true,
    runtimeName: 'Clang',
    hasSvgIcon: true,
  },
  {
    id: 'cpp',
    displayName: 'C++',
    fileExtension: 'cpp',
    executable: true,
    runtimeName: 'Clang',
    hasSvgIcon: true,
  },
  {
    id: 'javascript',
    displayName: 'JavaScript',
    fileExtension: 'js',
    executable: true,
    runtimeName: 'Browser JS',
    hasSvgIcon: true,
  },
  {
    id: 'typescript',
    displayName: 'TypeScript',
    fileExtension: 'ts',
    executable: true,
    runtimeName: 'TS Compiler',
    hasSvgIcon: true,
  },
  {
    id: 'python',
    displayName: 'Python',
    fileExtension: 'py',
    executable: true,
    runtimeName: 'Pyodide',
    hasSvgIcon: true,
  },
  {
    id: 'html',
    displayName: 'HTML',
    fileExtension: 'html',
    executable: false,
    hasSvgIcon: true,
  },
  {
    id: 'css',
    displayName: 'CSS',
    fileExtension: 'css',
    executable: false,
    hasSvgIcon: true,
  },
  {
    id: 'plaintext',
    displayName: 'Plain Text',
    fileExtension: 'txt',
    executable: false,
    hasSvgIcon: false,
  },
] as const;

/** 言語IDから定義を取得 */
export function getLanguageDefinition(id: string): LanguageDefinition | undefined {
  return SUPPORTED_LANGUAGES.find((lang) => lang.id === id);
}

/** 実行可能な言語のみを取得 */
export function getExecutableLanguages(): LanguageDefinition[] {
  return SUPPORTED_LANGUAGES.filter((lang) => lang.executable);
}

/** 全言語IDのリスト */
export function getAllLanguageIds(): LanguageId[] {
  return SUPPORTED_LANGUAGES.map((lang) => lang.id);
}

/** ファイル拡張子から言語IDを取得 */
export function getLanguageIdByExtension(extension: string): LanguageId | undefined {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  return SUPPORTED_LANGUAGES.find((lang) => lang.fileExtension === ext)?.id;
}

/** ファイル拡張子マッピング (後方互換性のため) */
export const FILE_EXTENSIONS: Record<string, string> = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((lang) => [lang.id, lang.fileExtension])
);

/** 指定した言語がコード実行可能かどうかを判定 */
export function isLanguageExecutable(id: string): boolean {
  const lang = getLanguageDefinition(id);
  return lang?.executable ?? false;
}
