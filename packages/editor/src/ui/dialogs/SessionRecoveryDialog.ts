/**
 * SessionRecoveryDialog - セッション復旧ダイアログ
 *
 * ブラウザタブを閉じた後に再度開いた場合、前回のセッションから
 * 再開するか、新しいセッションを開始するかを選択させるダイアログ
 */

import { t } from '../../i18n/index.js';
import { escapeHtml, type SessionSummary, type TabSummary } from '@typedcode/shared';
import { attachDialogA11y, type DialogA11yHandle } from '../components/dialogA11y.js';

/**
 * 利用者の選択。
 * - `resume`: 前のセッションを再開する
 * - `fresh-keep`: 新しいセッションを始め、前のセッションのタブを閉じたタブとして残す (#317。exam 以外の既定)
 * - `fresh-delete`: 新しいセッションを始め、前のセッションのデータを完全に削除する (exam はこれだけ)
 */
export type SessionRecoveryChoice = 'resume' | 'fresh-keep' | 'fresh-delete';

export interface SessionRecoveryDialogResult {
  choice: SessionRecoveryChoice;
}

export interface SessionRecoveryDialogOptions {
  /**
   * 「新規」の後に「前のセッションを残す (既定) / 完全に削除する」を選ばせるか (#317)。false (exam) なら
   * 「新規」は従来どおり `fresh-delete` で即座に決まる
   */
  offerKeep: boolean;
}

/**
 * 日時をフォーマット
 */
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // 相対時間の表示
  let relativeTime: string;
  if (diffMinutes < 1) {
    relativeTime = 'just now';
  } else if (diffMinutes < 60) {
    relativeTime = `${diffMinutes} minutes ago`;
  } else if (diffHours < 24) {
    relativeTime = `${diffHours} hours ago`;
  } else {
    relativeTime = `${diffDays} days ago`;
  }

  // 絶対時間
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `${dateStr} ${timeStr} (${relativeTime})`;
}

/**
 * タブリストのHTMLを生成
 */
function generateTabListHtml(tabs: TabSummary[]): string {
  if (tabs.length === 0) {
    return '<li class="session-tab-empty">No files</li>';
  }

  return tabs
    .map((tab) => {
      const eventCountText = t('sessionRecovery.eventCount').replace('${count}', String(tab.eventCount));
      return `
        <li class="session-tab-item">
          <i class="fas fa-file-code"></i>
          <span class="session-tab-name">${escapeHtml(tab.filename)}</span>
          <span class="session-tab-events">${eventCountText}</span>
        </li>
      `;
    })
    .join('');
}

/** 表示中のダイアログの a11y。置き換えで DOM から消えるときに解放する (document の keydown リスナーを残さない) */
let activeA11y: DialogA11yHandle | null = null;

/**
 * セッション復旧ダイアログを表示
 *
 * a11y (#305) は `dialogA11y.ts` が担う。選択 (再開 / 新規開始) が必須なので Escape では閉じない
 * (破壊的な「新規開始」を Escape に割り当てない)。初期フォーカスは破壊的でない「再開」。
 *
 * `offerKeep` (exam 以外。#317) のとき、「新規」を押すと同じダイアログの中で 2 段目
 * (`data-step="fresh"`) に移り、「前のセッションを残す」(既定。初期フォーカス) /「完全に削除する」/「戻る」を選ぶ。
 * 1 段目は `data-step="choose"`。状態契約: overlay の `data-dialog="session-recovery"` と `data-step`、
 * ボタンの `data-action` (`resume` / `fresh` / `fresh-keep` / `fresh-delete` / `back`)。
 *
 * @param sessionSummary セッションサマリー
 * @returns ユーザーの選択結果
 */
