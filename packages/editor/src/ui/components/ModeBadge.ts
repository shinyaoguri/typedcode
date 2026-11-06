/**
 * ModeBadge (#644) — titlebar に今のモード名とアイコンを出すだけの表示。
 *
 * 以前の ModeSwitcher (ADR-0015) は押すと 4 モードのメニューを開き、別モードへ移れた。#643 で
 * 「モードは学生が選ぶものではなく、配布物と教員のリンクが決める」としたので、ここは今の場所を示すだけにする
 * (ボタンでもメニューでもない。押しても何も起きない)。見た目は既存の `.feature-badge` (機能バッジ) を使う。
 *
 * 状態契約: `.mode-badge[data-mode]` に今のモード id を出す。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import type { EditorMode } from '../../core/mode.js';

/** 各モードのアイコン (Font Awesome)。色は CSS が html[data-mode] から付ける。 */
const MODE_ICONS: Record<EditorMode, string> = {
  casual: 'fa-pen',
  class: 'fa-chalkboard-user',
  assignment: 'fa-house-laptop',
  exam: 'fa-lock',
};

/** モード表示を作って `parent` (既定は titlebar の左端) に足し、その要素を返す。 */
export function renderModeBadge(
  mode: EditorMode,
  parent: Element | null = document.querySelector('.titlebar-left')
): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'feature-badge mode-badge';
  badge.dataset.mode = mode;
  badge.innerHTML = `<i class="fas ${MODE_ICONS[mode]}" aria-hidden="true"></i><span class="mode-badge-label">${escapeHtml(
    t(`feature.${mode}`)
  )}</span>`;
  parent?.appendChild(badge);
  return badge;
}
