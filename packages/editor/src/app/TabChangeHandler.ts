/**
 * TabChangeHandler - タブ変更時の処理
 */

import type { AppContext } from '../core/AppContext.js';
import { showLanguageDescriptionInTerminal } from './TerminalHandler.js';
import { updateProofStatus } from './AppHelpers.js';

interface TabInfo {
  filename: string;
  language: string;
  typingProof: unknown;
}

/**
 * タブ変更時のハンドラ
 */
export function handleTabChange(ctx: AppContext, tab: TabInfo): void {
  ctx.tabUIController?.updateUI();
  updateProofStatus(ctx);
  document.title = `${tab.filename} - TypedCode`;

  const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
  if (languageSelector) {
    languageSelector.value = tab.language;
  }

  showLanguageDescriptionInTerminal(ctx, tab.language);
  ctx.runtime.updateIndicator(tab.language);

  if (ctx.logViewer && ctx.tabManager) {
    const activeTab = ctx.tabManager.getActiveTab();
    if (activeTab) {
      ctx.logViewer.setTypingProof(activeTab.typingProof);
    }
  }
}
