/**
 * TabChangeHandler - タブ変更時の処理
 */

import type { AppContext } from '../core/AppContext.js';
import { showLanguageDescriptionInTerminal } from './TerminalHandler.js';
import { updateProofStatus } from './AppHelpers.js';
import { ExamPackageStore } from '../services/ExamPackageStore.js';
import { ClassProblemStore } from '../services/ClassProblemStore.js';

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

  // 問題表示モード (ADR-0012/0014): 1問1タブなので、アクティブタブの問題文を ProblemPanel に
  // 出し分ける。exam は problemId → ExamPackageStore、class は filename → ClassProblemStore で引く
  // (class は examContext を持たないため filename で照合する)。
  if (ctx.capabilities.problemPanel && ctx.tabManager) {
    const activeTab = ctx.tabManager.getActiveTab();
    if (ctx.examMode) {
      const problemId = activeTab?.typingProof.examContext?.problemId;
      const pkg = problemId ? ExamPackageStore.get(problemId) : null;
      if (pkg) ctx.problemPanel.setProblemText(pkg.plaintext);
    } else {
      const problem = activeTab?.filename ? ClassProblemStore.get(activeTab.filename) : null;
      if (problem) ctx.problemPanel.setProblemText(problem.statement);
    }
  }
}
