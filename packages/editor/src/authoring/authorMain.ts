/**
 * `/author` ページのエントリ (#80)。教員向けの作問画面を mount する。
 *
 * ADR-0012 改良 / ADR-0051: 教材フォルダのファイル (問題文・初期コード・ヒント・解答例・ケース) を Monaco で編集し、
 * コードは editor と同じ実行系で動作確認できる。proof/tracking 機構は使わない (authoring は proof を記録しない) ので、
 * Monaco / 実行系 / xterm を**単体で**再利用する (proof 密結合の TabManager / EditorController は使わない)。
 */

import '@xterm/xterm/css/xterm.css';
import '../styles/author.css';
import { configureMonacoWorkers } from '../config/MonacoConfig.js';
import { initDOMi18n } from '../i18n/index.js';
import { AuthorPage } from './AuthorPage.js';

// テーマ適用 (編集アプリと同じ localStorage キーを尊重。既定 dark)。
const theme = localStorage.getItem('typedcode-theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);
// 機能別アクセント (要望: ぱっと見で機能を判別)。出題アプリ = 紫。
document.documentElement.setAttribute('data-feature', 'author');

configureMonacoWorkers();
initDOMi18n();

const root = document.getElementById('author-root');
const page = root ? new AuthorPage(root) : null;
page?.mount();

// E2E テスト専用フック (dev ビルドのみ。本番では import.meta.env.DEV=false でガードごと除去され、
// dynamic import も残らない)。OPFS のハンドルを教材フォルダとして画面に開かせる (#795 / #796)。
if (import.meta.env.DEV) {
  void import('./workspace/devWorkspaceHook.js').then((hook) => hook.installAuthorWorkspaceHook(page));
}
