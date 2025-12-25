import { TypingProof } from './typingProof.js';
import type {
  ExportedProof,
  StoredEvent,
  ContentCache,
  InputType,
} from './types.js';

// Extended proof data with content and language
interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

// DOM要素
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
const resultSection = document.getElementById('result-section');
const statusCard = document.getElementById('status-card');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');

// 結果表示要素
const typingProofHashEl = document.getElementById('typing-proof-hash');
const copyHashBtn = document.getElementById('copy-hash-btn');
const pureTypingBadge = document.getElementById('pure-typing-badge');
const pasteInfo = document.getElementById('paste-info');
const deviceIdEl = document.getElementById('device-id');
const totalEventsEl = document.getElementById('total-events');
const insertEventsEl = document.getElementById('insert-events');
const deleteEventsEl = document.getElementById('delete-events');
const typingTimeEl = document.getElementById('typing-time');
const typingSpeedEl = document.getElementById('typing-speed');
const chainValidBadge = document.getElementById('chain-valid-badge');
const chainMessage = document.getElementById('chain-message');
const versionEl = document.getElementById('version');
const languageEl = document.getElementById('language');
const timestampEl = document.getElementById('timestamp');
const userAgentEl = document.getElementById('user-agent');
const contentPreview = document.getElementById('content-preview');
const verifyAgainBtn = document.getElementById('verify-again-btn');
const externalInputPreview = document.getElementById('external-input-preview');
const externalInputList = document.getElementById('external-input-list');
const typingSpeedChart = document.getElementById('typing-speed-chart');
const speedChartCanvas = document.getElementById('speed-chart') as HTMLCanvasElement | null;

// シークバー要素
const timeSeekbar = document.getElementById('time-seekbar');
const seekbarSlider = document.getElementById('seekbar-slider') as HTMLInputElement | null;
const seekbarTime = document.getElementById('seekbar-time');
const seekbarEventCount = document.getElementById('seekbar-event-count');
const seekbarStart = document.getElementById('seekbar-start');
const seekbarPrev = document.getElementById('seekbar-prev');
const seekbarPlay = document.getElementById('seekbar-play');
const seekbarNext = document.getElementById('seekbar-next');
const seekbarEnd = document.getElementById('seekbar-end');

// シークバー用のグローバル変数
let currentEvents: StoredEvent[] = [];
let currentEventIndex = 0;
let isPlaying = false;
let playInterval: ReturnType<typeof setInterval> | null = null;
let finalContent = '';

// ドラッグ&ドロップイベント
dropZone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone?.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    void handleFile(files[0]!);
  }
});

// ファイル選択
fileInput?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files.length > 0) {
    void handleFile(target.files[0]!);
  }
});

