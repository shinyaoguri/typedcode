import { TypingProof } from './typingProof.js';

// DOM要素
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
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
const speedChartCanvas = document.getElementById('speed-chart');

// シークバー要素
const timeSeekbar = document.getElementById('time-seekbar');
const seekbarSlider = document.getElementById('seekbar-slider');
const seekbarTime = document.getElementById('seekbar-time');
const seekbarEventCount = document.getElementById('seekbar-event-count');
const seekbarStart = document.getElementById('seekbar-start');
const seekbarPrev = document.getElementById('seekbar-prev');
const seekbarPlay = document.getElementById('seekbar-play');
const seekbarNext = document.getElementById('seekbar-next');
const seekbarEnd = document.getElementById('seekbar-end');

// シークバー用のグローバル変数
let currentEvents = [];
let currentEventIndex = 0;
let isPlaying = false;
let playInterval = null;
let finalContent = ''; // 最終コンテンツを保存

// ドラッグ&ドロップイベント
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFile(files[0]);
  }
});

// ファイル選択
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0]);
  }
});

// ファイル処理
async function handleFile(file) {
  if (!file.name.endsWith('.json')) {
    alert('JSONファイルを選択してください');
    return;
  }

  try {
    const text = await file.text();
    const proofData = JSON.parse(text);
    await verifyProofData(proofData);
  } catch (error) {
    console.error('[Verify] Error reading file:', error);
    showError('ファイルの読み込みに失敗しました', error.message);
  }
}

// 証明データの検証
async function verifyProofData(data) {
  // 結果セクションを表示
  resultSection.style.display = 'block';
  resultSection.scrollIntoView({ behavior: 'smooth' });

  // 検証中表示
  showVerifying();

  try {
    // TypingProofインスタンスを作成
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
      isPureTyping = hashVerification.isPureTyping;

      // タイピング証明ハッシュ表示
      typingProofHashEl.textContent = data.typingProofHash;
      copyHashBtn.style.display = 'inline-block';

      // 純粋なタイピング判定
      if (isPureTyping) {
        pureTypingBadge.innerHTML = '✅ 純粋なタイピング';
        pureTypingBadge.className = 'badge success';
        pasteInfo.textContent = 'コピー&ペーストは検出されませんでした';
        externalInputPreview.style.display = 'none';
      } else {
        pureTypingBadge.innerHTML = '⚠️ 外部入力あり';
        pureTypingBadge.className = 'badge warning';
        const pasteCount = data.typingProofData.metadata.pasteEvents || 0;
        const dropCount = data.typingProofData.metadata.dropEvents || 0;
        pasteInfo.textContent = `ペースト: ${pasteCount}回、ドロップ: ${dropCount}回`;

        // 外部入力イベントを抽出して表示
        displayExternalInputs(data.proof.events);
      }

      // デバイスID
      deviceIdEl.textContent = data.typingProofData.deviceId.substring(0, 16) + '...';
      deviceIdEl.title = data.typingProofData.deviceId;

      // 統計情報
      const meta = data.typingProofData.metadata;
      totalEventsEl.textContent = meta.totalEvents;
      insertEventsEl.textContent = meta.insertEvents;
      deleteEventsEl.textContent = meta.deleteEvents;
      typingTimeEl.textContent = (meta.totalTypingTime / 1000).toFixed(2) + '秒';
      typingSpeedEl.textContent = meta.averageTypingSpeed + ' WPM';
    }

    // 2. ハッシュ鎖の検証
    let chainValid = false;
    let chainError = null;

    if (data.proof && data.proof.events) {
      // イベントデータを復元
      typingProof.events = data.proof.events;
      typingProof.currentHash = data.proof.finalHash;

      const chainVerification = await typingProof.verify();
      chainValid = chainVerification.valid;

      if (chainValid) {
        chainValidBadge.innerHTML = '✅ 有効';
        chainValidBadge.className = 'badge success';
        chainMessage.textContent = `全${data.proof.totalEvents}イベントのハッシュ鎖が正常に検証されました`;
        console.log('[Verify] ✅ Hash chain verification passed');
      } else {
        chainValidBadge.innerHTML = '❌ 無効';
        chainValidBadge.className = 'badge error';
        chainMessage.textContent = `エラー: ${chainVerification.message}`;
        chainError = chainVerification;
        console.error('[Verify] ❌ Hash chain verification failed:', chainVerification);

        // 詳細なエラー情報を出力
        if (chainVerification.errorAt !== undefined) {
          console.error('[Verify] Error at event index:', chainVerification.errorAt);
          console.error('[Verify] Event data:', chainVerification.event);
        }
      }
    }

    // 3. メタデータ表示
    versionEl.textContent = data.version || '-';
    languageEl.textContent = data.language || '-';
    timestampEl.textContent = data.metadata?.timestamp || '-';
    userAgentEl.textContent = data.metadata?.userAgent || '-';

    // 4. コンテンツプレビュー
    if (data.content) {
      const lines = data.content.split('\n');
      const preview = lines.slice(0, 20).join('\n');
      contentPreview.textContent = preview + (lines.length > 20 ? '\n...' : '');
    }

    // 5. タイピング速度グラフの描画
    if (data.proof && data.proof.events) {
      drawTypingSpeedChart(data.proof.events);
    }

    // 6. タイムシークバーの初期化
    if (data.proof && data.proof.events) {
      initializeSeekbar(data.proof.events, data.content);
    }

    // 総合判定
    const allValid = typingHashValid && chainValid;

    if (allValid && isPureTyping) {
      showSuccess('✅ 検証成功：純粋なタイピングで作成されたコードです');
    } else if (allValid && !isPureTyping) {
      showWarning('⚠️ 検証成功：コピー&ペーストが含まれています');
    } else {
      showError('❌ 検証失敗', chainError ? chainError.message : 'ハッシュが一致しません');
    }

  } catch (error) {
    console.error('[Verify] Verification error:', error);
    showError('検証中にエラーが発生しました', error.message);
  }
}

