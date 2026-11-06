/**
 * NotFoundPage - 未知パス (`/exsm` など) の「このページはありません」画面 (#644)
 *
 * タイポしたパスを黙って練習 (casual) にすると、「試験のつもりが練習で記録していた」事故になる
 * (ADR-0015 から引き継ぐ判断)。未知パスではエディタを起動せず、トップ (`/` = 練習のエディタ) への
 * リンクだけを出す。
 *
 * **重いエディタ初期化 (Monaco/トラッカー) はせず DOM のみ描画する** (entry.ts が main.ts を読まずにここだけ描く。#302)。
 * ここからエディタ側のモジュールを静的 import しない。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';

export const NOT_FOUND_PAGE_ID = 'not-found-page';

export class NotFoundPage {
  /** 画面を body に描き、エディタシェルの DOM (index.html の #app) と起動中の表示を外す。 */
  render(): void {
    const page = document.createElement('div');
    page.className = 'not-found-page';
    page.id = NOT_FOUND_PAGE_ID;
    page.innerHTML = `
      <div class="not-found-content">
        <img src="/icon-192.png" alt="TypedCode" class="not-found-logo">
        <h1 class="not-found-title">${escapeHtml(t('notFound.title'))}</h1>
        <p class="not-found-body">${escapeHtml(t('notFound.body'))}</p>
        <a class="not-found-link" href="/" data-action="open-editor">
          <i class="fas fa-pen" aria-hidden="true"></i>
          ${escapeHtml(t('notFound.openEditor'))}
        </a>
      </div>`;
    document.body.appendChild(page);
    // エディタシェルの DOM は初期化しないのでレイアウトから外す。main.ts を読まないので Monaco は生成されない (#302)。
    document.getElementById('app')?.style.setProperty('display', 'none');
    document.getElementById('init-overlay')?.classList.add('hidden');
  }
}
