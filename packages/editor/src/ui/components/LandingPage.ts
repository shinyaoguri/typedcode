/**
 * LandingPage - ルート (`/`) のモード選択入口 (ADR-0015)
 *
 * `typedcode.dev/` と未知パスはここに来る。4モード (casual/class/assignment/exam) を
 * **比較カード**(料金比較ページ風) で横並びに見せ、ワンクリックで違いがある程度わかるようにする。
 *   - `/casual` を**明示ルート**化し、タイポ (`/exsm` 等) が黙って casual で記録される事故を防ぐ
 *   - casual を「すぐ書けるお試し」、他モードを授業/試験文脈の入口として導線を明確化する
 *   - 進行中セッションがあるモードには「続きから」バッジを非同期で表示する
 *
 * **重いエディタ初期化 (Monaco/トラッカー) はせず DOM のみ描画**する (main.ts が短絡)。
 * カード選択時に利用規約同意フラグを set する (= 入口で一度同意。casual はモーダルを出さない)。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { markTermsAccepted } from '../../app/TermsHandler.js';
import { ALL_EDITOR_MODES, type EditorMode } from '../../core/mode.js';

/** 各モードのアイコン (titlebar バッジと揃える)。色は CSS が data-mode から付ける。 */
const MODE_ICONS: Record<EditorMode, string> = {
  casual: 'fa-pen',
  class: 'fa-chalkboard-user',
  assignment: 'fa-house-laptop',
  exam: 'fa-lock',
};

/** カード上部のタグライン (landing.*Desc)。 */
const MODE_DESC_KEYS: Record<EditorMode, string> = {
  casual: 'landing.casualDesc',
  class: 'landing.classDesc',
  assignment: 'landing.assignmentDesc',
  exam: 'landing.examDesc',
};

type Cell = { kind: 'yes' | 'no' | 'na' } | { kind: 'text'; key: string };

interface FeatureRow {
  labelKey: string;
  cells: Record<EditorMode, Cell>;
}

/** 比較表の行 (能力差を一目で。値は core/mode.ts の能力と一致させる)。 */
const FEATURE_ROWS: FeatureRow[] = [
  {
    labelKey: 'landing.feat.purpose',
    cells: {
      casual: { kind: 'text', key: 'landing.val.purposeCasual' },
      class: { kind: 'text', key: 'landing.val.purposeClass' },
      assignment: { kind: 'text', key: 'landing.val.purposeAssignment' },
      exam: { kind: 'text', key: 'landing.val.purposeExam' },
    },
  },
  {
    labelKey: 'landing.feat.problem',
    cells: {
      casual: { kind: 'na' },
      class: { kind: 'text', key: 'landing.val.problemClass' },
      assignment: { kind: 'na' },
      exam: { kind: 'text', key: 'landing.val.problemExam' },
    },
  },
  {
    labelKey: 'landing.feat.screenshot',
    cells: {
      casual: { kind: 'text', key: 'landing.val.screenshotCasual' },
      class: { kind: 'text', key: 'landing.val.screenshotClass' },
      assignment: { kind: 'text', key: 'landing.val.screenshotAssignment' },
      exam: { kind: 'text', key: 'landing.val.screenshotExam' },
    },
  },
  {
    labelKey: 'landing.feat.seal',
    cells: {
      casual: { kind: 'no' },
      class: { kind: 'no' },
      assignment: { kind: 'no' },
      exam: { kind: 'yes' },
    },
  },
  {
    labelKey: 'landing.feat.assurance',
    cells: {
      casual: { kind: 'text', key: 'landing.val.assuranceCasual' },
      class: { kind: 'text', key: 'landing.val.assuranceClass' },
      assignment: { kind: 'text', key: 'landing.val.assuranceAssignment' },
      exam: { kind: 'text', key: 'landing.val.assuranceExam' },
    },
  },
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

    overlay.querySelectorAll<HTMLElement>('.landing-card-mode').forEach((card) => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode as EditorMode;
        // 入口で一度、利用規約に同意したものとして記録する (各モードはモーダルを再掲しない)。
        markTermsAccepted();
        window.location.assign(`/${mode}`);
      });
    });

    // 進行中セッションのバッジを非同期で埋める (同期描画をブロックしない。IndexedDB は遅延 import)。
    void this.fillSessionBadges(overlay);
  }

  private async fillSessionBadges(overlay: HTMLElement): Promise<void> {
    try {
      const { detectModeSessions } = await import('../../core/SessionDetector.js');
      const sessions = await detectModeSessions();
      for (const mode of ALL_EDITOR_MODES) {
        const info = sessions[mode];
        if (!info) continue;
        const badge = overlay.querySelector<HTMLElement>(`.landing-card-mode[data-mode="${mode}"] .session-badge`);
        if (!badge) continue;
        badge.textContent = `${t('landing.resumeSession')} (${info.tabCount})`;
        badge.hidden = false;
      }
    } catch {
      /* 検出失敗は無視 (バッジが出ないだけ) */
    }
  }

  private renderCell(cell: Cell): string {
    switch (cell.kind) {
      case 'yes':
        return '<span class="lc-feat-val feature-yes" aria-label="yes">✓</span>';
      case 'no':
        return '<span class="lc-feat-val feature-no" aria-label="no">✗</span>';
      case 'na':
        return '<span class="lc-feat-val feature-na" aria-label="n/a">—</span>';
      case 'text':
        return `<span class="lc-feat-val feature-text">${escapeHtml(t(cell.key))}</span>`;
    }
  }

  private card(mode: EditorMode): string {
    const name = escapeHtml(t(`feature.${mode}`));
    const feats = FEATURE_ROWS.map(
      (row) => `
        <li class="lc-feat">
          <span class="lc-feat-label">${escapeHtml(t(row.labelKey))}</span>
          ${this.renderCell(row.cells[mode])}
        </li>`
    ).join('');
    return `
      <div class="landing-card-mode" data-mode="${mode}" role="group" aria-label="${name}">
        <div class="lc-header">
          <span class="lc-icon"><i class="fas ${MODE_ICONS[mode]}" aria-hidden="true"></i></span>
          <span class="lc-name">${name}</span>
          <span class="session-badge" hidden></span>
        </div>
        <p class="lc-desc">${escapeHtml(t(MODE_DESC_KEYS[mode]))}</p>
        <ul class="lc-feats">${feats}</ul>
        <button type="button" class="lc-open" data-mode="${mode}">
          ${escapeHtml(t('landing.start'))} <i class="fas fa-arrow-right" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  private html(): string {
    const cards = ALL_EDITOR_MODES.map((m) => this.card(m)).join('');
    return `
      <div class="landing-content">
        <img src="/icon-192.png" alt="TypedCode" class="landing-logo">
        <h1 class="landing-title">${escapeHtml(t('landing.title'))}</h1>
        <p class="landing-subtitle">${escapeHtml(t('landing.subtitle'))}</p>
        <div class="landing-card-grid">${cards}</div>
        <p class="landing-terms">${escapeHtml(t('landing.termsNotice'))}</p>
      </div>
    `;
  }
}
