import { TypingProof } from './typingProof.js';
import type {
  ExportedProof,
  StoredEvent,
  ContentCache,
  InputType,
  MousePositionData,
  VisibilityChangeData,
  FocusChangeData,
  KeystrokeDynamicsData,
} from './types.js';

// Extended proof data with content and language
interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

// DOM要素
const dropZone = document.getElementById('drop-zone');
const dropZoneSection = document.querySelector('.drop-zone-section') as HTMLElement | null;
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
const poswValidBadge = document.getElementById('posw-valid-badge');
const poswMessage = document.getElementById('posw-message');
const poswIterationsEl = document.getElementById('posw-iterations');
const poswAvgTimeEl = document.getElementById('posw-avg-time');
const poswTotalTimeEl = document.getElementById('posw-total-time');
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

// 統合タイムライン要素
const integratedTimeline = document.getElementById('integrated-timeline');
const integratedTimelineCanvas = document.getElementById('integrated-timeline-chart') as HTMLCanvasElement | null;
const mouseTrajectorySection = document.getElementById('mouse-trajectory-section');
const mouseTrajectoryCanvas = document.getElementById('mouse-trajectory-chart') as HTMLCanvasElement | null;
const mouseEventCountEl = document.getElementById('mouse-event-count');
const focusEventCountEl = document.getElementById('focus-event-count');
const visibilityEventCountEl = document.getElementById('visibility-event-count');
const keyDownCountEl = document.getElementById('keydown-count');
const avgDwellTimeEl = document.getElementById('avg-dwell-time');
const avgFlightTimeEl = document.getElementById('avg-flight-time');

// フローティングシークバー要素
const floatingSeekbar = document.getElementById('floating-seekbar');
const seekbarSlider = document.getElementById('seekbar-slider') as HTMLInputElement | null;
const seekbarProgress = document.getElementById('seekbar-progress');
const seekbarTime = document.getElementById('seekbar-time');
const seekbarEventCount = document.getElementById('seekbar-event-count');
const seekbarStart = document.getElementById('seekbar-start');
const seekbarPrev = document.getElementById('seekbar-prev');
const seekbarPlay = document.getElementById('seekbar-play');
const playIcon = document.getElementById('play-icon');
const seekbarNext = document.getElementById('seekbar-next');
const seekbarEnd = document.getElementById('seekbar-end');

// シークバー用のグローバル変数
let currentEvents: StoredEvent[] = [];
let currentEventIndex = 0;
let isPlaying = false;
let playInterval: ReturnType<typeof setInterval> | null = null;
let finalContent = '';

// マウス軌跡チャート用のキャッシュ
interface MouseTrajectoryCache {
  positions: { x: number; y: number; time: number; eventIndex: number }[];
  scale: number;
  padding: { top: number; right: number; bottom: number; left: number };
  maxX: number;
  maxY: number;
}
let mouseTrajectoryCache: MouseTrajectoryCache | null = null;

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

// ローディングログ管理
interface LoadingLog {
  container: HTMLElement | null;
  logList: HTMLElement | null;
  startTime: number;
}

let loadingLog: LoadingLog = {
  container: null,
  logList: null,
  startTime: 0,
};

// ドロップゾーンにローディング状態を表示
function showDropZoneLoading(fileName: string): void {
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

// ローディングログにエントリを追加
function addLoadingLog(message: string, status: 'pending' | 'success' | 'error' = 'pending'): HTMLElement {
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

// ローディングログにエントリを追加（ハッシュ表示付き）
function addLoadingLogWithHash(message: string): HTMLElement {
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

// ローディングログのステータスを更新
function updateLoadingLog(entry: HTMLElement, status: 'success' | 'error', message?: string): void {
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

// ドロップゾーンのローディング状態を解除
function resetDropZoneLoading(): void {
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
          void handleFile(target.files[0]!);
        }
      });
    }
  }
}

// ドロップゾーンを非表示にする
function hideDropZone(): void {
  if (dropZoneSection) {
    dropZoneSection.style.display = 'none';
  }
}

// ドロップゾーンを表示する
function showDropZone(): void {
  if (dropZoneSection) {
    dropZoneSection.style.display = 'block';
  }
  resetDropZoneLoading();
}

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
    setTimeout(() => resetDropZoneLoading(), 2000);
  }
}