// 検証中表示
function showVerifying() {
  statusCard.className = 'status-card verifying';
  statusIcon.textContent = '⏳';
  statusTitle.textContent = '検証中...';
  statusMessage.textContent = 'タイピング証明データを検証しています';
}

// 成功表示
function showSuccess(message) {
  statusCard.className = 'status-card success';
  statusIcon.textContent = '✅';
  statusTitle.textContent = '検証成功';
  statusMessage.textContent = message;
}

// 警告表示
function showWarning(message) {
  statusCard.className = 'status-card warning';
  statusIcon.textContent = '⚠️';
  statusTitle.textContent = '警告';
  statusMessage.textContent = message;
}

// エラー表示
function showError(title, message) {
  statusCard.className = 'status-card error';
  statusIcon.textContent = '❌';
  statusTitle.textContent = title;
  statusMessage.textContent = message;
}

// 外部入力イベントを表示
function displayExternalInputs(events) {
  if (!events || events.length === 0) {
    externalInputPreview.style.display = 'none';
    return;
  }

  // ペースト・ドロップイベントを抽出
  const externalInputEvents = events.filter(event =>
    event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop'
  );

  if (externalInputEvents.length === 0) {
    externalInputPreview.style.display = 'none';
    return;
  }

  // 外部入力セクションを表示
  externalInputPreview.style.display = 'block';
  externalInputList.innerHTML = '';

  externalInputEvents.forEach((event) => {
    const eventDiv = document.createElement('div');
    eventDiv.className = 'external-input-item';

    // イベントタイプ
    const typeSpan = document.createElement('span');
    typeSpan.className = 'external-input-type';
    typeSpan.textContent = event.inputType === 'insertFromPaste' ? '📋 ペースト' : '📂 ドロップ';
    eventDiv.appendChild(typeSpan);

    // タイムスタンプ
    const timeSpan = document.createElement('span');
    timeSpan.className = 'external-input-time';
    timeSpan.textContent = `${(event.timestamp / 1000).toFixed(2)}秒`;
    eventDiv.appendChild(timeSpan);

    // コンテンツプレビュー
    const contentDiv = document.createElement('div');
    contentDiv.className = 'external-input-content';

    const content = event.data || '';
    const maxLength = 200;
    const preview = content.length > maxLength
      ? content.substring(0, maxLength) + '...'
      : content;

    contentDiv.textContent = preview;
    contentDiv.title = content; // フルコンテンツをツールチップに
    eventDiv.appendChild(contentDiv);

    externalInputList.appendChild(eventDiv);
  });
}

