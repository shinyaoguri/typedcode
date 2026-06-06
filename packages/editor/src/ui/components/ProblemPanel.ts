/**
 * ProblemPanel - 試験モードの問題表示パネル (ADR-0006 最小骨組み + ADR-0010 詰め)
 *
 * 現状はスタブ。問題の配布元 (封印問題パッケージ + 監督コードによる復号・チェーン束縛) は
 * full ADR-0006 で実装する。casual モードでは生成も表示もされない (モード差は機能のみ)。
 *
 * UX: 既存の preview/log パネルと同じ作法で、右端ドラッグで幅をリサイズ・×で閉じる・
 * タイトルバーのトグルで再表示できる。
 */
export class ProblemPanel {
  private panel: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private resizeHandle: HTMLElement | null = null;
  private editorContainer: HTMLElement | null = null;
  private toggleBtn: HTMLElement | null = null;

  private isResizing = false;
  private startX = 0;
  private startWidth = 0;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: () => void;

  constructor() {
    this.boundMouseMove = this.handleResizeMouseMove.bind(this);
    this.boundMouseUp = this.handleResizeMouseUp.bind(this);
  }

  /** DOM 捕捉 + リサイズ/クローズ/トグルの配線。`#problem-panel` が無ければ false。 */
  initialize(): boolean {
    this.panel = document.getElementById('problem-panel');
    this.body = document.getElementById('problem-body');
    this.resizeHandle = document.getElementById('problem-resize-handle');
    this.editorContainer = document.querySelector<HTMLElement>('.editor-container');
    this.toggleBtn = document.getElementById('toggle-problem-btn');
    if (!this.panel) return false;

    document.getElementById('close-problem-btn')?.addEventListener('click', () => this.hide());
    this.toggleBtn?.addEventListener('click', () => this.toggle());
    this.setupResizeHandle();
    this.updateToggleState();
    return true;
  }

  show(): void {
    this.panel?.classList.add('visible');
    this.updateToggleState();
  }

  hide(): void {
    if (!this.panel) return;
    this.panel.classList.remove('visible');
    // リサイズで付与したインラインスタイルをクリア (再表示時は CSS 既定幅に戻す)。
    this.panel.style.flex = '';
    this.panel.style.minWidth = '';
    this.updateToggleState();
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  get isVisible(): boolean {
    return this.panel?.classList.contains('visible') ?? false;
  }

  /** Activity Bar のトグルアイコンに開閉状態を反映する (VSCode 風の左バー + 明色)。 */
  private updateToggleState(): void {
    this.toggleBtn?.classList.toggle('active', this.isVisible);
  }

  /**
   * 問題本文を設定する。将来は封印パッケージの復号結果を渡す。
   * 現状はスタブのため text として安全に挿入する (HTML 注入はしない)。
   */
  setProblemText(text: string): void {
    if (this.body) this.body.textContent = text;
  }

  private setupResizeHandle(): void {
    if (!this.resizeHandle || !this.panel) return;
    this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.isVisible || !this.panel) return;
      e.preventDefault();
      this.isResizing = true;
      this.startX = e.clientX;
      this.startWidth = this.panel.offsetWidth;
      this.panel.classList.add('resizing');
      this.editorContainer?.classList.add('resizing');
      this.resizeHandle?.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  private handleResizeMouseMove(e: MouseEvent): void {
    if (!this.isResizing || !this.panel) return;
    const container = this.panel.parentElement;
    if (!container) return;
    const containerWidth = container.clientWidth;
    // 左パネル: ハンドルは右端なので、マウスを右に動かす (deltaX > 0) と幅が広がる。
    const deltaX = e.clientX - this.startX;
    const newWidth = this.startWidth + deltaX;
    const minWidth = 200;
    const maxWidth = containerWidth * 0.6;
    const clamped = Math.max(minWidth, Math.min(maxWidth, newWidth));
    this.panel.style.flex = `0 0 ${clamped}px`;
    this.panel.style.minWidth = `${clamped}px`;
  }

  private handleResizeMouseUp(): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    this.panel?.classList.remove('resizing');
    this.editorContainer?.classList.remove('resizing');
    this.resizeHandle?.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
}
