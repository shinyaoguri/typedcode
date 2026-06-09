/**
 * ModeSwitcher (ADR-0015) — エディタ内のモード切替 (titlebar のピル → ドロップダウン)。
 *
 * 現在のモードを表示し、クリックで 4 モードのメニューを開く。別モードを選ぶと `/<mode>` へ遷移する
 * (フルリロード)。**現モードの作業は失われない** — storage はモード別名前空間なので、切り替えても
 * 元モードのセッションはそのまま残り、戻れば復元される (ADR-0011 PR3)。
 *
 * 注意 (ADR-0015 設計判断): exam/class に既存セッションがあるモードへ切り替えると、そのモードの
 * リロード復帰挙動 (試験は監督コード再入力なしで復元) が走る。これは URL に `/exam` を打つのと同じで、
 * 試験の整合性は封印の暗号束縛が担保するので新たなリスクではない (ただしバッジで「進行中」が見える)。
 *
 * titlebar に既存ドロップダウン DOM が無いので、本コンポーネントが DOM を自前生成して
 * `.titlebar-left` に append する。キーボード操作 (Esc 閉じ + フォーカス戻し / 上下移動) に対応。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { ALL_EDITOR_MODES, type EditorMode } from '../../core/mode.js';

const MODE_ICONS: Record<EditorMode, string> = {
  casual: 'fa-pen',
  class: 'fa-chalkboard-user',
  assignment: 'fa-house-laptop',
  exam: 'fa-lock',
};

export class ModeSwitcher {
  private root: HTMLElement;
  private btn: HTMLButtonElement;
  private menu: HTMLElement;
  private opened = false;
  private readonly onOutside: (e: MouseEvent) => void;

  constructor(private readonly current: EditorMode) {
    this.root = document.createElement('div');
    this.root.className = 'mode-switcher';
    this.root.innerHTML = this.html();
    document.querySelector('.titlebar-left')?.appendChild(this.root);

    this.btn = this.root.querySelector<HTMLButtonElement>('#mode-switcher-btn')!;
    this.menu = this.root.querySelector<HTMLElement>('.mode-switcher-menu')!;
    this.onOutside = (e) => {
      if (!this.root.contains(e.target as Node)) this.close();
    };
    this.wire();
  }

  private html(): string {
    const items = ALL_EDITOR_MODES.map(
      (m) => `
      <button class="mode-item${m === this.current ? ' active' : ''}" type="button"
              role="menuitem" data-mode="${m}">
        <i class="fas ${MODE_ICONS[m]}" aria-hidden="true"></i>
        <span>${escapeHtml(t(`feature.${m}`))}</span>
        <i class="fas fa-check mode-check" aria-hidden="true"></i>
      </button>`
    ).join('');
    return `
      <button class="mode-switcher-pill" id="mode-switcher-btn" type="button"
              aria-haspopup="true" aria-expanded="false" title="${escapeHtml(t('landing.switchMode'))}">
        <i class="fas ${MODE_ICONS[this.current]}" aria-hidden="true"></i>
        <span class="mode-switcher-label">${escapeHtml(t(`feature.${this.current}`))}</span>
        <i class="fas fa-chevron-down" aria-hidden="true"></i>
      </button>
      <div class="mode-switcher-menu" role="menu" hidden>${items}</div>`;
  }

  private wire(): void {
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.open();
        this.focusItem(0);
      }
    });
    this.root.querySelectorAll<HTMLElement>('.mode-item').forEach((item) => {
      item.addEventListener('click', () => {
        const mode = item.dataset.mode as EditorMode;
        if (mode !== this.current) {
          window.location.assign(`/${mode}`);
        } else {
          this.close();
          this.btn.focus();
        }
      });
    });
    this.menu.addEventListener('keydown', (e) => this.onMenuKey(e));
  }

  private onMenuKey(e: KeyboardEvent): void {
    const items = Array.from(this.menu.querySelectorAll<HTMLElement>('.mode-item'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      this.btn.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusItem((idx + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusItem((idx - 1 + items.length) % items.length);
    }
  }

  private focusItem(i: number): void {
    this.menu.querySelectorAll<HTMLElement>('.mode-item')[i]?.focus();
  }

  private toggle(): void {
    this.opened ? this.close() : this.open();
  }

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', this.onOutside);
  }

  private close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', this.onOutside);
  }
}
