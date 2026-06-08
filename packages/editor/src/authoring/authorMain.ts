/**
 * `/author` ページのエントリ (#80)。教員向けオーサリング UI を mount する。
 *
 * ADR-0012 改良: 問題文/スターターコードを Monaco で編集し、スターターは Cコンパイラで
 * 動作確認できる editor ライクな環境にする。proof/tracking 機構は使わない (authoring は
 * proof を記録しない) ので、Monaco / C executor / xterm を**単体で**再利用する
 * (proof 密結合の TabManager / EditorController は使わない)。
 */

import '../styles/author.css';
import { configureMonacoWorkers } from '../config/MonacoConfig.js';
import { initDOMi18n } from '../i18n/index.js';
import { AuthorPage } from './AuthorPage.js';

// テーマ適用 (編集アプリと同じ localStorage キーを尊重。既定 dark)。
const theme = localStorage.getItem('typedcode-theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);

configureMonacoWorkers();
initDOMi18n();

const root = document.getElementById('author-root');
if (root) {
  new AuthorPage(root).mount();
}
