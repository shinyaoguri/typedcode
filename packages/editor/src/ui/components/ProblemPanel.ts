/**
 * ProblemPanel - 試験モードの問題表示パネル (ADR-0006 最小骨組み)
 *
 * 現状はスタブ。問題の配布元 (封印問題パッケージ + 監督コードによる復号・チェーン束縛) は
 * full ADR-0006 で実装する。ここでは「試験モードでは左に問題パネルが出る」という骨組みだけを
 * 用意する。casual モードでは生成も表示もされない (モード差は機能のみ、の原則)。
 */
export class ProblemPanel {
  private panel: HTMLElement | null = null;
  private body: HTMLElement | null = null;

  /** DOM 要素を捕捉する。`#problem-panel` が無ければ false。 */
  initialize(): boolean {
    this.panel = document.getElementById('problem-panel');
    this.body = document.getElementById('problem-body');
    return this.panel !== null;
  }

  show(): void {
    this.panel?.classList.add('visible');
  }

  hide(): void {
    this.panel?.classList.remove('visible');
  }

  get isVisible(): boolean {
    return this.panel?.classList.contains('visible') ?? false;
  }

  /**
   * 問題本文を設定する。将来は封印パッケージの復号結果を渡す。
   * 現状はスタブのため text として安全に挿入する (HTML 注入はしない)。
   */
  setProblemText(text: string): void {
    if (this.body) this.body.textContent = text;
  }
}
