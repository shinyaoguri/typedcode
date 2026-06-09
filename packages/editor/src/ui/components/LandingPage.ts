/**
 * LandingPage - ルート (`/`) のモード選択入口 (ADR-0015)
 *
 * `typedcode.dev/` と未知パスはここに来る。4モード (casual/class/assignment/exam) を
 * カードで選び、クリックで `/casual` 等へ遷移する。これにより:
 *   - `/casual` を**明示ルート**化し、タイポ (`/exsm` 等) が黙って casual で記録される事故を防ぐ
 *   - casual を「すぐ書けるエディタ」、他モードを授業/試験文脈の入口として導線を明確化する
 *
 * **重いエディタ初期化 (Monaco/トラッカー) はせず DOM のみ描画**する (main.ts が短絡)。
 * カード選択時に利用規約同意フラグを set する (= 入口で一度同意。casual はモーダルを出さない)。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { markTermsAccepted } from '../../app/TermsHandler.js';
import type { EditorMode } from '../../core/mode.js';

interface ModeCard {
  mode: EditorMode;
  icon: string;
  descKey: string;
}

/** 表示順とアイコン (titlebar バッジと揃える)。色は CSS が data-mode から付ける。 */
const MODE_CARDS: ModeCard[] = [
  { mode: 'casual', icon: 'fa-pen', descKey: 'landing.casualDesc' },
  { mode: 'class', icon: 'fa-chalkboard-user', descKey: 'landing.classDesc' },
  { mode: 'assignment', icon: 'fa-house-laptop', descKey: 'landing.assignmentDesc' },
  { mode: 'exam', icon: 'fa-lock', descKey: 'landing.examDesc' },
];

export class LandingPage {
  /** ランディングを #app に被せて描画し、カード選択で該当モードのパスへ遷移する。 */
  render(): void {
    const overlay = document.createElement('div');
    overlay.className = 'landing-overlay';
    overlay.id = 'landing-page';
    overlay.innerHTML = this.html();
    document.body.appendChild(overlay);
    // エディタシェルは初期化しない (initializeApp を呼ばない) のでレイアウトから外す。
    // 注: top-level で生成される Monaco エディタ (main.ts) はこの非表示コンテナ内に作られるが、
    // 操作されないまま遷移するので無害 (完全 lazy-split は将来最適化、ADR-0015)。
    document.getElementById('app')?.style.setProperty('display', 'none');
    document.getElementById('init-overlay')?.classList.add('hidden');

    overlay.querySelectorAll<HTMLElement>('.landing-card').forEach((card) => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode as EditorMode;
        // 入口で一度、利用規約に同意したものとして記録する (各モードはモーダルを再掲しない)。
        markTermsAccepted();
        window.location.assign(`/${mode}`);
      });
    });
  }

  private html(): string {
    const cards = MODE_CARDS.map((c) => `
      <button type="button" class="landing-card" data-mode="${c.mode}">
        <span class="landing-card-icon"><i class="fas ${c.icon}"></i></span>
        <span class="landing-card-name">${escapeHtml(t(`feature.${c.mode}`))}</span>
        <span class="landing-card-desc">${escapeHtml(t(c.descKey))}</span>
        <span class="landing-card-start">${escapeHtml(t('landing.start'))} <i class="fas fa-arrow-right"></i></span>
      </button>`).join('');

    return `
      <div class="landing-content">
        <img src="/icon-192.png" alt="TypedCode" class="landing-logo">
        <h1 class="landing-title">${escapeHtml(t('landing.title'))}</h1>
        <p class="landing-subtitle">${escapeHtml(t('landing.subtitle'))}</p>
        <div class="landing-cards">${cards}</div>
        <p class="landing-terms">${escapeHtml(t('landing.termsNotice'))}</p>
      </div>
    `;
  }
}
