/**
 * TypedCode 証明検証ページ - エントリポイント
 *
 * モジュール構成:
 * - config/: 設定・検証タイプ定義
 * - core/: 検証エンジン・コンテキスト
 * - services/: ファイル処理・API呼び出し
 * - state/: タブ管理、検証キュー、チャート状態
 * - ui/: コントローラー、パネル、ステータスバー
 * - charts/: チャート描画
 */

import { dropZone, fileInput } from './elements.js';
import { PageController } from './ui/controllers/PageController.js';

// DOM要素の取得
const elements = {
  dropZone,
  fileInput,
  fileInput2: document.getElementById('file-input-2') as HTMLInputElement | null,
  dropZoneSection: document.getElementById('drop-zone-section'),
  verifyMain: document.getElementById('verify-main'),
  verifyFileList: document.getElementById('verify-file-list'),
  verifySidebar: document.getElementById('verify-sidebar'),
  resizeHandle: document.getElementById('resize-handle'),
  verifyStatusbar: document.getElementById('verify-statusbar'),
  tabContentLoading: document.getElementById('tab-content-loading'),
  resultSection: document.getElementById('result-section'),
  tabTimeline: document.getElementById('tab-timeline'),
  tabMouse: document.getElementById('tab-mouse'),
  panelTimeline: document.getElementById('panel-timeline'),
  panelMouse: document.getElementById('panel-mouse'),
};

// PageControllerを初期化
const pageController = new PageController(elements);
pageController.initialize();
