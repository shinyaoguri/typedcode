import type { LoadingLog } from './types.js';
import {
  dropZone,
  dropZoneSection,
  statusCard,
  statusIcon,
  statusTitle,
  statusMessage,
} from './elements.js';

// ローディングログ状態
export const loadingLog: LoadingLog = {
  container: null,
  logList: null,
  startTime: 0,
};

/**
 * ドロップゾーンにローディング状態を表示
 */
export function showDropZoneLoading(fileName: string): void {
  if (dropZone) {
    dropZone.classList.add('loading');
    const content = dropZone.querySelector('.drop-zone-content');
    if (content) {
      content.innerHTML = `
        <div class="loading-header">
          <div class="loading-spinner-small"></div>
          <h2>検証中...</h2>
        </div>
        <p class="loading-filename">${fileName}</p>
        <div class="loading-log-container">
          <ul class="loading-log-list"></ul>
        </div>
      `;
      loadingLog.container = content.querySelector('.loading-log-container');
      loadingLog.logList = content.querySelector('.loading-log-list');
      loadingLog.startTime = performance.now();
    }
  }
}

/**
 * ローディングログにエントリを追加
 */
export function addLoadingLog(message: string, status: 'pending' | 'success' | 'error' = 'pending'): HTMLElement {
  const elapsed = ((performance.now() - loadingLog.startTime) / 1000).toFixed(2);
  const li = document.createElement('li');
  li.className = `loading-log-entry ${status}`;

  const icon = status === 'pending' ? '⏳' : status === 'success' ? '✓' : '✗';
  li.innerHTML = `
    <span class="log-icon">${icon}</span>
    <span class="log-message">${message}</span>
    <span class="log-time">${elapsed}s</span>
  `;

  loadingLog.logList?.appendChild(li);

  // 自動スクロール
  if (loadingLog.container) {
    loadingLog.container.scrollTop = loadingLog.container.scrollHeight;
  }

  return li;
}

/**
 * ローディングログにエントリを追加（ハッシュ表示付き）
 */
export function addLoadingLogWithHash(message: string): HTMLElement {
  const elapsed = ((performance.now() - loadingLog.startTime) / 1000).toFixed(2);
  const li = document.createElement('li');
  li.className = 'loading-log-entry pending hash-entry';

  li.innerHTML = `
    <span class="log-icon">⏳</span>
    <span class="log-message">${message}</span>
    <span class="log-time">${elapsed}s</span>
    <div class="log-hash-display"></div>
  `;

  loadingLog.logList?.appendChild(li);

  // 自動スクロール
  if (loadingLog.container) {
    loadingLog.container.scrollTop = loadingLog.container.scrollHeight;
  }

  return li;
}

/**
 * ローディングログのステータスを更新
 */
export function updateLoadingLog(entry: HTMLElement, status: 'success' | 'error', message?: string): void {
  const elapsed = ((performance.now() - loadingLog.startTime) / 1000).toFixed(2);
  entry.className = `loading-log-entry ${status}`;

  const icon = status === 'success' ? '✓' : '✗';
  const iconEl = entry.querySelector('.log-icon');
  const timeEl = entry.querySelector('.log-time');

  if (iconEl) iconEl.textContent = icon;
  if (timeEl) timeEl.textContent = `${elapsed}s`;
  if (message) {
    const msgEl = entry.querySelector('.log-message');
    if (msgEl) msgEl.textContent = message;
  }
}

/**
 * ドロップゾーンのローディング状態を解除
 */
export function resetDropZoneLoading(onFileChange: (file: File) => void): void {
  if (dropZone) {
    dropZone.classList.remove('loading');
    const content = dropZone.querySelector('.drop-zone-content');
    if (content) {
      content.innerHTML = `
        <div class="icon">📁</div>
        <h2>証明ファイルをドロップ</h2>
        <p>typedcode-proof-*.json をドラッグ&ドロップ</p>
        <p class="or-text">または</p>
        <label for="file-input" class="file-input-label">
          <input type="file" id="file-input" accept=".json" style="display: none;">
          ファイルを選択
        </label>
      `;
      // ファイル入力のイベントリスナーを再設定
      const newFileInput = document.getElementById('file-input') as HTMLInputElement | null;
      newFileInput?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.files && target.files.length > 0) {
          onFileChange(target.files[0]!);
        }
      });
    }
  }
}

/**
 * ドロップゾーンを非表示にする
 */
export function hideDropZone(): void {
  if (dropZoneSection) {
    dropZoneSection.style.display = 'none';
  }
}

/**
 * ドロップゾーンを表示する
 */
export function showDropZone(onFileChange: (file: File) => void): void {
  if (dropZoneSection) {
    dropZoneSection.style.display = 'block';
  }
  resetDropZoneLoading(onFileChange);
}

/**
 * 検証中表示
 */
export function showVerifying(): void {
  if (statusCard) statusCard.className = 'status-card verifying';
  if (statusIcon) statusIcon.textContent = '⏳';
  if (statusTitle) statusTitle.textContent = '検証中...';
  if (statusMessage) statusMessage.textContent = 'タイピング証明データを検証しています';
}

/**
 * 成功表示
 */
export function showSuccess(message: string): void {
  if (statusCard) statusCard.className = 'status-card success';
  if (statusIcon) statusIcon.textContent = '✅';
  if (statusTitle) statusTitle.textContent = '検証成功';
  if (statusMessage) statusMessage.textContent = message;
}

/**
 * 警告表示
 */
export function showWarning(message: string): void {
  if (statusCard) statusCard.className = 'status-card warning';
  if (statusIcon) statusIcon.textContent = '⚠️';
  if (statusTitle) statusTitle.textContent = '警告';
  if (statusMessage) statusMessage.textContent = message;
}

/**
 * エラー表示
 */
export function showError(title: string, message: string): void {
  if (statusCard) statusCard.className = 'status-card error';
  if (statusIcon) statusIcon.textContent = '❌';
  if (statusTitle) statusTitle.textContent = title;
  if (statusMessage) statusMessage.textContent = message;
}
