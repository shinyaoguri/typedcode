/**
 * HTML Escape Utility
 *
 * HTML特殊文字をエスケープするユーティリティ
 * XSS対策としてユーザー入力をHTML内に表示する際に使用
 */

/** エスケープ対象の文字マップ */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

/** エスケープ対象文字のパターン */
const HTML_ESCAPE_PATTERN = /[&<>"']/g;

/**
 * HTML特殊文字をエスケープ
 *
 * @param text - エスケープする文字列
 * @returns エスケープされた文字列
 *
 * @example
 * ```typescript
 * escapeHtml('<script>alert("xss")</script>')
 * // => '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 * ```
 */
export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_PATTERN, (char) => HTML_ESCAPE_MAP[char] ?? char);
}
