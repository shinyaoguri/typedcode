/**
 * TermsNotice (#644) — 練習 (casual) で、利用規約に未同意のときに出す受動的な通知バナー。
 *
 * 練習は「すぐ書ける」入口なので規約のモーダルを強制しない (ADR-0015)。以前は入口のランディングに
 * 「利用を開始すると利用規約に同意したものとみなします」とあったが、`/` が直接エディタを開くようになったので、
 * その通知をエディタの上端に出す。
 *
 * - 「利用規約」: 既存の規約モーダル (`#terms-modal`) を開く。そこで同意したら同意済みとして閉じる
 * - 「OK」: 同意したものとして閉じる
 *
 * どちらの経路でも `onAccepted` はちょうど 1 回だけ呼ぶ (同意の記録は呼び出し側 = main.ts が持つ)。
 * 画面共有のオプトアウトバナー (`ScreenCaptureDialogs.ts`) と同じく #app の先頭に積む (重ならない)。
 *
 * 文の後ろに、どのモードでも証明しないことの注記 (`scopeNote.text`。#240 の D3) を添える。
 *
 * 状態契約: バナーの root に `data-banner="terms"`、ボタンに `data-action="open-terms"` / `"ok"`、
 * 注記に `data-note="scope"`。
 * 出ている = DOM にある。閉じると DOM から外れる。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';

export const TERMS_NOTICE_ID = 'terms-notice-banner';

export interface TermsNoticeOptions {
  /** 規約モーダルを開き、同意されたら resolve する (既存の `showTermsModal`) */
  openTerms: () => Promise<void>;
  /** 同意したものとして閉じたときに 1 回だけ呼ぶ */
  onAccepted: () => void;
  /** 差し込む先。既定は #app (無ければ body) */
  container?: HTMLElement | null;
}

/** 通知を出す。既に出ていれば何もしない。 */
export function showTermsNotice(options: TermsNoticeOptions): void {
  if (document.getElementById(TERMS_NOTICE_ID)) return;

  const banner = document.createElement('div');
  banner.id = TERMS_NOTICE_ID;
  banner.className = 'terms-notice-banner';
  banner.dataset.banner = 'terms';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <div class="terms-notice-content">
      <i class="fas fa-file-contract" aria-hidden="true"></i>
      <span class="terms-notice-texts">
        <span class="terms-notice-text">${escapeHtml(t('termsNotice.text'))}</span>
        <span class="terms-notice-scope" data-note="scope">${escapeHtml(t('scopeNote.text'))}</span>
      </span>
      <button class="terms-notice-btn terms-notice-link" type="button" data-action="open-terms">
        ${escapeHtml(t('termsNotice.link'))}
      </button>
      <button class="terms-notice-btn terms-notice-ok" type="button" data-action="ok">
        ${escapeHtml(t('termsNotice.ok'))}
      </button>
    </div>
  `;

  let settled = false;
  const accept = (): void => {
    if (settled) return;
    settled = true;
    banner.remove();
    options.onAccepted();
  };

  const buttons = banner.querySelectorAll<HTMLButtonElement>('button');
  banner.querySelector('[data-action="ok"]')?.addEventListener('click', accept);
  banner.querySelector('[data-action="open-terms"]')?.addEventListener('click', () => {
    // モーダルの間に OK を押して二重に進まないよう、ボタンを止めておく
    for (const b of buttons) b.disabled = true;
    void options.openTerms().then(accept, () => {
      for (const b of buttons) b.disabled = false;
    });
  });

  const container = options.container !== undefined ? options.container : document.getElementById('app');
  const parent = container ?? document.body;
  parent.insertBefore(banner, parent.firstChild);
}
