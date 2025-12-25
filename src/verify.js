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
      } else {
        chainValidBadge.innerHTML = '❌ 無効';
        chainValidBadge.className = 'badge error';
        chainMessage.textContent = `エラー: ${chainVerification.message}`;
        chainError = chainVerification;
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
