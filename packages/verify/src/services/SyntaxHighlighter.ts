/**
 * SyntaxHighlighter - シンタックスハイライトサービス
 *
 * highlight.js を使用してコードにシンタックスハイライトを適用します。
 * 必要な言語のみを選択的にインポートしてバンドルサイズを最小化。
 */

import hljs from 'highlight.js/lib/core';
import { escapeHtml } from '@typedcode/shared';

// 必要な言語のみインポート
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import xml from 'highlight.js/lib/languages/xml'; // HTML含む
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';

// 言語を登録
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);

// 言語エイリアス（FileProcessor の言語名との対応）
const languageAliases: Record<string, string> = {
  csharp: 'cpp', // 近い構文
  kotlin: 'java', // 近い構文
  swift: 'typescript', // 近い構文
  sass: 'scss',
  less: 'css',
  toml: 'yaml', // 近い構文
  htm: 'html',
  sh: 'bash',
  zsh: 'bash',
};

/**
 * シンタックスハイライトサービス
 */
export class SyntaxHighlighter {
  /**
   * 指定した言語でコードをハイライト
   */
  static highlight(code: string, language: string): string {
    const lang = languageAliases[language] || language;

    // plaintext または未登録の言語はエスケープのみ
    if (lang === 'plaintext' || lang === 'unknown' || !hljs.getLanguage(lang)) {
      return escapeHtml(code);
    }

    try {
      const result = hljs.highlight(code, { language: lang });
      return result.value;
    } catch {
      return escapeHtml(code);
    }
  }

  /**
   * 言語自動検出でハイライト
   */
  static highlightAuto(code: string): { value: string; language: string } {
    try {
      const result = hljs.highlightAuto(code);
      return {
        value: result.value,
        language: result.language ?? 'plaintext',
      };
    } catch {
      return {
        value: escapeHtml(code),
        language: 'plaintext',
      };
    }
  }

  /**
   * ハイライト済みHTMLに行番号を追加
   */
  static addLineNumbers(highlightedHtml: string): string {
    const lines = highlightedHtml.split('\n');
    return lines
      .map(
        (line, i) =>
          `<span class="line-number">${i + 1}</span><span class="line-content">${line}</span>`
      )
      .join('\n');
  }

  /**
   * 言語がサポートされているか確認
   */
  static isLanguageSupported(language: string): boolean {
    const lang = languageAliases[language] || language;
    return hljs.getLanguage(lang) !== undefined;
  }

  /**
   * サポートされている言語一覧を取得
   */
  static getSupportedLanguages(): string[] {
    return hljs.listLanguages();
  }
}
