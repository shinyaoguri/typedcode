import type { ScreenId } from './uiTour.js';

/**
 * axe の既知違反の基準 (#728)。`helpers/a11y.ts` がこれと突き合わせ、ここに無い違反が出たら落とす。
 *
 * - 1 行 = 「rule id + 対象 (axe が返す CSS セレクタ)」と、それが出てよい画面 (`screens`)。
 *   同じ違反でも、載せていない画面で出たら新しい違反として落ちる
 * - `issue` は直す Issue の番号。起票前のものは null (番号が決まったら埋める)。直したら行ごと消す
 *   (消し忘れても落ちず、テストの annotation `a11y-resolved` と出力で知らせる)
 * - 違反を増やして緑にするための rule の無効化・impact での足切りはしない。足すのは「既知の製品の不具合」で、
 *   Issue に紐づけられるものだけ
 * - 作り直しの手順は packages/e2e/README.md の「a11y・i18n・レイアウトの検査」
 *
 * 基準は外部への通信を止めた状態 (helpers/uiTour.ts の walkTour) と表示言語 en で取ったもの。
 * a11y-axe.spec.ts も en に固定している。セレクタは title などの文言に依存させない (id か data-* で指す。#739)。
 */

export interface KnownA11yViolation {
  rule: string;
  target: string;
  screens: readonly ScreenId[];
  issue: number | null;
}

/** editor のすべての画面 (titlebar / statusbar を共有する) */
const EDITOR_SCREENS: readonly ScreenId[] = [
  'casual-ready',
  'casual-about',
  'casual-self-review',
  'class-screen-share-choice',
  'class-welcome',
  'class-problem-loader',
  'class-ready',
  'assignment-welcome',
  'assignment-ready',
  'exam-gate',
  'exam-ready',
];

export const KNOWN_A11Y_VIOLATIONS: readonly KnownA11yViolation[] = [
  // color-contrast (serious): 文字と背景のコントラスト不足 (WCAG 1.4.3。ダイアログの背後で暗くなった要素を含む)
  { rule: 'color-contrast', target: '#class-loader-filename', screens: ['class-problem-loader'], issue: 737 },
  { rule: 'color-contrast', target: '#current-hash', screens: ['class-ready', 'assignment-ready'], issue: 737 },
  { rule: 'color-contrast', target: '#exam-gate-filename', screens: ['exam-gate'], issue: 737 },
  { rule: 'color-contrast', target: '#file-count > span', screens: ['verify-initial', 'verify-result'], issue: 737 },
  {
    rule: 'color-contrast',
    target: '#language-selector',
    screens: ['class-welcome', 'class-problem-loader', 'assignment-welcome'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '#proof-status',
    screens: [
      'class-screen-share-choice',
      'class-welcome',
      'class-problem-loader',
      'class-ready',
      'assignment-welcome',
      'assignment-ready',
    ],
    issue: 737,
  },
  { rule: 'color-contrast', target: '#queue-status > span', screens: ['verify-initial', 'verify-result'], issue: 737 },
  {
    rule: 'color-contrast',
    target: '#runtime-state-indicator',
    screens: ['class-welcome', 'class-problem-loader', 'assignment-welcome'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '#sync-status',
    screens: [
      'class-welcome',
      'class-problem-loader',
      'class-ready',
      'assignment-welcome',
      'assignment-ready',
      'exam-ready',
    ],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(1) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(2) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(3) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(4) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(5) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.about-info-row:nth-child(6) > .about-info-label',
    screens: ['casual-about'],
    issue: 737,
  },
  { rule: 'color-contrast', target: '.about-version', screens: ['casual-about'], issue: 737 },
  {
    rule: 'color-contrast',
    target: '.choice-option-secondary > .choice-content > .choice-subtitle',
    screens: ['class-screen-share-choice'],
    issue: 737,
  },
  { rule: 'color-contrast', target: '.feature-badge', screens: ['verify-initial', 'verify-result'], issue: 737 },
  {
    rule: 'color-contrast',
    target: '.mode-badge-label',
    screens: [
      'class-screen-share-choice',
      'class-welcome',
      'class-problem-loader',
      'class-ready',
      'assignment-welcome',
      'assignment-ready',
    ],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.terms-notice-ok',
    screens: ['casual-ready', 'casual-about', 'casual-self-review'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: '.welcome-actions > h2',
    screens: ['class-welcome', 'class-problem-loader', 'assignment-welcome'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'div[data-active="false"] > .tab-extension',
    screens: ['class-ready', 'assignment-ready'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'div[data-active="false"] > .tab-filename',
    screens: ['class-ready', 'assignment-ready'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'p[data-i18n-html="sidebar.emptyMessage"]',
    screens: ['verify-initial'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'span[data-axis="integrity"] > .assurance-chip-value',
    screens: ['verify-result'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'span[data-axis="temporal"] > .assurance-chip-value',
    screens: ['verify-result'],
    issue: 737,
  },
  { rule: 'color-contrast', target: 'span[data-i18n="charts.integrated"]', screens: ['verify-result'], issue: 737 },
  {
    rule: 'color-contrast',
    target: 'span[data-i18n="statusBar.column"]',
    screens: ['class-welcome', 'class-problem-loader', 'assignment-welcome'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'span[data-i18n="statusBar.events"]',
    screens: ['class-welcome', 'class-problem-loader', 'class-ready', 'assignment-welcome', 'assignment-ready'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'span[data-i18n="statusBar.line"]',
    screens: ['class-welcome', 'class-problem-loader', 'assignment-welcome'],
    issue: 737,
  },
  {
    rule: 'color-contrast',
    target: 'span[data-i18n="welcome.browseButton"]',
    screens: ['verify-initial'],
    issue: 737,
  },
];
