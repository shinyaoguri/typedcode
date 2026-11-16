/**
 * 試験の許可言語 (`manifest.allowed.languages`) の判定 (#727)。
 *
 * 「この言語は、この問題で許可されているか」の**単一実装**。editor (言語の選択・変更・実行・HTML
 * プレビューの開始) と grader (`verifyExamBinding` の `proof.language` 照合) の両方がここを呼ぶ。
 *
 * 既存パッケージの読み込みの扱いを変えない:
 * - 言語名は正規化しない (完全一致)。manifest は出題者の署名対象で、`/author` は trim 済みの値を書き、
 *   editor はその文字列をそのまま Monaco の言語 id と proof.language にしてきた
 * - `allowed.languages` が空のパッケージは「制限なし」(`null`)。editor はこれまで既定の `'c'` で開いて
 *   言語を制限していなかったので、ここで拒否に倒すと既存の package が使えなくなる
 * - v2 (バンドル) の問題が starter を持つときは、その `starter.language` も許可集合に入れる。`/author` は
 *   starter の言語を拡張子から決め、許可言語と突き合わせないので、含めないと正規に作った package の
 *   starter の言語のタブが自分の言語で実行できず、検証でも落ちる
 *
 * proof.language は提出時のタブの言語の自己申告で、全履歴で実行された言語を保証しない。
 * ここで言えるのは「提出物が名乗る言語が試験の許可集合に入っているか」だけ。
 */

/** `checkExamLanguage` の結果 (`ExamBindingVerificationResult.language`) */
export interface ExamLanguageCheck {
  /**
   * - allowed: proof.language が許可集合に入っている
   * - not-allowed: 入っていない (文字列でない・欠落も含む。fail-closed)
   * - not-evaluated: package が許可言語を 1 つも挙げていない (制限なし。valid に影響させない)
   */
  status: 'allowed' | 'not-allowed' | 'not-evaluated';
  /** not-allowed / not-evaluated の理由 (英語) */
  reason?: string;
}

/**
 * 問題の許可言語の集合を返す。`null` は「制限なし」(package が許可言語を挙げていない)。
 *
 * @param manifestLanguages 署名済み manifest の `allowed.languages`
 * @param starterLanguage v2 の該当問題の `starter.language` (無ければ省略)
 */
export function examAllowedLanguages(
  manifestLanguages: readonly string[],
  starterLanguage?: string
): readonly string[] | null {
  if (manifestLanguages.length === 0) return null;
  if (starterLanguage === undefined || manifestLanguages.includes(starterLanguage)) return [...manifestLanguages];
  return [...manifestLanguages, starterLanguage];
}

/** 言語が許可集合に入っているか。`allowed === null` (制限なし) は常に true、文字列でない言語は false。 */
export function isExamLanguageAllowed(allowed: readonly string[] | null, language: unknown): boolean {
  if (allowed === null) return true;
  return typeof language === 'string' && allowed.includes(language);
}

/** grader 用: proof の自己申告 `language` を許可集合と照合した結果を返す。 */
export function checkExamLanguage(allowed: readonly string[] | null, proofLanguage: unknown): ExamLanguageCheck {
  if (allowed === null) {
    return { status: 'not-evaluated', reason: 'Exam package declares no allowed languages' };
  }
  if (typeof proofLanguage !== 'string') {
    return { status: 'not-allowed', reason: 'Proof has no language to check against the allowed languages' };
  }
  if (!isExamLanguageAllowed(allowed, proofLanguage)) {
    return { status: 'not-allowed', reason: "Proof language is not one of the exam package's allowed languages" };
  }
  return { status: 'allowed' };
}
