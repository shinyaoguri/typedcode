/**
 * TerminalHandler - ターミナル関連の処理
 */

import type { AppContext } from '../core/AppContext.js';
import { isLanguageExecutable } from '../config/SupportedLanguages.js';

/**
 * ターミナルに言語の説明を表示
 */
export function showLanguageDescriptionInTerminal(ctx: AppContext, language: string): void {
  if (!ctx.terminal) return;
  ctx.terminal.clear();

  // 言語の実行可否に応じてターミナルパネルの状態を更新
  const executable = isLanguageExecutable(language);
  ctx.terminalPanel.setTerminalAvailable(executable);

  const langDesc = ctx.runtime.getLanguageDescription(language);
  for (const line of langDesc) {
    ctx.terminal.writeLine(line);
  }
  ctx.terminal.writeLine('');
}
