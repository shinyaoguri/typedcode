import type { StoredEvent } from '@typedcode/shared';
import type { ContentCache } from './types.js';
import {
  floatingSeekbar,
  seekbarSlider,
  seekbarProgress,
  seekbarTime,
  seekbarEventCount,
  seekbarStart,
  seekbarPrev,
  seekbarPlay,
  playIcon,
  seekbarNext,
  seekbarEnd,
  contentPreview,
} from './elements.js';
import {
  drawIntegratedTimeline,
  updateIntegratedTimelineMarker,
  updateMouseTrajectoryMarker,
  showIntegratedTimeline,
  getIntegratedTimelineCache,
} from './charts.js';

// シークバー用のグローバル状態
let currentEvents: StoredEvent[] = [];
let currentEventIndex = 0;
let isPlaying = false;
let playInterval: ReturnType<typeof setInterval> | null = null;
let finalContent = '';

// コンテンツキャッシュ
const contentCache: ContentCache = new Map();

/**
 * 現在のイベント配列を取得
 */
export function getCurrentEvents(): StoredEvent[] {
  return currentEvents;
}

/**
 * 現在のイベントインデックスを取得
 */
export function getCurrentEventIndex(): number {
  return currentEventIndex;
}

/**
 * シークバーを初期化
 */
export function initializeSeekbar(events: StoredEvent[], content: string): void {
  if (!events || events.length === 0) {
    return;
  }

  currentEvents = events;
  finalContent = content ?? '';
  currentEventIndex = events.length;
  contentCache.clear();
  showIntegratedTimeline();

  // フローティングシークバーを表示
  if (floatingSeekbar) {
    floatingSeekbar.style.display = 'block';
    document.body.classList.add('has-floating-seekbar');
  }

  if (seekbarSlider) {
    seekbarSlider.max = String(events.length);
    seekbarSlider.value = String(events.length);
  }

  updateSeekbarUI();

  // 統合タイムラインを描画（初期状態）
  drawIntegratedTimeline(events, currentEvents);

  // 初期状態のマーカーを描画（最終位置）
  setTimeout(() => {
    updateIntegratedTimelineMarker(currentEventIndex, currentEvents);
    updateMouseTrajectoryMarker(currentEventIndex, currentEvents);
  }, 100);
}

/**
 * 指定したインデックスまでのコンテンツを再構築（キャッシュ付き）
 */
function getContentAtIndex(index: number): string {
  if (contentCache.has(index)) {
    return contentCache.get(index)!;
  }

  if (index === 0) {
    const content = '';
    contentCache.set(index, content);
    return content;
  }

  if (index === currentEvents.length) {
    contentCache.set(index, finalContent);
    return finalContent;
  }

  let startIndex = 0;
  let lines: string[] = [''];

  for (let i = index - 1; i >= 0; i--) {
    if (contentCache.has(i)) {
      startIndex = i;
      lines = contentCache.get(i)!.split('\n');
      break;
    }
  }

  for (let i = startIndex; i < index && i < currentEvents.length; i++) {
    const event = currentEvents[i];
    if (!event) continue;

    if (event.type === 'contentSnapshot') {
      const data = typeof event.data === 'string' ? event.data : '';
      lines = data.split('\n');
      continue;
    }

    if (event.type === 'contentChange' && event.range) {
      const { startLineNumber, startColumn, endLineNumber, endColumn } = event.range;
      const text = typeof event.data === 'string' ? event.data : '';

      while (lines.length < endLineNumber) {
        lines.push('');
      }

      if (startLineNumber === endLineNumber) {
        const line = lines[startLineNumber - 1] ?? '';
        const before = line.substring(0, startColumn - 1);
        const after = line.substring(endColumn - 1);

        const newText = before + text + after;
        const newLines = newText.split('\n');

        lines.splice(startLineNumber - 1, 1, ...newLines);
      } else {
        const startLine = lines[startLineNumber - 1] ?? '';
        const endLine = lines[endLineNumber - 1] ?? '';
        const before = startLine.substring(0, startColumn - 1);
        const after = endLine.substring(endColumn - 1);

        const newText = before + text + after;
        const newLines = newText.split('\n');

        const deleteCount = endLineNumber - startLineNumber + 1;
        lines.splice(startLineNumber - 1, deleteCount, ...newLines);
      }
    }
  }

  const content = lines.join('\n');
  contentCache.set(index, content);
  return content;
}

