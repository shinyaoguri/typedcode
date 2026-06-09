/**
 * Markdown レンダリング (#80, ADR-0012)。
 *
 * 問題文は Markdown で書き、**受験時 (ProblemPanel) と出題プレビュー (AuthorPage) で同じ
 * レンダラを使う**ことで「教員が見たプレビュー == 受験者が見る表示」を保証する。
 *
 * 封印 package の問題文は信頼できる出題者が署名した内容だが、defense-in-depth として
 * DOMPurify で sanitize してから挿入する (XSS 経路を残さない)。
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown 文字列を sanitize 済み HTML に変換する。 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false });
  return DOMPurify.sanitize(html);
}
