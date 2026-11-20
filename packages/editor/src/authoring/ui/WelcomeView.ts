/**
 * 作問画面の起動画面 (#796): 「フォルダを開く」「新しいフォルダを作る」「前回のフォルダを開く」。
 *
 * ボタンは `data-action` (`open-folder` / `create-folder` / `resume-folder`) で E2E から選べる。
 * 知らせ (`#author-welcome-message`) には理由を `data-reason` で出す (`unsupported` / `denied` / `missing` /
 * `error` / `open-failed`)。`showDirectoryPicker` の無いブラウザでは開く・作るを押せなくし、対応ブラウザを案内する。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';

export interface WelcomeHandlers {
  onOpen(): void;
  onCreate(): void;
  /** クリックのハンドラの中で呼ぶ (権限の要求はユーザー操作の中でしか通らない) */
  onResume(): void;
}

export type WelcomeReason = 'unsupported' | 'denied' | 'missing' | 'error' | 'open-failed';

export class WelcomeView {
  readonly element: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly message: HTMLElement;
  private readonly status: HTMLElement;

  constructor(handlers: WelcomeHandlers) {
    const el = document.createElement('section');
    el.className = 'author-welcome';
    el.id = 'author-welcome';
    el.setAttribute('aria-labelledby', 'author-welcome-heading');
    el.innerHTML = `
      <div class="author-welcome-card">
        <h1 id="author-welcome-heading"><i class="fas fa-folder-open" aria-hidden="true"></i> ${escapeHtml(t('author.welcome.heading'))}</h1>
        <p class="author-welcome-intro">${escapeHtml(t('author.welcome.intro'))}</p>
        <div class="author-welcome-actions">
          <button type="button" class="author-btn author-btn-primary" id="author-open-folder" data-action="open-folder"><i class="fas fa-folder-open" aria-hidden="true"></i> ${escapeHtml(t('author.welcome.open'))}</button>
          <button type="button" class="author-btn" id="author-create-folder" data-action="create-folder"><i class="fas fa-folder-plus" aria-hidden="true"></i> ${escapeHtml(t('author.welcome.create'))}</button>
          <button type="button" class="author-btn" id="author-resume-folder" data-action="resume-folder" hidden><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> <span></span></button>
        </div>
        <p class="author-welcome-status" id="author-welcome-status" role="status" hidden>${escapeHtml(t('author.welcome.opening'))}</p>
        <p class="author-welcome-message" id="author-welcome-message" role="alert" hidden></p>
      </div>`;
    this.element = el;
    this.resumeButton = el.querySelector<HTMLButtonElement>('#author-resume-folder')!;
    this.message = el.querySelector<HTMLElement>('#author-welcome-message')!;
    this.status = el.querySelector<HTMLElement>('#author-welcome-status')!;
    el.querySelector('#author-open-folder')!.addEventListener('click', () => handlers.onOpen());
    el.querySelector('#author-create-folder')!.addEventListener('click', () => handlers.onCreate());
    this.resumeButton.addEventListener('click', () => handlers.onResume());
  }

  /** ピッカーが無いブラウザでは開く・作るを押せなくして案内を出す */
  setPickerSupported(supported: boolean): void {
    for (const id of ['#author-open-folder', '#author-create-folder']) {
      this.element.querySelector<HTMLButtonElement>(id)!.disabled = !supported;
    }
    if (!supported) this.showMessage(t('author.welcome.unsupported'), 'unsupported');
  }

  /** 前回のフォルダを開くボタン (権限の要求が要るとき)。null で隠す */
  showResume(name: string | null): void {
    this.resumeButton.hidden = name === null;
    this.resumeButton.querySelector('span')!.textContent = name === null ? '' : t('author.welcome.resume', { name });
  }

  showMessage(text: string | null, reason?: WelcomeReason): void {
    this.message.hidden = text === null;
    this.message.textContent = text ?? '';
    if (reason && text !== null) this.message.dataset.reason = reason;
    else delete this.message.dataset.reason;
  }

  setBusy(busy: boolean): void {
    this.status.hidden = !busy;
  }
}
