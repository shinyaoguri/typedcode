/**
 * 試験の許可言語をタブに当てはめる (#727)。
 *
 * 判定そのものは shared の `examAllowedLanguages` / `isExamLanguageAllowed` (grader の `proof.language`
 * 照合と同じ実装)。ここは「どのタブに、どのパッケージの許可言語が掛かるか」を決めるだけで、言語の
 * 選択肢・言語変更 (`TabManager.setTabLanguage`)・実行開始 (`CodeExecutionController`)・HTML プレビュー
 * (`BrowserPreviewPanel`) の各境界がここを呼ぶ。UI の選択肢を消すだけでは、保存状態の復元や直接の
 * 状態変更で非許可の言語になったタブがそのまま実行・プレビューできてしまうため。
 *
 * - casual / class / assignment は制限しない (class の `allowed` は署名の無い tier ① の宣言)
 * - exam のタブは `examContext.problemId` で `ExamPackageStore` の manifest を引き、v2 はその問題の
 *   starter の言語も許可する (shared 側の規則)。パッケージが引けないタブは何も許可しない (fail-closed)
 *
 * editor 側の制限は利用者の操作を止めるためのもので、改造クライアントへの防御ではない。
 * 提出物の言語は grader が proof.language と署名済み manifest で照合する (proof.language は自己申告)。
 */

import { examAllowedLanguages, isExamLanguageAllowed } from '@typedcode/shared';
import { ExamPackageStore, type StoredExamPackage } from '../services/ExamPackageStore.js';

/** 許可言語の判定に使うタブの最小形 */
export interface LanguagePolicyTab {
  typingProof: { examContext?: { problemId: string } | null };
}

export interface TabLanguagePolicyOptions {
  /** 試験モードか (`ctx.examMode`) */
  examMode: boolean;
  /** problemId から保存済みの問題パッケージを引く (`ExamPackageStore.get`) */
  lookup: (problemId: string) => StoredExamPackage | null;
}

export interface TabLanguagePolicy {
  /** タブに掛かる許可言語の集合。`null` は制限なし */
  allowedFor(tab: LanguagePolicyTab): readonly string[] | null;
  /** タブでその言語を使ってよいか */
  isAllowed(tab: LanguagePolicyTab, language: string): boolean;
}

/** タブごとの許可言語の判定を作る。 */
export function createTabLanguagePolicy(options: TabLanguagePolicyOptions): TabLanguagePolicy {
  const allowedFor = (tab: LanguagePolicyTab): readonly string[] | null => {
    if (!options.examMode) return null;
    const problemId = tab.typingProof.examContext?.problemId;
    const pkg = problemId ? options.lookup(problemId) : null;
    // 試験のタブなのにパッケージが引けない (保存の欠落・書き換え) なら何も許可しない
    if (!pkg) return [];
    return examAllowedLanguages(pkg.manifest.allowed.languages, pkg.starterLanguage);
  };
  return {
    allowedFor,
    isAllowed: (tab, language) => isExamLanguageAllowed(allowedFor(tab), language),
  };
}

/**
 * 言語セレクタの選択肢を許可集合に合わせる。許可されない選択肢は `disabled` + `hidden` にする
 * (状態の値として残すため DOM からは外さない)。`null` (制限なし) なら全て選べるように戻す。
 */
export function applyLanguageOptions(selector: HTMLSelectElement, allowed: readonly string[] | null): void {
  for (const option of Array.from(selector.options)) {
    const blocked = allowed !== null && !allowed.includes(option.value);
    option.disabled = blocked;
    option.hidden = blocked;
  }
}

/** アプリの文脈 (モードと `ExamPackageStore`) からタブの許可言語の判定を作る */
export function languagePolicyFor(ctx: { examMode: boolean }): TabLanguagePolicy {
  return createTabLanguagePolicy({ examMode: ctx.examMode, lookup: (problemId) => ExamPackageStore.get(problemId) });
}

/**
 * `#language-selector` をタブに合わせる: 値をタブの言語にし、選択肢をタブの許可言語に絞る。
 * タブの切替・復元・試験の開封のたびに呼ぶ。復元したタブの言語が許可されない場合も値はそのまま出す
 * (実行とプレビューは各境界が止める)。
 */
export function syncLanguageSelector(ctx: { examMode: boolean }, tab: LanguagePolicyTab & { language: string }): void {
  const selector = document.getElementById('language-selector') as HTMLSelectElement | null;
  if (!selector) return;
  applyLanguageOptions(selector, languagePolicyFor(ctx).allowedFor(tab));
  selector.value = tab.language;
}
