/**
 * LogViewerScreenshots - スクリーンショットプレビュー機能
 */

import type { StoredEvent, ScreenshotCaptureData } from '@typedcode/shared';
import type { ScreenshotStorageService } from '../../services/ScreenshotStorageService.js';

/**
 * スクリーンショットエントリを作成
 */
export function createScreenshotEntry(
  event: StoredEvent,
  index: number,
  screenshotStorage: ScreenshotStorageService | null,
  t: (key: string) => string
): HTMLElement {
  const entry = document.createElement('div');
  entry.className = 'log-entry log-entry-screenshot log-type-screenshotCapture';

  // ヘッダー行
  const header = document.createElement('div');
  header.className = 'log-entry-header';

  const indexEl = document.createElement('span');
  indexEl.className = 'log-entry-index';
  indexEl.textContent = `#${index + 1}`;

  const timeEl = document.createElement('span');
  timeEl.className = 'log-entry-time';
  timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;

  // 展開アイコン
  const expandIcon = document.createElement('span');
  expandIcon.className = 'log-entry-expand-icon';
  expandIcon.textContent = '▶';

  // スクリーンショットアイコン
  const iconEl = document.createElement('span');
  iconEl.className = 'log-entry-screenshot-icon';
  iconEl.textContent = '📷';

  const infoContainer = document.createElement('div');
  infoContainer.style.flex = '1';
  infoContainer.style.minWidth = '0';
  infoContainer.style.overflow = 'hidden';
  infoContainer.style.textOverflow = 'ellipsis';
  infoContainer.style.whiteSpace = 'nowrap';

  const typeEl = document.createElement('span');
  typeEl.className = 'log-entry-type';
  typeEl.textContent = 'Screenshot';

  const descEl = document.createElement('span');
  descEl.className = 'log-entry-description';
  descEl.textContent = event.description ?? t('screenCapture.captured');

  infoContainer.appendChild(typeEl);
  infoContainer.appendChild(descEl);

  header.appendChild(indexEl);
  header.appendChild(timeEl);
  header.appendChild(expandIcon);
  header.appendChild(iconEl);
  header.appendChild(infoContainer);

  entry.appendChild(header);

  // 詳細情報（画像ハッシュ、サイズなど）
  const data = event.data as ScreenshotCaptureData | undefined;
  if (data) {
    const detailsLine = document.createElement('div');
    detailsLine.className = 'log-entry-details';
    const parts: string[] = [];

    if (data.captureType) {
      parts.push(`Type: ${data.captureType}`);
    }
    if (data.displayInfo) {
      parts.push(`${data.displayInfo.width}x${data.displayInfo.height}`);
    }
    if (data.fileSizeBytes) {
      const kb = (data.fileSizeBytes / 1024).toFixed(1);
      parts.push(`${kb}KB`);
    }

    detailsLine.textContent = parts.join(' | ');
    entry.appendChild(detailsLine);

    // 画像プレビューコンテナ（初期は非表示）
    if (data.storageKey && screenshotStorage) {
      const previewContainer = document.createElement('div');
      previewContainer.className = 'log-entry-screenshot-preview';

      const img = document.createElement('img');
      img.className = 'log-entry-screenshot-image';
      img.alt = 'Screenshot';

      const imgInfo = document.createElement('div');
      imgInfo.className = 'log-entry-screenshot-info';

      previewContainer.appendChild(img);
      previewContainer.appendChild(imgInfo);
      entry.appendChild(previewContainer);

      // クリックで展開/折りたたみ
      entry.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        toggleScreenshotPreview(entry, data.storageKey, img, imgInfo, expandIcon, screenshotStorage);
      });
    }
  }

  // ハッシュ（ホバー時のみ表示）
  if (event.hash) {
    const hashEl = document.createElement('div');
    hashEl.className = 'log-entry-hash';
    hashEl.textContent = `${event.hash.substring(0, 16)}...`;
    hashEl.title = event.hash;
    entry.appendChild(hashEl);
  }

  return entry;
}

/**
 * スクリーンショットプレビューの展開/折りたたみを切り替え
 */
async function toggleScreenshotPreview(
  entry: HTMLElement,
  storageKey: string,
  img: HTMLImageElement,
  infoEl: HTMLElement,
  expandIcon: HTMLElement,
  screenshotStorage: ScreenshotStorageService
): Promise<void> {
  const isExpanded = entry.classList.contains('expanded');

  if (isExpanded) {
    // 折りたたむ
    entry.classList.remove('expanded');
    expandIcon.textContent = '▶';

    // Blob URLを解放
    if (img.src.startsWith('blob:')) {
      URL.revokeObjectURL(img.src);
      img.src = '';
    }
  } else {
    // 展開する
    try {
      const screenshot = await screenshotStorage.getById(storageKey);
      if (!screenshot) {
        // スクリーンショットが見つからない場合（リロード等でIndexedDBがクリアされた）
        // エラーメッセージを表示
        infoEl.textContent = 'Screenshot unavailable (data lost after reload)';
        infoEl.style.color = 'var(--vscode-errorForeground, #f48771)';
        entry.classList.add('expanded');
        expandIcon.textContent = '▼';
        return;
      }

      // Blob URLを作成
      const blobUrl = URL.createObjectURL(screenshot.imageBlob);
      img.src = blobUrl;

      // 情報を表示
      const capturedAt = new Date(screenshot.createdAt).toLocaleString();
      infoEl.textContent = `${screenshot.displayInfo.width}×${screenshot.displayInfo.height} | ${capturedAt}`;

      entry.classList.add('expanded');
      expandIcon.textContent = '▼';
    } catch (error) {
      console.error('[LogViewerScreenshots] Failed to load screenshot:', error);
    }
  }
}

/**
 * 展開中のスクリーンショットのBlob URLを解放
 */
export function disposeScreenshotPreviews(container: HTMLElement): void {
  const expandedEntries = container.querySelectorAll('.log-entry-screenshot.expanded');
  expandedEntries.forEach((entry) => {
    const img = entry.querySelector('.log-entry-screenshot-image') as HTMLImageElement;
    if (img && img.src.startsWith('blob:')) {
      URL.revokeObjectURL(img.src);
    }
  });
}