// ファイル処理
async function handleFile(file: File): Promise<void> {
  if (!file.name.endsWith('.json')) {
    alert('JSONファイルを選択してください');
    return;
  }

  try {
    const text = await file.text();
    const proofData = JSON.parse(text) as ProofFile;
    await verifyProofData(proofData);
  } catch (error) {
    console.error('[Verify] Error reading file:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    showError('ファイルの読み込みに失敗しました', errorMessage);
  }
}

// 証明データの検証
async function verifyProofData(data: ProofFile): Promise<void> {
  if (resultSection) {
    resultSection.style.display = 'block';
    resultSection.scrollIntoView({ behavior: 'smooth' });
  }

  showVerifying();

  try {
    const typingProof = new TypingProof();

    // 1. タイピング証明ハッシュの検証
    let typingHashValid = false;
    let isPureTyping = false;

    if (data.typingProofHash && data.typingProofData && data.content) {
      const hashVerification = await typingProof.verifyTypingProofHash(
        data.typingProofHash,
        data.typingProofData,
        data.content
      );

      typingHashValid = hashVerification.valid;
      isPureTyping = hashVerification.isPureTyping ?? false;

      if (typingProofHashEl) typingProofHashEl.textContent = data.typingProofHash;
      if (copyHashBtn) copyHashBtn.style.display = 'inline-block';

      if (isPureTyping) {
        if (pureTypingBadge) {
          pureTypingBadge.innerHTML = '✅ 純粋なタイピング';
          pureTypingBadge.className = 'badge success';
        }
        if (pasteInfo) pasteInfo.textContent = 'コピー&ペーストは検出されませんでした';
        if (externalInputPreview) externalInputPreview.style.display = 'none';
      } else {
        if (pureTypingBadge) {
          pureTypingBadge.innerHTML = '⚠️ 外部入力あり';
          pureTypingBadge.className = 'badge warning';
        }
        const pasteCount = data.typingProofData.metadata.pasteEvents ?? 0;
        const dropCount = data.typingProofData.metadata.dropEvents ?? 0;
        if (pasteInfo) pasteInfo.textContent = `ペースト: ${pasteCount}回、ドロップ: ${dropCount}回`;

        displayExternalInputs(data.proof.events);
      }

      if (deviceIdEl) {
        deviceIdEl.textContent = data.typingProofData.deviceId.substring(0, 16) + '...';
        deviceIdEl.title = data.typingProofData.deviceId;
      }

      const meta = data.typingProofData.metadata;
      if (totalEventsEl) totalEventsEl.textContent = String(meta.totalEvents);
      if (insertEventsEl) insertEventsEl.textContent = String(meta.insertEvents);
      if (deleteEventsEl) deleteEventsEl.textContent = String(meta.deleteEvents);
      if (typingTimeEl) typingTimeEl.textContent = (meta.totalTypingTime / 1000).toFixed(2) + '秒';
      if (typingSpeedEl) typingSpeedEl.textContent = meta.averageTypingSpeed + ' WPM';
    }

    // 2. ハッシュ鎖の検証
    let chainValid = false;
    let chainError: { message: string } | null = null;

    if (data.proof?.events) {
      typingProof.events = data.proof.events;
      typingProof.currentHash = data.proof.finalHash;

      const chainVerification = await typingProof.verify();
      chainValid = chainVerification.valid;

      if (chainValid) {
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '✅ 有効';
          chainValidBadge.className = 'badge success';
        }
        if (chainMessage) chainMessage.textContent = `全${data.proof.totalEvents}イベントのハッシュ鎖が正常に検証されました`;
        console.log('[Verify] ✅ Hash chain verification passed');
      } else {
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '❌ 無効';
          chainValidBadge.className = 'badge error';
        }
        if (chainMessage) chainMessage.textContent = `エラー: ${chainVerification.message}`;
        chainError = chainVerification;
        console.error('[Verify] ❌ Hash chain verification failed:', chainVerification);

        if (chainVerification.errorAt !== undefined) {
          console.error('[Verify] Error at event index:', chainVerification.errorAt);
          console.error('[Verify] Event data:', chainVerification.event);
        }
      }
    }

    // 3. メタデータ表示
    if (versionEl) versionEl.textContent = data.version ?? '-';
    if (languageEl) languageEl.textContent = data.language ?? '-';
    if (timestampEl) timestampEl.textContent = data.metadata?.timestamp ?? '-';
    if (userAgentEl) userAgentEl.textContent = data.metadata?.userAgent ?? '-';

    // 4. コンテンツプレビュー
    if (data.content && contentPreview) {
      const lines = data.content.split('\n');
      const preview = lines.slice(0, 20).join('\n');
      contentPreview.textContent = preview + (lines.length > 20 ? '\n...' : '');
    }

    // 5. タイピング速度グラフの描画
    if (data.proof?.events) {
      drawTypingSpeedChart(data.proof.events);
    }

    // 6. タイムシークバーの初期化
    if (data.proof?.events) {
      initializeSeekbar(data.proof.events, data.content);
    }

    // 総合判定
    const allValid = typingHashValid && chainValid;

    if (allValid && isPureTyping) {
      showSuccess('✅ 検証成功：純粋なタイピングで作成されたコードです');
    } else if (allValid && !isPureTyping) {
      showWarning('⚠️ 検証成功：コピー&ペーストが含まれています');
    } else {
      showError('❌ 検証失敗', chainError?.message ?? 'ハッシュが一致しません');
    }

  } catch (error) {
    console.error('[Verify] Verification error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    showError('検証中にエラーが発生しました', errorMessage);
  }
}

