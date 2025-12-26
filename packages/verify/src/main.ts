/**
 * TypedCode 証明検証ページ
 *
 * モジュール構成:
 * - types.ts: 型定義
 * - elements.ts: DOM要素のキャッシュ
 * - ui.ts: UI関連（ローディング、ステータス表示など）
 * - charts.ts: チャート描画関連
 * - seekbar.ts: シークバー機能
 * - verification.ts: 検証ロジック
 */

import type { ProofFile } from './types.js';
import {
  dropZone,
  fileInput,
  resultSection,
  typingProofHashEl,
  copyHashBtn,
  verifyAgainBtn,
} from './elements.js';
import {
  showDropZoneLoading,
  addLoadingLog,
  updateLoadingLog,
  resetDropZoneLoading,
  hideDropZone,
  showDropZone,
  showError,
} from './ui.js';
import { initializeSeekbarListeners } from './seekbar.js';
import { verifyProofData } from './verification.js';

// ファイル処理
async function handleFile(file: File): Promise<void> {
  if (!file.name.endsWith('.json')) {
    alert('JSONファイルを選択してください');
    return;
  }

  // 即座にローディング状態を表示
  showDropZoneLoading(file.name);

  // ファイル読み込みログ
  const readLog = addLoadingLog('ファイルを読み込み中...');

  try {
    const text = await file.text();
    const fileSize = (text.length / 1024).toFixed(1);
    updateLoadingLog(readLog, 'success', `ファイル読み込み完了 (${fileSize} KB)`);

    // JSON解析ログ
    const parseLog = addLoadingLog('JSONを解析中...');
    const proofData = JSON.parse(text) as ProofFile;
    const eventCount = proofData.proof?.events?.length ?? 0;
    updateLoadingLog(parseLog, 'success', `JSON解析完了 (${eventCount} イベント)`);

    await verifyProofData(proofData);
    // 検証完了後、ドロップゾーンを非表示
    hideDropZone();
  } catch (error) {
    console.error('[Verify] Error reading file:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    addLoadingLog(`エラー: ${errorMessage}`, 'error');
    showError('ファイルの読み込みに失敗しました', errorMessage);
    // エラー時はドロップゾーンを復元（少し待ってから）
    setTimeout(() => resetDropZoneLoading(handleFile), 2000);
  }
}

// ドラッグ&ドロップイベント
if (dropZone) {
  const zone = dropZone;
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      void handleFile(files[0]!);
    }
  });
}

// ファイル選択
fileInput?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files.length > 0) {
    void handleFile(target.files[0]!);
  }
});

// ハッシュのコピー
if (copyHashBtn) {
  const btn = copyHashBtn;
  btn.addEventListener('click', async () => {
    const hash = typingProofHashEl?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(hash);
      const originalText = btn.textContent;
      btn.textContent = '✅ コピーしました！';
      setTimeout(() => {
        btn.textContent = originalText;
      }, 2000);
    } catch (error) {
      console.error('[Verify] Copy failed:', error);
      alert('コピーに失敗しました');
    }
  });
}

// 再検証ボタン
verifyAgainBtn?.addEventListener('click', () => {
  if (resultSection) resultSection.style.display = 'none';
  showDropZone(handleFile);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// シークバーのイベントリスナーを初期化
initializeSeekbarListeners();