// 証明データの検証
async function verifyProofData(data: ProofFile): Promise<void> {
  // メタデータ確認ログ
  const metaLog = addLoadingLog('メタデータを確認中...');
  await new Promise(r => setTimeout(r, 50)); // UI更新のための小さな遅延

  showVerifying();
  updateLoadingLog(metaLog, 'success', `バージョン ${data.version ?? 'unknown'} を検出`);

  try {
    const typingProof = new TypingProof();

    // 1. タイピング証明ハッシュの検証
    let typingHashValid = false;
    let isPureTyping = false;

    if (data.typingProofHash && data.typingProofData && data.content) {
      const hashLog = addLoadingLog('タイピング証明ハッシュを検証中...');
      await new Promise(r => setTimeout(r, 50));

      const hashVerification = await typingProof.verifyTypingProofHash(
        data.typingProofHash,
        data.typingProofData,
        data.content
      );

      typingHashValid = hashVerification.valid;
      isPureTyping = hashVerification.isPureTyping ?? false;

      if (typingHashValid) {
        updateLoadingLog(hashLog, 'success', 'タイピング証明ハッシュ: 有効');
      } else {
        updateLoadingLog(hashLog, 'error', 'タイピング証明ハッシュ: 無効');
      }

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
      const eventCount = data.proof.events.length;
      const chainLog = addLoadingLogWithHash(`ハッシュ鎖を検証中... (0/${eventCount})`);
      await new Promise(r => setTimeout(r, 50));

      typingProof.events = data.proof.events;
      typingProof.currentHash = data.proof.finalHash;

      // 進捗表示用のコールバック（ハッシュ情報付き）- 毎回更新
      const onProgress = (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }): void => {
        const msgEl = chainLog.querySelector('.log-message');
        const hashEl = chainLog.querySelector('.log-hash-display');
        if (msgEl) {
          const percent = Math.round((current / total) * 100);
          msgEl.textContent = `ハッシュ鎖を検証中... (${current}/${total}) ${percent}%`;
        }
        if (hashEl && hashInfo) {
          // ハッシュをかっこよく表示（一部だけ見せる）
          const shortHash = hashInfo.computed.substring(0, 16);
          const poswShort = hashInfo.poswHash.substring(0, 12);
          hashEl.innerHTML = `<span class="hash-chain">${shortHash}...</span> <span class="hash-posw">PoSW:${poswShort}</span>`;

          // ハッシュ表示エリアが見えるようにスクロール
          if (loadingLog.container) {
            loadingLog.container.scrollTop = loadingLog.container.scrollHeight;
          }
        }
      };

      const chainVerification = await typingProof.verify(onProgress);
      chainValid = chainVerification.valid;

      if (chainValid) {
        updateLoadingLog(chainLog, 'success', `ハッシュ鎖: ${eventCount} イベント検証完了`);
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '✅ 有効';
          chainValidBadge.className = 'badge success';
        }
        if (chainMessage) chainMessage.textContent = `全${data.proof.totalEvents}イベントのハッシュ鎖が正常に検証されました`;
        console.log('[Verify] ✅ Hash chain verification passed');
      } else {
        updateLoadingLog(chainLog, 'error', 'ハッシュ鎖: 検証失敗');
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

      // PoSW検証ログ
      const poswLog = addLoadingLog('PoSW (Proof of Sequential Work) を検証中...');
      await new Promise(r => setTimeout(r, 50));

      // 2b. PoSW統計を表示
      displayPoSWStats(data.proof.events, chainValid);
      updateLoadingLog(poswLog, 'success', 'PoSW検証完了');
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

    // UIレンダリングログ
    const uiLog = addLoadingLog('分析チャートを生成中...');
    await new Promise(r => setTimeout(r, 50));

    updateLoadingLog(uiLog, 'success', 'チャート生成完了');

    // 検証完了ログ
    addLoadingLog('検証完了', 'success');

    // 検証完了後に結果セクションを表示（チャート描画前に表示が必要）
    if (resultSection) {
      resultSection.style.display = 'block';
    }

    // 5. タイムシークバーの初期化（結果セクション表示後にチャートを描画）
    if (data.proof?.events) {
      // DOMが更新されるのを待ってからチャートを描画
      requestAnimationFrame(() => {
        initializeSeekbar(data.proof.events, data.content);
        // スクロールはチャート描画後に実行
        resultSection?.scrollIntoView({ behavior: 'smooth' });
      });
    } else if (resultSection) {
      resultSection.scrollIntoView({ behavior: 'smooth' });
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

// PoSW統計を表示
function displayPoSWStats(events: StoredEvent[], chainValid: boolean): void {
  // PoSWを含むイベントを抽出
  const eventsWithPoSW = events.filter(event => {
    // posw フィールドが存在するかチェック
    return 'posw' in event && event.posw && typeof event.posw === 'object';
  });

  if (eventsWithPoSW.length === 0) {
    // PoSWなし（古いバージョンの証明ファイル）
    if (poswValidBadge) {
      poswValidBadge.innerHTML = '⚠️ なし';
      poswValidBadge.className = 'badge warning';
    }
    if (poswMessage) poswMessage.textContent = 'この証明ファイルにはPoSWが含まれていません（v2.x以前）';
    if (poswIterationsEl) poswIterationsEl.textContent = '-';
    if (poswAvgTimeEl) poswAvgTimeEl.textContent = '-';
    if (poswTotalTimeEl) poswTotalTimeEl.textContent = '-';
    return;
  }

  // PoSW統計を計算
  let totalIterations = 0;
  let totalComputeTime = 0;
  const computeTimes: number[] = [];

  eventsWithPoSW.forEach(event => {
    const posw = (event as StoredEvent & { posw: { iterations: number; computeTimeMs: number } }).posw;
    totalIterations += posw.iterations;
    totalComputeTime += posw.computeTimeMs;
    computeTimes.push(posw.computeTimeMs);
  });

  const avgComputeTime = computeTimes.length > 0
    ? computeTimes.reduce((a, b) => a + b, 0) / computeTimes.length
    : 0;

  // 表示を更新
  if (chainValid) {
    if (poswValidBadge) {
      poswValidBadge.innerHTML = '✅ 検証済み';
      poswValidBadge.className = 'badge success';
    }
    if (poswMessage) poswMessage.textContent = `全${eventsWithPoSW.length}イベントのPoSWが検証されました`;
  } else {
    if (poswValidBadge) {
      poswValidBadge.innerHTML = '❌ 検証失敗';
      poswValidBadge.className = 'badge error';
    }
    if (poswMessage) poswMessage.textContent = 'ハッシュ鎖検証に失敗したためPoSWも無効';
  }

  // 統計を表示
  if (poswIterationsEl) {
    const firstEvent = eventsWithPoSW[0] as StoredEvent & { posw: { iterations: number } };
    poswIterationsEl.textContent = `${firstEvent.posw.iterations.toLocaleString()}回/イベント`;
  }
  if (poswAvgTimeEl) {
    poswAvgTimeEl.textContent = `${avgComputeTime.toFixed(1)}ms`;
  }
  if (poswTotalTimeEl) {
    poswTotalTimeEl.textContent = `${(totalComputeTime / 1000).toFixed(2)}秒`;
  }

  console.log('[Verify] PoSW stats:', {
    eventsWithPoSW: eventsWithPoSW.length,
    totalIterations,
    avgComputeTime: avgComputeTime.toFixed(1) + 'ms',
    totalComputeTime: (totalComputeTime / 1000).toFixed(2) + 's'
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
  showDropZone();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ========== タイムシークバー機能 ==========

/**
 * シークバーを初期化
 */
function initializeSeekbar(events: StoredEvent[], content: string): void {
  if (!events || events.length === 0) {
    if (integratedTimeline) integratedTimeline.style.display = 'none';
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
  if (integratedTimeline) integratedTimeline.style.display = 'block';

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
  drawIntegratedTimeline(events);

  // 初期状態のマーカーを描画（最終位置）
  setTimeout(() => {
    updateIntegratedTimelineMarker(currentEventIndex);
    updateMouseTrajectoryMarker(currentEventIndex);
  }, 100);
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
  updateMouseTrajectoryMarker(currentEventIndex);
  updateFocusTimelineMarker(currentEventIndex);
  updateKeystrokeDynamicsMarker(currentEventIndex);
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

// ========== 統合タイムライン機能 ==========

// 統合タイムライン用のキャッシュ
interface IntegratedTimelineCache {
  totalTime: number;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
  typingSpeedData: { time: number; speed: number }[];
  externalInputMarkers: { time: number; type: InputType }[];
  focusEvents: StoredEvent[];
  visibilityEvents: StoredEvent[];
  keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[];
  keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[];
  maxSpeed: number;
  maxKeystrokeTime: number;
}
let integratedTimelineCache: IntegratedTimelineCache | null = null;

/**
 * 統合タイムラインを描画（タイピング速度、フォーカス状態、キーストローク）
 */
function drawIntegratedTimeline(events: StoredEvent[]): void {
  if (!integratedTimelineCanvas || !events || events.length === 0) {
    return;
  }

  // イベントを抽出
  const mouseEvents = events.filter(e => e.type === 'mousePositionChange');
  const focusEvents = events.filter(e => e.type === 'focusChange');
  const visibilityEvents = events.filter(e => e.type === 'visibilityChange');
  const keyDownEvents = events.filter(e => e.type === 'keyDown');
  const keyUpEvents = events.filter(e => e.type === 'keyUp');

  // 統計情報を更新
  if (mouseEventCountEl) mouseEventCountEl.textContent = String(mouseEvents.length);
  if (focusEventCountEl) focusEventCountEl.textContent = String(focusEvents.length);
  if (visibilityEventCountEl) visibilityEventCountEl.textContent = String(visibilityEvents.length);
  if (keyDownCountEl) keyDownCountEl.textContent = String(keyDownEvents.length);

  // Dwell/Flight Time の平均を計算
  const dwellTimes: number[] = [];
  keyUpEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
      dwellTimes.push(data.dwellTime);
    }
  });
  const avgDwellTime = dwellTimes.length > 0
    ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length
    : 0;
  if (avgDwellTimeEl) avgDwellTimeEl.textContent = `${avgDwellTime.toFixed(1)}ms`;

  const flightTimes: number[] = [];
  keyDownEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
      flightTimes.push(data.flightTime);
    }
  });
  const avgFlightTime = flightTimes.length > 0
    ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length
    : 0;
  if (avgFlightTimeEl) avgFlightTimeEl.textContent = `${avgFlightTime.toFixed(1)}ms`;

  // マウス軌跡を描画（別キャンバス）
  if (mouseEvents.length > 0) {
    if (mouseTrajectorySection) mouseTrajectorySection.style.display = 'block';
    drawMouseTrajectory(mouseEvents);
  } else {
    if (mouseTrajectorySection) mouseTrajectorySection.style.display = 'none';
  }

  // 統合キャンバスを描画
  const ctx = integratedTimelineCanvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio ?? 1;
  const rect = integratedTimelineCanvas.getBoundingClientRect();
  integratedTimelineCanvas.width = rect.width * dpr;
  integratedTimelineCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 30, right: 20, bottom: 50, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const lastEvent = events[events.length - 1];
  const totalTime = lastEvent?.timestamp ?? 0;

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // === タイピング速度データを準備 ===
  const windowSize = 5000;
  const typingSpeedData: { time: number; speed: number }[] = [];
  const externalInputMarkers: { time: number; type: InputType }[] = [];

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
    typingSpeedData.push({ time: time / 1000, speed });
  }

  events.forEach(event => {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      externalInputMarkers.push({
        time: event.timestamp / 1000,
        type: event.inputType
      });
    }
  });

  // === キーストロークデータを準備 ===
  const keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[] = [];
  const keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[] = [];
  let maxKeystrokeTime = 0;

  keyUpEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      keyUpData.push({
        time: event.timestamp,
        dwellTime: data.dwellTime,
        key: data.key,
        eventIndex
      });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.dwellTime);
    }
  });

  keyDownEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      keyDownData.push({
        time: event.timestamp,
        flightTime: data.flightTime,
        key: data.key,
        eventIndex
      });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.flightTime);
    }
  });

  maxKeystrokeTime = Math.ceil(maxKeystrokeTime / 100) * 100 || 300;
  const maxSpeed = Math.max(...typingSpeedData.map(d => d.speed), 1);
  const yMaxSpeed = Math.ceil(maxSpeed * 1.2);

  // キャッシュを保存
  integratedTimelineCache = {
    totalTime,
    padding,
    chartWidth,
    chartHeight,
    typingSpeedData,
    externalInputMarkers,
    focusEvents,
    visibilityEvents,
    keyUpData,
    keyDownData,
    maxSpeed: yMaxSpeed,
    maxKeystrokeTime
  };

  // レイアウト: 上からフォーカスバー、タイピング速度、キーストローク
  const focusBarHeight = 12;
  const visibilityBarHeight = 12;
  const gapBetweenBars = 6;
  const focusAreaHeight = focusBarHeight + gapBetweenBars + visibilityBarHeight + 20;
  const speedChartHeight = (chartHeight - focusAreaHeight) * 0.5;
  const keystrokeChartHeight = (chartHeight - focusAreaHeight) * 0.5;

  const focusY = padding.top;
  const visibilityY = focusY + focusBarHeight + gapBetweenBars;
  const speedChartY = focusY + focusAreaHeight;
  const keystrokeY = speedChartY + speedChartHeight;

  // === フォーカス・Visibilityバーを描画 ===
  drawFocusBar(ctx, focusEvents, padding.left, focusY, chartWidth, focusBarHeight, totalTime, true);
  drawFocusBar(ctx, visibilityEvents, padding.left, visibilityY, chartWidth, visibilityBarHeight, totalTime, false);

  // ラベル
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Focus', padding.left - 5, focusY + focusBarHeight / 2 + 3);
  ctx.fillText('Tab', padding.left - 5, visibilityY + visibilityBarHeight / 2 + 3);

  // === タイピング速度を描画 ===
  // グリッド線
  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  // Y軸ラベル
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    const value = yMaxSpeed - (yMaxSpeed / 4) * i;
    ctx.fillText(value.toFixed(0), padding.left - 5, y + 3);
  }

  // 外部入力マーカー
  externalInputMarkers.forEach(marker => {
    const x = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
    ctx.fillStyle = 'rgba(255, 193, 7, 0.3)';
    ctx.fillRect(x - 2, speedChartY, 4, speedChartHeight);
  });

  // タイピング速度ライン
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.beginPath();

  typingSpeedData.forEach((point, index) => {
    const x = padding.left + (point.time / (totalTime / 1000)) * chartWidth;
    const y = speedChartY + speedChartHeight - (point.speed / yMaxSpeed) * speedChartHeight;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  // === キーストロークを描画 ===
  // グリッド線
  ctx.strokeStyle = '#e9ecef';
  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  // Y軸ラベル
  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    const value = maxKeystrokeTime - (maxKeystrokeTime / 4) * i;
    ctx.fillText(`${value.toFixed(0)}`, padding.left - 5, y + 3);
  }

  // Dwell Time（青い点）
  ctx.fillStyle = 'rgba(102, 126, 234, 0.6)';
  keyUpData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.dwellTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Flight Time（緑の点）
  ctx.fillStyle = 'rgba(40, 167, 69, 0.6)';
  keyDownData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.flightTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // === X軸（時間） ===
  const timeStep = Math.ceil(totalTime / 1000 / 10);
  for (let t = 0; t <= totalTime / 1000; t += timeStep) {
    const x = padding.left + (t / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = '#e9ecef';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t.toFixed(0)}s`, x, height - padding.bottom + 15);
  }

  // Y軸ラベル（セクション名）
  ctx.fillStyle = '#333';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.save();
  ctx.translate(12, speedChartY + speedChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('速度 (文字/秒)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(12, keystrokeY + keystrokeChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('キー (ms)', 0, 0);
  ctx.restore();
}

/**
 * フォーカス/Visibility バーを描画
 */
function drawFocusBar(
  ctx: CanvasRenderingContext2D,
  events: StoredEvent[],
  x: number,
  y: number,
  width: number,
  height: number,
  totalTime: number,
  isFocus: boolean
): void {
  let lastTime = 0;
  let lastState = true;

  events.forEach(event => {
    const data = isFocus
      ? (event.data as FocusChangeData | null)
      : (event.data as VisibilityChangeData | null);
    if (!data || typeof data !== 'object') return;

    const state = isFocus ? ('focused' in data && data.focused) : ('visible' in data && data.visible);

    const startX = x + (lastTime / totalTime) * width;
    const endX = x + (event.timestamp / totalTime) * width;

    ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
    ctx.fillRect(startX, y, endX - startX, height);

    lastTime = event.timestamp;
    lastState = !!state;
  });

  // 最後のセグメント
  const lastX = x + (lastTime / totalTime) * width;
  ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
  ctx.fillRect(lastX, y, x + width - lastX, height);
}

/**
 * アクティビティチャートを描画（後方互換性のため残す - 統合タイムラインへリダイレクト）
 */
function drawActivityCharts(events: StoredEvent[]): void {
  // 統合タイムラインに統合されたので何もしない
}

/**
 * マウス軌跡を描画
 */
function drawMouseTrajectory(mouseEvents: StoredEvent[]): void {
  if (!mouseTrajectoryCanvas) return;

  const ctx = mouseTrajectoryCanvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio ?? 1;
  const rect = mouseTrajectoryCanvas.getBoundingClientRect();
  mouseTrajectoryCanvas.width = rect.width * dpr;
  mouseTrajectoryCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 20, left: 20 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // マウス位置データを抽出（イベントインデックス付き）
  const positions: { x: number; y: number; time: number; eventIndex: number }[] = [];
  let maxX = 0;
  let maxY = 0;

  mouseEvents.forEach(event => {
    const data = event.data as MousePositionData | null;
    if (data && typeof data === 'object' && 'x' in data && 'y' in data) {
      // currentEvents内でのインデックスを探す
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      positions.push({ x: data.x, y: data.y, time: event.timestamp, eventIndex });
      maxX = Math.max(maxX, data.x);
      maxY = Math.max(maxY, data.y);
    }
  });

  if (positions.length === 0) return;

  // スケーリング
  const scaleX = chartWidth / (maxX || 1);
  const scaleY = chartHeight / (maxY || 1);
  const scale = Math.min(scaleX, scaleY);

  // キャッシュを保存
  mouseTrajectoryCache = { positions, scale, padding, maxX, maxY };

  // 時間に基づいて色を変化させる
  const startTime = positions[0]?.time ?? 0;
  const endTime = positions[positions.length - 1]?.time ?? 1;
  const timeRange = endTime - startTime || 1;

  // 軌跡を描画
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!;
    const curr = positions[i]!;

    // 時間に基づいて色を計算（青→緑→黄→赤）
    const t = (curr.time - startTime) / timeRange;
    const hue = (1 - t) * 240; // 青(240)から赤(0)へ
    ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.7)`;

    ctx.beginPath();
    ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
    ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
    ctx.stroke();
  }

  // 開始点と終了点を強調
  if (positions.length > 0) {
    const start = positions[0]!;
    const end = positions[positions.length - 1]!;

    // 開始点（緑）
    ctx.fillStyle = '#28a745';
    ctx.beginPath();
    ctx.arc(padding.left + start.x * scale, padding.top + start.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();

    // 終了点（赤）
    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(padding.left + end.x * scale, padding.top + end.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 凡例
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#28a745';
  ctx.fillText('● 開始', width - 100, 20);
  ctx.fillStyle = '#dc3545';
  ctx.fillText('● 終了', width - 50, 20);
}


/**
 * マウス軌跡チャート上に現在位置マーカーを更新
 */
function updateMouseTrajectoryMarker(eventIndex: number): void {
  if (!mouseTrajectoryCanvas || !mouseTrajectoryCache) return;

  const ctx = mouseTrajectoryCanvas.getContext('2d');
  if (!ctx) return;

  const { positions, scale, padding } = mouseTrajectoryCache;

  // 現在のイベントインデックスまでの最後のマウス位置を見つける
  let currentPos: { x: number; y: number } | null = null;
  let visitedPositions: { x: number; y: number }[] = [];

  for (const pos of positions) {
    if (pos.eventIndex < eventIndex) {
      visitedPositions.push({ x: pos.x, y: pos.y });
      currentPos = { x: pos.x, y: pos.y };
    } else if (pos.eventIndex === eventIndex) {
      visitedPositions.push({ x: pos.x, y: pos.y });
      currentPos = { x: pos.x, y: pos.y };
      break;
    }
  }

  // キャンバスを再描画
  const dpr = window.devicePixelRatio ?? 1;
  const rect = mouseTrajectoryCanvas.getBoundingClientRect();
  mouseTrajectoryCanvas.width = rect.width * dpr;
  mouseTrajectoryCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // 全軌跡を薄く描画
  if (positions.length > 1) {
    ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const first = positions[0]!;
    ctx.moveTo(padding.left + first.x * scale, padding.top + first.y * scale);
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i]!;
      ctx.lineTo(padding.left + pos.x * scale, padding.top + pos.y * scale);
    }
    ctx.stroke();
  }

  // 訪問済み軌跡を明るく描画
  if (visitedPositions.length > 1) {
    const startTime = positions[0]?.time ?? 0;
    const endTime = positions[positions.length - 1]?.time ?? 1;
    const timeRange = endTime - startTime || 1;

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < visitedPositions.length; i++) {
      const prev = visitedPositions[i - 1]!;
      const curr = visitedPositions[i]!;

      // 対応するpositionsのインデックスを探して時間を取得
      const posIndex = positions.findIndex(p => p.x === curr.x && p.y === curr.y);
      const currTime = posIndex >= 0 ? positions[posIndex]!.time : startTime;
      const t = (currTime - startTime) / timeRange;
      const hue = (1 - t) * 240;
      ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.8)`;

      ctx.beginPath();
      ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
      ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
      ctx.stroke();
    }
  }

  // 開始点
  if (positions.length > 0) {
    const start = positions[0]!;
    ctx.fillStyle = '#28a745';
    ctx.beginPath();
    ctx.arc(padding.left + start.x * scale, padding.top + start.y * scale, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 現在位置マーカー（黄色の円）
  if (currentPos) {
    // 外側の輪郭
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(padding.left + currentPos.x * scale, padding.top + currentPos.y * scale, 10, 0, Math.PI * 2);
    ctx.stroke();

    // 内側の円
    ctx.fillStyle = '#ffc107';
    ctx.beginPath();
    ctx.arc(padding.left + currentPos.x * scale, padding.top + currentPos.y * scale, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 終了点（全て訪問済みの場合）
  if (eventIndex >= currentEvents.length && positions.length > 0) {
    const end = positions[positions.length - 1]!;
    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(padding.left + end.x * scale, padding.top + end.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 凡例
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#28a745';
  ctx.fillText('● 開始', width - 140, 20);
  ctx.fillStyle = '#ffc107';
  ctx.fillText('● 現在', width - 90, 20);
  ctx.fillStyle = '#dc3545';
  ctx.fillText('● 終了', width - 40, 20);
}

/**
 * フォーカスタイムラインに現在位置マーカーを更新（統合タイムラインに統合）
 */
function updateFocusTimelineMarker(_eventIndex: number): void {
  // 統合タイムラインに統合されたので再描画で対応
  if (integratedTimelineCache && currentEvents.length > 0) {
    drawIntegratedTimeline(currentEvents);
    updateIntegratedTimelineMarker(_eventIndex);
  }
}

/**
 * キーストロークダイナミクスチャートを描画（統合タイムラインに統合）
 */
function drawKeystrokeDynamicsChart(_events: StoredEvent[]): void {
  // 統合タイムラインに統合されたので何もしない
}

/**
 * キーストロークダイナミクスチャートのマーカーを更新（統合タイムラインに統合）
 */
function updateKeystrokeDynamicsMarker(_eventIndex: number): void {
  // 統合タイムラインに統合されたので何もしない
}

/**
 * 統合タイムラインに現在位置マーカーを描画
 */
function updateIntegratedTimelineMarker(eventIndex: number): void {
  if (!integratedTimelineCanvas || !integratedTimelineCache) return;
  if (currentEvents.length === 0) return;

  const ctx = integratedTimelineCanvas.getContext('2d');
  if (!ctx) return;

  const { totalTime, padding, chartHeight } = integratedTimelineCache;

  // 現在のイベントのタイムスタンプを取得
  const currentEvent = eventIndex > 0 && eventIndex <= currentEvents.length
    ? currentEvents[eventIndex - 1]
    : null;
  const currentTime = currentEvent?.timestamp ?? 0;

  // 現在位置のX座標を計算
  const rect = integratedTimelineCanvas.getBoundingClientRect();
  const chartWidth = rect.width - padding.left - padding.right;
  const markerX = padding.left + (currentTime / totalTime) * chartWidth;

  // マーカーを描画（縦線）
  ctx.strokeStyle = '#ffc107';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX, padding.top);
  ctx.lineTo(markerX, padding.top + chartHeight);
  ctx.stroke();

  // マーカーの三角形（上）
  ctx.fillStyle = '#ffc107';
  ctx.beginPath();
  ctx.moveTo(markerX, padding.top - 8);
  ctx.lineTo(markerX - 5, padding.top);
  ctx.lineTo(markerX + 5, padding.top);
  ctx.closePath();
  ctx.fill();
}