/**
 * 特定のイベントインデックスまでコードを再構築
 */
function reconstructCodeAtIndex(index: number): void {
  const content = getContentAtIndex(index);
  const lines = content.split('\n');
  const preview = lines.slice(0, 100).join('\n');
  if (contentPreview) {
    contentPreview.textContent = preview + (lines.length > 100 ? '\n...' : '');
  }
}

/**
 * 時間をフォーマット (m:ss)
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * シークバーUIを更新
 */
function updateSeekbarUI(): void {
  if (currentEvents.length === 0) return;

  const lastEvent = currentEvents[currentEvents.length - 1];
  const totalTime = lastEvent?.timestamp ?? 0;
  const currentEvent = currentEventIndex > 0 && currentEventIndex <= currentEvents.length
    ? currentEvents[currentEventIndex - 1]
    : null;
  const currentTime = currentEvent?.timestamp ?? 0;

  // 時間表示を更新
  if (seekbarTime) {
    seekbarTime.textContent = `${formatTime(currentTime)} / ${formatTime(totalTime)}`;
  }

  // イベント数表示を更新
  if (seekbarEventCount) {
    seekbarEventCount.textContent = `${currentEventIndex} / ${currentEvents.length} events`;
  }

  // プログレスバーを更新
  if (seekbarProgress && currentEvents.length > 0) {
    const progress = (currentEventIndex / currentEvents.length) * 100;
    seekbarProgress.style.width = `${progress}%`;
  }
}

/**
 * 指定インデックスにシーク
 */
function seekToIndex(index: number): void {
  currentEventIndex = Math.max(0, Math.min(index, currentEvents.length));
  if (seekbarSlider) seekbarSlider.value = String(currentEventIndex);
  updateSeekbarUI();
  reconstructCodeAtIndex(currentEventIndex);
  updateMouseTrajectoryMarker(currentEventIndex, currentEvents);
  // 統合タイムラインのマーカーを更新（再描画して位置マーカーを表示）
  if (getIntegratedTimelineCache() && currentEvents.length > 0) {
    drawIntegratedTimeline(currentEvents, currentEvents);
    updateIntegratedTimelineMarker(currentEventIndex, currentEvents);
  }
}

/**
 * 自動再生を開始
 */
function startPlayback(): void {
  if (currentEventIndex >= currentEvents.length) {
    currentEventIndex = 0;
  }

  isPlaying = true;
  if (playIcon) {
    playIcon.className = 'fas fa-pause';
  }
  if (seekbarPlay) {
    seekbarPlay.title = '一時停止';
  }

  playInterval = setInterval(() => {
    if (currentEventIndex >= currentEvents.length) {
      stopPlayback();
      return;
    }

    seekToIndex(currentEventIndex + 1);
  }, 200);
}

/**
 * 自動再生を停止
 */
function stopPlayback(): void {
  isPlaying = false;
  if (playIcon) {
    playIcon.className = 'fas fa-play';
  }
  if (seekbarPlay) {
    seekbarPlay.title = '自動再生';
  }

  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
}

/**
 * シークバーのイベントリスナーを初期化
 */
export function initializeSeekbarListeners(): void {
  seekbarSlider?.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    seekToIndex(parseInt(target.value, 10));
  });

  seekbarStart?.addEventListener('click', () => {
    stopPlayback();
    seekToIndex(0);
  });

  seekbarPrev?.addEventListener('click', () => {
    stopPlayback();
    seekToIndex(currentEventIndex - 1);
  });

  seekbarNext?.addEventListener('click', () => {
    stopPlayback();
    seekToIndex(currentEventIndex + 1);
  });

  seekbarEnd?.addEventListener('click', () => {
    stopPlayback();
    seekToIndex(currentEvents.length);
  });

  seekbarPlay?.addEventListener('click', () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });
}
