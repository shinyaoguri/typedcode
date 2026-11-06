/**
 * editor (index.html) のエントリ (#302)。
 *
 * ルート (#644) だけを先に決め、未知パスでは NotFoundPage の DOM だけを描く。`/` と `/casual` は練習の
 * エディタ、`/class` `/assignment` `/exam` はそれぞれのモードのエディタを開く。
 * エディタ本体 (`main.ts`: Monaco・トラッカー・実行系・xterm・Wasmer) は not-found 以外でだけ
 * dynamic import する。Vite は dynamic import 先を `modulepreload` しないので、not-found ではそれらの
 * chunk を 1 つも取得しない (`packages/e2e/tests/production-build.spec.ts` が見張る)。
 *
 * **ここから `main.ts` やその依存を静的 import しない**。not-found の初期ロードに乗ってしまう。
 */

import './styles/main.css';
import { BaseThemeManager } from '@typedcode/shared';
import { resolveRoute } from './core/mode.js';
import { setAppState } from './core/stateContract.js';
import { initDOMi18n } from './i18n/index.js';
import { NotFoundPage } from './ui/components/NotFoundPage.js';
import { showBootFailure } from './app/bootFailure.js';
// 型と定数だけを使う (ThemeManager.ts は Monaco を型でしか参照しない)
import { EDITOR_THEME_OPTIONS } from './editor/ThemeManager.js';

function bootNotFound(): void {
  // not-found はモードを持たない。アクセント色の既定は casual に置く (main.ts の既定と同じ値)
  document.documentElement.setAttribute('data-feature', 'editor');
  document.documentElement.setAttribute('data-mode', 'casual');
  // テーマ (html[data-theme]) は editor では ThemeManager (Monaco 連携付き) が付ける。not-found は Monaco を
  // 持たないので、同じ設定の BaseThemeManager で付ける
  new BaseThemeManager(EDITOR_THEME_OPTIONS);
  initDOMi18n();
  setAppState('not-found');
  new NotFoundPage().render();
}

if (resolveRoute(window.location.pathname) === 'not-found') {
  // module script は defer 相当なので普段は解析済みだが、念のため DOM を待つ (以前の boot() と同じ)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootNotFound, { once: true });
  } else {
    bootNotFound();
  }
} else {
  // 状態契約 (packages/editor/AGENTS.md「状態契約」): main の chunk が届くまでの間も段階を出しておく
  setAppState('initializing');
  // chunk の取得失敗や main の top-level の例外でも、スピナーのまま止めずにエラー画面を出す (#325)
  import('./main.js').catch((error: unknown) => showBootFailure(error));
}
