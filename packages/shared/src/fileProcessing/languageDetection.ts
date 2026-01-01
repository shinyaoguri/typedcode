/**
 * Language detection utilities
 * Platform-agnostic functions for file type detection
 */

// ============================================================================
// Language detection map
// ============================================================================

/** Extension to language mapping */
const LANGUAGE_MAP: Record<string, string> = {
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

/** Binary file extensions */
const BINARY_EXTENSIONS = [
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.wasm', '.o', '.a', '.lib',
];

// ============================================================================
// Functions
// ============================================================================

/**
 * Get language from file extension
 * @param filename - Filename to check
 * @returns Language identifier
 */
export function getLanguageFromExtension(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return LANGUAGE_MAP[ext] || 'plaintext';
}

/**
 * Check if file is a binary file
 * @param filename - Filename to check
 * @returns True if file is binary
 */
export function isBinaryFile(filename: string): boolean {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return BINARY_EXTENSIONS.includes(ext);
}

/**
 * Get file type from filename
 * @param filename - Filename to check
 * @returns File type ('json', 'zip', or 'unknown')
 */
export function getFileType(filename: string): 'json' | 'zip' | 'unknown' {
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.zip')) return 'zip';
  return 'unknown';
}

/**
 * Check if filename matches proof file pattern
 * @param filename - Filename to check
 * @returns True if file could be a proof file
 */
export function isProofFilename(filename: string): boolean {
  return filename.endsWith('.json');
}