// 検証中表示
function showVerifying(): void {
  if (statusCard) statusCard.className = 'status-card verifying';
  if (statusIcon) statusIcon.textContent = '⏳';
  if (statusTitle) statusTitle.textContent = '検証中...';
  if (statusMessage) statusMessage.textContent = 'タイピング証明データを検証しています';
}

// 成功表示
function showSuccess(message: string): void {
  if (statusCard) statusCard.className = 'status-card success';
  if (statusIcon) statusIcon.textContent = '✅';
  if (statusTitle) statusTitle.textContent = '検証成功';
  if (statusMessage) statusMessage.textContent = message;
}

// 警告表示
function showWarning(message: string): void {
  if (statusCard) statusCard.className = 'status-card warning';
  if (statusIcon) statusIcon.textContent = '⚠️';
  if (statusTitle) statusTitle.textContent = '警告';
  if (statusMessage) statusMessage.textContent = message;
}

// エラー表示
function showError(title: string, message: string): void {
  if (statusCard) statusCard.className = 'status-card error';
  if (statusIcon) statusIcon.textContent = '❌';
  if (statusTitle) statusTitle.textContent = title;
  if (statusMessage) statusMessage.textContent = message;
}

// 外部入力イベントを表示
function displayExternalInputs(events: StoredEvent[]): void {
  if (!events || events.length === 0) {
    if (externalInputPreview) externalInputPreview.style.display = 'none';
    return;
  }

  const externalInputEvents = events.filter(event =>
    event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop'
  );

  if (externalInputEvents.length === 0) {
    if (externalInputPreview) externalInputPreview.style.display = 'none';
    return;
  }

  if (externalInputPreview) externalInputPreview.style.display = 'block';
  if (externalInputList) externalInputList.innerHTML = '';

  externalInputEvents.forEach((event) => {
    const eventDiv = document.createElement('div');
    eventDiv.className = 'external-input-item';

    const typeSpan = document.createElement('span');
    typeSpan.className = 'external-input-type';
    typeSpan.textContent = event.inputType === 'insertFromPaste' ? '📋 ペースト' : '📂 ドロップ';
    eventDiv.appendChild(typeSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'external-input-time';
    timeSpan.textContent = `${(event.timestamp / 1000).toFixed(2)}秒`;
    eventDiv.appendChild(timeSpan);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'external-input-content';

    const content = typeof event.data === 'string' ? event.data : '';
    const maxLength = 200;
    const preview = content.length > maxLength
      ? content.substring(0, maxLength) + '...'
      : content;

    contentDiv.textContent = preview;
    contentDiv.title = content;
    eventDiv.appendChild(contentDiv);

    externalInputList?.appendChild(eventDiv);
  });
}

interface ExternalInputMarker {
  time: number;
  type: InputType;
}

// タイピング速度グラフを描画
function drawTypingSpeedChart(events: StoredEvent[]): void {
  if (!events || events.length === 0 || !speedChartCanvas) {
    if (typingSpeedChart) typingSpeedChart.style.display = 'none';
    return;
  }

  if (typingSpeedChart) typingSpeedChart.style.display = 'block';

  const ctx = speedChartCanvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio ?? 1;

  const rect = speedChartCanvas.getBoundingClientRect();
  speedChartCanvas.width = rect.width * dpr;
  speedChartCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const windowSize = 5000;
  const lastEvent = events[events.length - 1];
  const totalTime = lastEvent?.timestamp ?? 0;
  const dataPoints: { time: number; speed: number }[] = [];
  const externalInputMarkers: ExternalInputMarker[] = [];

  for (let time = 0; time <= totalTime; time += 1000) {
    const windowStart = Math.max(0, time - windowSize);
    const windowEnd = time;

    let charCount = 0;
    events.forEach(event => {
      if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
        if (event.type === 'contentChange' && event.data &&
            event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
          charCount += (typeof event.data === 'string' ? event.data.length : 0);
        }
      }
    });

    const speed = charCount / (windowSize / 1000);
    dataPoints.push({ time: time / 1000, speed });
  }

  events.forEach(event => {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      externalInputMarkers.push({
        time: event.timestamp / 1000,
        type: event.inputType
      });
    }
  });

  const maxSpeed = Math.max(...dataPoints.map(d => d.speed), 1);
  const yMax = Math.ceil(maxSpeed * 1.2);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();

    const value = yMax - (yMax / 5) * i;
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value.toFixed(1), padding.left - 10, y + 4);
  }

  const timeStep = Math.ceil(totalTime / 1000 / 10);
  for (let t = 0; t <= totalTime / 1000; t += timeStep) {
    const x = padding.left + (t / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = '#e9ecef';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.toFixed(0) + 's', x, height - padding.bottom + 20);
  }

  externalInputMarkers.forEach(marker => {
    const x = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.stroke();
  });

  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.beginPath();

  dataPoints.forEach((point, index) => {
    const x = padding.left + (point.time / (totalTime / 1000)) * chartWidth;
    const y = padding.top + chartHeight - (point.speed / yMax) * chartHeight;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  ctx.fillStyle = '#333';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('時間 (秒)', width / 2, height - 5);

  ctx.save();
  ctx.translate(15, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('タイピング速度 (文字/秒)', 0, 0);
  ctx.restore();
}

// ハッシュのコピー
copyHashBtn?.addEventListener('click', async () => {
  const hash = typingProofHashEl?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(hash);
    const originalText = copyHashBtn.textContent;
    copyHashBtn.textContent = '✅ コピーしました！';
    setTimeout(() => {
      copyHashBtn.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error('[Verify] Copy failed:', error);
    alert('コピーに失敗しました');
  }
});

// 再検証ボタン
verifyAgainBtn?.addEventListener('click', () => {
  if (resultSection) resultSection.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ========== タイムシークバー機能 ==========

/**
 * シークバーを初期化
 */
function initializeSeekbar(events: StoredEvent[], content: string): void {
  if (!events || events.length === 0) {
    if (timeSeekbar) timeSeekbar.style.display = 'none';
    return;
  }

  console.log('[Seekbar] Initializing with', events.length, 'events');
  console.log('[Seekbar] First 3 events:', events.slice(0, 3).map(e => ({
    type: e.type,
    inputType: e.inputType,
    dataLength: typeof e.data === 'string' ? e.data.length : (typeof e.data === 'object' && e.data ? JSON.stringify(e.data).length : 0),
    dataPreview: typeof e.data === 'string' ? e.data.substring(0, 50) + '...' : (e.data ? JSON.stringify(e.data).substring(0, 50) + '...' : null),
    sequence: e.sequence,
    timestamp: e.timestamp
  })));
  console.log('[Seekbar] Final content length:', content?.length ?? 0);

  const firstEvent = events[0];
  if (firstEvent && firstEvent.type === 'contentSnapshot') {
    const dataLength = typeof firstEvent.data === 'string' ? firstEvent.data.length : 0;
    console.log('[Seekbar] ✅ Event 0 is contentSnapshot with', dataLength, 'chars');
  } else if (firstEvent) {
    console.warn('[Seekbar] ⚠️ Event 0 is NOT contentSnapshot! Type:', firstEvent.type);
    console.warn('[Seekbar] This proof file may have been created before initial content recording was added.');
  }

  currentEvents = events;
  finalContent = content ?? '';
  currentEventIndex = events.length;
  contentCache.clear();
  if (timeSeekbar) timeSeekbar.style.display = 'block';

  if (seekbarSlider) {
    seekbarSlider.max = String(events.length);
    seekbarSlider.value = String(events.length);
  }

  updateSeekbarUI();
}

/**
 * 指定したインデックスまでのコンテンツを再構築（キャッシュ付き）
 */
const contentCache: ContentCache = new Map();

function getContentAtIndex(index: number): string {
  if (contentCache.has(index)) {
    console.log(`[Seekbar] Cache hit for index ${index}`);
    return contentCache.get(index)!;
  }

  console.log(`[Seekbar] Reconstructing content at index ${index}`);

  if (index === 0) {
    const content = '';
    contentCache.set(index, content);
    console.log(`[Seekbar] Index 0: empty state`);
    return content;
  }

  if (index === currentEvents.length) {
    contentCache.set(index, finalContent);
    console.log(`[Seekbar] Index ${index}: final state (${finalContent.length} chars)`);
    return finalContent;
  }

  let startIndex = 0;
  let lines: string[] = [''];

  for (let i = index - 1; i >= 0; i--) {
    if (contentCache.has(i)) {
      startIndex = i;
      lines = contentCache.get(i)!.split('\n');
      console.log(`[Seekbar] Starting from cached index ${i}`);
      break;
    }
  }

  console.log(`[Seekbar] Applying events from ${startIndex} to ${index - 1}`);

  for (let i = startIndex; i < index && i < currentEvents.length; i++) {
    const event = currentEvents[i];
    if (!event) continue;

    if (event.type === 'contentSnapshot') {
      const data = typeof event.data === 'string' ? event.data : '';
      lines = data.split('\n');
      console.log(`[Seekbar] Event ${i}: contentSnapshot (${data.length} chars)`);
      continue;
    }

    if (event.type === 'contentChange' && event.range) {
      const { startLineNumber, startColumn, endLineNumber, endColumn } = event.range;
      const text = typeof event.data === 'string' ? event.data : '';

      console.log(`[Seekbar] Event ${i}: contentChange at ${startLineNumber}:${startColumn}-${endLineNumber}:${endColumn}, text: "${text.substring(0, 20)}..."`);

      while (lines.length < endLineNumber) {
        lines.push('');
      }

      if (startLineNumber === endLineNumber) {
        const line = lines[startLineNumber - 1] ?? '';
        const before = line.substring(0, startColumn - 1);
        const after = line.substring(endColumn - 1);

        console.log(`[Seekbar]   Before: "${before}", After: "${after}"`);

        const newText = before + text + after;
        const newLines = newText.split('\n');

        console.log(`[Seekbar]   Result: ${newLines.length} lines, first: "${newLines[0]?.substring(0, 30) ?? ''}..."`);

        lines.splice(startLineNumber - 1, 1, ...newLines);
      } else {
        const startLine = lines[startLineNumber - 1] ?? '';
        const endLine = lines[endLineNumber - 1] ?? '';
        const before = startLine.substring(0, startColumn - 1);
        const after = endLine.substring(endColumn - 1);

        console.log(`[Seekbar]   Multi-line: deleting ${endLineNumber - startLineNumber + 1} lines`);

        const newText = before + text + after;
        const newLines = newText.split('\n');

        console.log(`[Seekbar]   Result: ${newLines.length} lines`);

        const deleteCount = endLineNumber - startLineNumber + 1;
        lines.splice(startLineNumber - 1, deleteCount, ...newLines);
      }
    }
  }

  const content = lines.join('\n');
  contentCache.set(index, content);
  console.log(`[Seekbar] Cached index ${index} with ${content.length} chars, ${lines.length} lines`);
  return content;
}

/**
 * 特定のイベントインデックスまでコードを再構築
 */
function reconstructCodeAtIndex(index: number): void {
  console.log('[Seekbar] Reconstructing code up to event index:', index);

  const content = getContentAtIndex(index);
  const lines = content.split('\n');
  const preview = lines.slice(0, 100).join('\n');
  if (contentPreview) {
    contentPreview.textContent = preview + (lines.length > 100 ? '\n...' : '');
  }
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

  if (seekbarTime) seekbarTime.textContent = `${(currentTime / 1000).toFixed(2)}秒 / ${(totalTime / 1000).toFixed(2)}秒`;
  if (seekbarEventCount) seekbarEventCount.textContent = `イベント: ${currentEventIndex} / ${currentEvents.length}`;
}

/**
 * 指定インデックスにシーク
 */
function seekToIndex(index: number): void {
  currentEventIndex = Math.max(0, Math.min(index, currentEvents.length));
  if (seekbarSlider) seekbarSlider.value = String(currentEventIndex);
  updateSeekbarUI();
  reconstructCodeAtIndex(currentEventIndex);
}

// シークバーのイベントリスナー

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

/**
 * 自動再生を開始
 */
function startPlayback(): void {
  if (currentEventIndex >= currentEvents.length) {
    currentEventIndex = 0;
  }

  isPlaying = true;
  if (seekbarPlay) {
    seekbarPlay.textContent = '⏸️';
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
  if (seekbarPlay) {
    seekbarPlay.textContent = '▶️';
    seekbarPlay.title = '自動再生';
  }

  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
}