// タイピング速度グラフを描画
function drawTypingSpeedChart(events) {
  if (!events || events.length === 0) {
    typingSpeedChart.style.display = 'none';
    return;
  }

  // グラフ表示
  typingSpeedChart.style.display = 'block';

  // Canvasのコンテキストを取得
  const ctx = speedChartCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Canvasのサイズを設定（高解像度対応）
  const rect = speedChartCanvas.getBoundingClientRect();
  speedChartCanvas.width = rect.width * dpr;
  speedChartCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // 時系列データを計算（5秒ごとの速度）
  const windowSize = 5000; // 5秒のウィンドウ
  const totalTime = events[events.length - 1]?.timestamp || 0;
  const dataPoints = [];
  const externalInputMarkers = [];

  // タイムウィンドウごとに文字数をカウント
  for (let time = 0; time <= totalTime; time += 1000) { // 1秒ごと
    const windowStart = Math.max(0, time - windowSize);
    const windowEnd = time;

    // このウィンドウ内の挿入イベント数をカウント
    let charCount = 0;
    events.forEach(event => {
      if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
        if (event.type === 'contentChange' && event.data &&
            event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
          charCount += (event.data?.length || 0);
        }
      }
    });

    // 文字/秒に変換
    const speed = charCount / (windowSize / 1000);
    dataPoints.push({ time: time / 1000, speed });
  }

  // 外部入力イベントのマーカー位置を記録
  events.forEach(event => {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      externalInputMarkers.push({
        time: event.timestamp / 1000,
        type: event.inputType
      });
    }
  });

  // Y軸の最大値を計算
  const maxSpeed = Math.max(...dataPoints.map(d => d.speed), 1);
  const yMax = Math.ceil(maxSpeed * 1.2); // 20%のマージン

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // グリッド線を描画
  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;

  // Y軸グリッド（5本）
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();

    // Y軸ラベル
    const value = yMax - (yMax / 5) * i;
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value.toFixed(1), padding.left - 10, y + 4);
  }

  // X軸グリッド（時間）
  const timeStep = Math.ceil(totalTime / 1000 / 10); // 約10分割
  for (let t = 0; t <= totalTime / 1000; t += timeStep) {
    const x = padding.left + (t / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = '#e9ecef';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.stroke();

    // X軸ラベル
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.toFixed(0) + 's', x, height - padding.bottom + 20);
  }

  // 外部入力マーカーを描画（縦線）
  externalInputMarkers.forEach(marker => {
    const x = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.stroke();
  });

  // 速度曲線を描画
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

  // 軸ラベル
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
copyHashBtn.addEventListener('click', async () => {
  const hash = typingProofHashEl.textContent;
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
verifyAgainBtn.addEventListener('click', () => {
  resultSection.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ========== タイムシークバー機能 ==========

/**
 * シークバーを初期化
 */
function initializeSeekbar(events, content) {
  if (!events || events.length === 0) {
    timeSeekbar.style.display = 'none';
    return;
  }

  console.log('[Seekbar] Initializing with', events.length, 'events');
  console.log('[Seekbar] First 3 events:', events.slice(0, 3).map(e => ({
    type: e.type,
    inputType: e.inputType,
    dataLength: typeof e.data === 'string' ? e.data.length : (typeof e.data === 'object' ? JSON.stringify(e.data).length : 0),
    dataPreview: typeof e.data === 'string' ? e.data.substring(0, 50) + '...' : (e.data ? JSON.stringify(e.data).substring(0, 50) + '...' : null),
    sequence: e.sequence,
    timestamp: e.timestamp
  })));
  console.log('[Seekbar] Final content length:', content?.length || 0);

  // Event 0がcontentSnapshotかどうか確認
  if (events.length > 0 && events[0].type === 'contentSnapshot') {
    console.log('[Seekbar] ✅ Event 0 is contentSnapshot with', events[0].data?.length || 0, 'chars');
  } else if (events.length > 0) {
    console.warn('[Seekbar] ⚠️ Event 0 is NOT contentSnapshot! Type:', events[0].type);
    console.warn('[Seekbar] This proof file may have been created before initial content recording was added.');
  }

  currentEvents = events;
  finalContent = content || ''; // 最終コンテンツを保存
  currentEventIndex = events.length; // デフォルトは最終状態
  contentCache.clear(); // キャッシュをクリア
  timeSeekbar.style.display = 'block';

  // スライダーの最大値を設定
  seekbarSlider.max = events.length;
  seekbarSlider.value = events.length;

  // UI更新（コンテンツは再構築しない - 既に表示されているため）
  updateSeekbarUI();
  // reconstructCodeAtIndex(currentEventIndex); // 初期化時は再構築しない
}

/**
 * 指定したインデックスまでのコンテンツを再構築（キャッシュ付き）
 */
let contentCache = new Map(); // index -> content のキャッシュ

function getContentAtIndex(index) {
  // キャッシュチェック
  if (contentCache.has(index)) {
    console.log(`[Seekbar] Cache hit for index ${index}`);
    return contentCache.get(index);
  }

  console.log(`[Seekbar] Reconstructing content at index ${index}`);

  // index === 0: 空の初期状態
  if (index === 0) {
    const content = '';
    contentCache.set(index, content);
    console.log(`[Seekbar] Index 0: empty state`);
    return content;
  }

  // index === currentEvents.length: 最終状態
  if (index === currentEvents.length) {
    contentCache.set(index, finalContent);
    console.log(`[Seekbar] Index ${index}: final state (${finalContent.length} chars)`);
    return finalContent;
  }

  // 最も近いキャッシュされたインデックスを探す
  let startIndex = 0;
  let lines = [''];

  for (let i = index - 1; i >= 0; i--) {
    if (contentCache.has(i)) {
      startIndex = i;
      lines = contentCache.get(i).split('\n');
      console.log(`[Seekbar] Starting from cached index ${i}`);
      break;
    }
  }

  console.log(`[Seekbar] Applying events from ${startIndex} to ${index - 1}`);

  // startIndexからindexまでイベントを適用
  for (let i = startIndex; i < index && i < currentEvents.length; i++) {
    const event = currentEvents[i];

    // contentSnapshotイベントの場合
    if (event.type === 'contentSnapshot') {
      lines = (event.data || '').split('\n');
      console.log(`[Seekbar] Event ${i}: contentSnapshot (${event.data?.length || 0} chars)`);
      continue;
    }

    // contentChangeイベントの場合
    if (event.type === 'contentChange' && event.range) {
      const { startLineNumber, startColumn, endLineNumber, endColumn } = event.range;
      const text = event.data || '';

      console.log(`[Seekbar] Event ${i}: contentChange at ${startLineNumber}:${startColumn}-${endLineNumber}:${endColumn}, text: "${text.substring(0, 20)}..."`);

      // 開始行と終了行が存在することを確認（1-based → 0-based変換）
      while (lines.length < endLineNumber) {
        lines.push('');
      }

      // 削除範囲を計算
      if (startLineNumber === endLineNumber) {
        // 同じ行内での変更
        const line = lines[startLineNumber - 1] || '';
        const before = line.substring(0, startColumn - 1);
        const after = line.substring(endColumn - 1);

        console.log(`[Seekbar]   Before: "${before}", After: "${after}"`);

        // テキストを挿入
        const newText = before + text + after;
        const newLines = newText.split('\n');

        console.log(`[Seekbar]   Result: ${newLines.length} lines, first: "${newLines[0].substring(0, 30)}..."`);

        // 行を置き換え
        lines.splice(startLineNumber - 1, 1, ...newLines);
      } else {
        // 複数行にまたがる変更
        const startLine = lines[startLineNumber - 1] || '';
        const endLine = lines[endLineNumber - 1] || '';
        const before = startLine.substring(0, startColumn - 1);
        const after = endLine.substring(endColumn - 1);

        console.log(`[Seekbar]   Multi-line: deleting ${endLineNumber - startLineNumber + 1} lines`);

        // テキストを挿入
        const newText = before + text + after;
        const newLines = newText.split('\n');

        console.log(`[Seekbar]   Result: ${newLines.length} lines`);

        // 複数行を置き換え
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
function reconstructCodeAtIndex(index) {
  console.log('[Seekbar] Reconstructing code up to event index:', index);

  // getContentAtIndex を使ってコンテンツを取得
  const content = getContentAtIndex(index);
  const lines = content.split('\n');
  const preview = lines.slice(0, 100).join('\n'); // 最大100行表示
  contentPreview.textContent = preview + (lines.length > 100 ? '\n...' : '');
}

/**
 * シークバーUIを更新
 */
function updateSeekbarUI() {
  if (currentEvents.length === 0) return;

  const totalTime = currentEvents[currentEvents.length - 1]?.timestamp || 0;
  const currentTime = currentEventIndex > 0 && currentEventIndex <= currentEvents.length
    ? currentEvents[currentEventIndex - 1].timestamp
    : 0;

  seekbarTime.textContent = `${(currentTime / 1000).toFixed(2)}秒 / ${(totalTime / 1000).toFixed(2)}秒`;
  seekbarEventCount.textContent = `イベント: ${currentEventIndex} / ${currentEvents.length}`;
}

/**
 * 指定インデックスにシーク
 */
function seekToIndex(index) {
  currentEventIndex = Math.max(0, Math.min(index, currentEvents.length));
  seekbarSlider.value = currentEventIndex;
  updateSeekbarUI();
  reconstructCodeAtIndex(currentEventIndex);
}

// シークバーのイベントリスナー

// スライダー変更
seekbarSlider.addEventListener('input', (e) => {
  seekToIndex(parseInt(e.target.value));
});

// 最初に戻る
seekbarStart.addEventListener('click', () => {
  stopPlayback();
  seekToIndex(0);
});

// 前のイベント
seekbarPrev.addEventListener('click', () => {
  stopPlayback();
  seekToIndex(currentEventIndex - 1);
});

// 次のイベント
seekbarNext.addEventListener('click', () => {
  stopPlayback();
  seekToIndex(currentEventIndex + 1);
});

// 最後に進む
seekbarEnd.addEventListener('click', () => {
  stopPlayback();
  seekToIndex(currentEvents.length);
});

// 自動再生/停止
seekbarPlay.addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

/**
 * 自動再生を開始
 */
function startPlayback() {
  if (currentEventIndex >= currentEvents.length) {
    currentEventIndex = 0;
  }

  isPlaying = true;
  seekbarPlay.textContent = '⏸️';
  seekbarPlay.title = '一時停止';

  playInterval = setInterval(() => {
    if (currentEventIndex >= currentEvents.length) {
      stopPlayback();
      return;
    }

    seekToIndex(currentEventIndex + 1);
  }, 200); // 200msごとに1イベント進む
}

/**
 * 自動再生を停止
 */
function stopPlayback() {
  isPlaying = false;
  seekbarPlay.textContent = '▶️';
  seekbarPlay.title = '自動再生';

  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
}