export function showSessionRecoveryDialog(
  sessionSummary: SessionSummary,
  options: SessionRecoveryDialogOptions = { offerKeep: false }
): Promise<SessionRecoveryDialogResult> {
  return new Promise((resolve) => {
    // 既存のダイアログがあれば削除
    activeA11y?.close();
    activeA11y = null;
    const existing = document.getElementById('session-recovery-overlay');
    existing?.remove();

    const lastActiveStr = formatDateTime(sessionSummary.lastActiveAt);
    const tabListHtml = generateTabListHtml(sessionSummary.tabs);
    const totalEvents = sessionSummary.tabs.reduce((sum, tab) => sum + tab.eventCount, 0);
    const { offerKeep } = options;

    // 2 段目 (前のセッションを残すか消すか。#317)。exam では作らない
    const freshStepHtml = offerKeep
      ? `
        <div class="session-fresh-step" hidden>
          <p class="session-fresh-message">${t('sessionRecovery.freshMessage')}</p>
          <p class="session-fresh-hint">${t('sessionRecovery.keepHint')}</p>
          <p class="session-fresh-hint session-fresh-delete-hint">
            <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
            ${t('sessionRecovery.deleteHint')}
          </p>
        </div>`
      : '';
    const freshStepButtons = offerKeep
      ? `
          <button id="session-fresh-back-btn" class="modal-btn modal-btn-cancel" data-action="back" hidden>
            ${t('sessionRecovery.back')}
          </button>
          <button id="session-fresh-delete-btn" class="modal-btn modal-btn-danger" data-action="fresh-delete" hidden>
            <i class="fas fa-trash" aria-hidden="true"></i>
            ${t('sessionRecovery.deleteAll')}
          </button>
          <button id="session-fresh-keep-btn" class="modal-btn modal-btn-primary" data-action="fresh-keep" hidden>
            <i class="fas fa-box-archive" aria-hidden="true"></i>
            ${t('sessionRecovery.keepPrevious')}
          </button>`
      : '';

    // オーバーレイ作成
    const overlay = document.createElement('div');
    overlay.id = 'session-recovery-overlay';
    overlay.className = 'modal-overlay';
    overlay.dataset.dialog = 'session-recovery';
    overlay.dataset.step = 'choose';
    overlay.innerHTML = `
      <div class="modal-dialog modal-info session-recovery-dialog">
        <div class="modal-header">
          <i class="fas fa-history"></i>
          <h3>${t('sessionRecovery.title')}</h3>
        </div>
        <div class="modal-body">
          <div class="session-choose-step">
            <p class="session-recovery-message">${t('sessionRecovery.message')}</p>

            <div class="session-recovery-details">
              <div class="session-info-row">
                <span class="session-info-label">${t('sessionRecovery.lastActive')}:</span>
                <span class="session-info-value">${lastActiveStr}</span>
              </div>

              <div class="session-tabs-section">
                <span class="session-info-label">${t('sessionRecovery.tabs')}:</span>
                <ul class="session-tab-list">
                  ${tabListHtml}
                </ul>
              </div>

              <div class="session-total-events">
                <i class="fas fa-list"></i>
                <span>${t('sessionRecovery.eventCount').replace('${count}', String(totalEvents))}</span>
              </div>
            </div>

            <div class="session-recovery-warning">
              <i class="fas fa-exclamation-triangle"></i>
              <span>${t(offerKeep ? 'sessionRecovery.warningKeep' : 'sessionRecovery.warning')}</span>
            </div>
          </div>
          ${freshStepHtml}
        </div>
        <div class="modal-footer">
          <button id="session-fresh-btn" class="modal-btn ${offerKeep ? 'modal-btn-cancel' : 'modal-btn-danger'}" data-action="fresh">
            <i class="fas ${offerKeep ? 'fa-file-circle-plus' : 'fa-trash'}"></i>
            ${t('sessionRecovery.startFresh')}
          </button>
          <button id="session-resume-btn" class="modal-btn modal-btn-primary" data-action="resume">
            <i class="fas fa-play"></i>
            ${t('sessionRecovery.resume')}
          </button>
          ${freshStepButtons}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const resumeBtn = document.getElementById('session-resume-btn');
    const freshBtn = document.getElementById('session-fresh-btn');
    const keepBtn = document.getElementById('session-fresh-keep-btn');
    const deleteBtn = document.getElementById('session-fresh-delete-btn');
    const backBtn = document.getElementById('session-fresh-back-btn');
    const chooseStep = overlay.querySelector<HTMLElement>('.session-choose-step');
    const freshStep = overlay.querySelector<HTMLElement>('.session-fresh-step');
    const allButtons = [resumeBtn, freshBtn, keepBtn, deleteBtn, backBtn];

    const a11y = attachDialogA11y(overlay.querySelector<HTMLElement>('.modal-dialog')!, {
      labelledBy: overlay.querySelector<HTMLElement>('.modal-header h3')!,
      initialFocus: resumeBtn,
      closeOnEscape: false,
      onRequestClose: () => {},
    });
    activeA11y = a11y;

    /** 1 段目と 2 段目を切り替える。隠した側のボタンは `hidden` で Tab の巡回からも外れる */
    function showStep(step: 'choose' | 'fresh'): void {
      const fresh = step === 'fresh';
      overlay.dataset.step = step;
      if (chooseStep) chooseStep.hidden = fresh;
      if (freshStep) freshStep.hidden = !fresh;
      for (const el of [resumeBtn, freshBtn]) if (el) el.hidden = fresh;
      for (const el of [keepBtn, deleteBtn, backBtn]) if (el) el.hidden = !fresh;
      // 既定 (残す) と、戻ったときは破壊的でない「再開」にフォーカスを置く
      (fresh ? keepBtn : resumeBtn)?.focus();
    }

    function choose(choice: SessionRecoveryChoice, button: HTMLElement | null): void {
      disableButtons();
      if (button) {
        const label =
          choice === 'resume'
            ? t('sessionRecovery.resuming')
            : choice === 'fresh-keep'
              ? t('sessionRecovery.starting')
              : t('sessionRecovery.clearing');
        button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${label}`;
      }
      cleanup();
      resolve({ choice });
    }

    // 再開ボタン
    resumeBtn?.addEventListener('click', () => choose('resume', resumeBtn));

    // 新規セッションボタン: 残すか消すかを選ばせる (exam は従来どおり即座に完全削除)
    freshBtn?.addEventListener('click', () => {
      if (offerKeep) showStep('fresh');
      else choose('fresh-delete', freshBtn);
    });
    keepBtn?.addEventListener('click', () => choose('fresh-keep', keepBtn));
    deleteBtn?.addEventListener('click', () => choose('fresh-delete', deleteBtn));
    backBtn?.addEventListener('click', () => showStep('choose'));

    function disableButtons(): void {
      for (const el of allButtons) el?.setAttribute('disabled', 'true');
    }

    function cleanup(): void {
      // どのボタンからでもここを通る。リスナー解放とフォーカス復帰は先に済ませる (冪等)
      a11y.close();
      if (activeA11y === a11y) activeA11y = null;
      setTimeout(() => {
        overlay.classList.add('hidden');
        setTimeout(() => overlay.remove(), 200);
      }, 500);
    }
  });
}
