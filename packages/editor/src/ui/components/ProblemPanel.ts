/**
 * ProblemPanel - 試験モードの問題表示パネル (ADR-0006 + ADR-0010 + ADR-0012)
 *
 * 復号した問題文 (Markdown) を**レンダリングして**表示する。出題プレビュー (AuthorPage) と
 * 同じ `renderMarkdown` を使い「教員が見たプレビュー == 受験者が見る表示」を保証する。
 *
 * UX: 既存の preview/log パネルと同じ作法で、右端ドラッグで幅をリサイズ・×で閉じる・
 * タイトルバーのトグルで再表示できる。
 *
 * 入出力例 (#648 / ADR-0048): 問題文の下に「動作確認の例」の節 (`#problem-examples`) を置く。
 * 判定はせず、受講者が自分で実行して見比べる。入力のコピーは proof に何も記録しない
 * (`SessionContentRegistry` にも登録しないので、コピーした入力をコードに貼ると外部の貼り付けになる)。
 */
import type { ProblemExample } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { renderMarkdown } from '../../utils/markdown.js';

/** コピー成功の表示 (`copied`) を残す時間。コードのコピー (`#copy-code-btn`) と揃える。 */
const COPIED_FEEDBACK_MS = 2000;

/** `<pre>` に出すときだけ末尾の改行 1 つを落とす (`"8\n"` の空行を見せない)。コピーには元の文字列を使う。 */
function displayText(text: string): string {
  return text.replace(/\r?\n$/, '');
}

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

  /** Activity Bar のトグルアイコンとパネルの data-open に開閉状態を反映する (VSCode 風の左バー + 明色)。 */
  private updateToggleState(): void {
    this.toggleBtn?.classList.toggle('active', this.isVisible);
    // 状態契約 (packages/editor/AGENTS.md「状態契約」): 開閉は `.visible` と同時に data-open で出す。
    this.panel?.setAttribute('data-open', String(this.isVisible));
  }

  /** パネル見出しをモードに合わせて設定する (試験/授業/課題。ADR-0015)。 */
  setTitle(text: string): void {
    const el = document.getElementById('problem-panel-title');
    if (el) el.textContent = text;
  }

  /**
   * 問題本文 (Markdown) と入出力例を 1 回で描き直す。本文は `renderMarkdown` で sanitize 済み HTML に
   * 変換して表示する (出題プレビューと同一レンダラ)。例の節も毎回作り直すので、タブを切り替えたときに
   * 前の問題の例が残らない。例が無い (省略・空配列) 問題では節を描かない。
   */
  setProblem(statement: string, examples?: readonly ProblemExample[]): void {
    if (!this.body) return;
    this.body.classList.add('markdown-rendered');
    this.body.innerHTML = renderMarkdown(statement);

    this.panel?.querySelector('#problem-examples')?.remove();
    if (examples && examples.length > 0) {
      this.body.after(this.renderExamples(examples));
    }
  }

  /**
   * 「動作確認の例」の節を組み立てる。中身は配布物から来る文字列なので、innerHTML を使わず
   * textContent で入れる。状態契約 (packages/editor/AGENTS.md「状態契約」): 節の `data-example-count`、
   * 例ごとの `data-example-index`、名前の `[data-role="name"]`、`pre[data-role="stdin"|"stdout"]`、入力の無い例の
   * `[data-role="no-input"]`、コピーボタンの `data-action="copy-stdin"`。
   */
  private renderExamples(examples: readonly ProblemExample[]): HTMLElement {
    const section = document.createElement('section');
    section.id = 'problem-examples';
    section.className = 'problem-examples';
    section.dataset.exampleCount = String(examples.length);

    const heading = document.createElement('h3');
    heading.className = 'problem-examples-heading';
    heading.textContent = t('problemExamples.heading');
    const instructions = document.createElement('p');
    instructions.className = 'problem-examples-instructions';
    instructions.textContent = t('problemExamples.instructions');
    section.append(heading, instructions);

    examples.forEach((example, index) => {
      const block = document.createElement('div');
      block.className = 'problem-example';
      block.dataset.exampleIndex = String(index);

      const name = document.createElement('div');
      name.className = 'problem-example-name';
      name.dataset.role = 'name';
      name.textContent = example.name;
      block.appendChild(name);

      const inputHead = document.createElement('div');
      inputHead.className = 'problem-example-label';
      const inputLabel = document.createElement('span');
      inputLabel.textContent = t('problemExamples.input');
      inputHead.appendChild(inputLabel);
      block.appendChild(inputHead);

      if (example.stdin.length > 0) {
        inputHead.appendChild(this.createCopyButton(example.stdin));
        block.appendChild(this.createPre('stdin', example.stdin));
      } else {
        // 入力の無い例はコピーするものが無いので、ボタンを出さずに「入力なし」と書く
        const none = document.createElement('p');
        none.className = 'problem-example-noinput';
        none.dataset.role = 'no-input';
        none.textContent = t('problemExamples.noInput');
        block.appendChild(none);
      }

      const outputHead = document.createElement('div');
      outputHead.className = 'problem-example-label';
      outputHead.textContent = t('problemExamples.output');
      block.append(outputHead, this.createPre('stdout', example.stdout));

      section.appendChild(block);
    });
    return section;
  }

  private createPre(role: 'stdin' | 'stdout', text: string): HTMLPreElement {
    const pre = document.createElement('pre');
    pre.className = 'problem-example-io';
    pre.dataset.role = role;
    pre.textContent = displayText(text);
    return pre;
  }

  /** 入力のコピーボタン。`stdin` を末尾の改行込みでそのまま渡す (貼ると Enter まで入る)。 */
  private createCopyButton(stdin: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'problem-example-copy';
    button.dataset.action = 'copy-stdin';
    const icon = document.createElement('i');
    icon.className = 'fas fa-copy';
    const label = document.createElement('span');
    label.textContent = t('problemExamples.copy');
    button.append(icon, ' ', label);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(stdin);
        button.classList.add('copied');
        label.textContent = t('problemExamples.copied');
        setTimeout(() => {
          button.classList.remove('copied');
          label.textContent = t('problemExamples.copy');
        }, COPIED_FEEDBACK_MS);
      } catch (error) {
        console.error('[TypedCode] Copy failed:', error);
      }
    });
    return button;
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
