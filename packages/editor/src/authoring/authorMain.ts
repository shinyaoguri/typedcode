/**
 * `/author` ページのエントリ (#80)。Monaco / エディタは読み込まず、出題者オーサリング UI
 * だけを mount する軽量ページ。テーマは localStorage の編集アプリと共有 (data-theme)。
 */

import '../styles/author.css';
import { initDOMi18n } from '../i18n/index.js';
import { AuthorPage } from './AuthorPage.js';

// テーマ適用 (編集アプリと同じ localStorage キーを尊重。既定 dark)。
const theme = localStorage.getItem('typedcode-theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);

initDOMi18n();

const root = document.getElementById('author-root');
if (root) {
  new AuthorPage(root).mount();
}
