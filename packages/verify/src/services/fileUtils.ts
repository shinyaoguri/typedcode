/**
 * fileUtils - ファイル処理ユーティリティ
 *
 * ファイル判定・言語推測などの共通ユーティリティ
 */

/**
 * ファイル拡張子からファイルタイプを判定
 */
export function getFileType(filename: string): 'json' | 'zip' | 'unknown' {
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.zip')) return 'zip';
  return 'unknown';
}

/**
 * 証明ファイルのファイル名パターンにマッチするか
 * （任意のJSONファイルを許可）
 */
export function isProofFilename(filename: string): boolean {
  return filename.endsWith('.json');
}

/**
 * 画像ファイルかどうかを判定
 */
export function isImageFile(filename: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return imageExtensions.includes(ext);
}

/**
 * バイナリファイルかどうかを判定（画像を除く）
 */
export function isBinaryFile(filename: string): boolean {
  // 画像ファイルは別途処理するので除外
  if (isImageFile(filename)) return false;

  const binaryExtensions = [
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.ico',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.wasm', '.o', '.a', '.lib',
  ];
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return binaryExtensions.includes(ext);
}

/**
 * ファイル拡張子から言語を推測
 */
export function getLanguageFromExtension(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const languageMap: Record<string, string> = {
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.cs': 'csharp',
    '.php': 'php',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.md': 'markdown',
    '.json': 'json',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.sql': 'sql',
    '.txt': 'plaintext',
  };
  return languageMap[ext] || 'plaintext';
}
