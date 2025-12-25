import { TypingProof } from './typingProof.js';

// DOM要素
const codeInput = document.getElementById('code-input');
const hashInput = document.getElementById('hash-input');
const fileDropZone = document.getElementById('file-drop-zone');
const fileInput = document.getElementById('file-input');
const verifyBtn = document.getElementById('verify-btn');
const resultSection = document.getElementById('result-section');
const statusCard = document.getElementById('status-card');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const detailsGrid = document.getElementById('details-grid');
const hashValidBadge = document.getElementById('hash-valid-badge');
const hashMessage = document.getElementById('hash-message');
const pureTypingBadge = document.getElementById('pure-typing-badge');
const typingInfo = document.getElementById('typing-info');
const deviceIdEl = document.getElementById('device-id');
const totalEventsEl = document.getElementById('total-events');
const insertEventsEl = document.getElementById('insert-events');
const deleteEventsEl = document.getElementById('delete-events');
const pasteEventsEl = document.getElementById('paste-events');
const dropEventsEl = document.getElementById('drop-events');
const typingTimeEl = document.getElementById('typing-time');
const resetBtn = document.getElementById('reset-btn');

// ファイルドロップ処理
fileDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDropZone.classList.add('drag-over');
});

fileDropZone.addEventListener('dragleave', () => {
  fileDropZone.classList.remove('drag-over');
});

fileDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropZone.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFile(files[0]);
  }
});

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

    // データを入力欄に設定
    if (proofData.content) {
      codeInput.value = proofData.content;
    }
    if (proofData.typingProofHash) {
      hashInput.value = proofData.typingProofHash;
    }

    // 自動的に検証を実行
    if (proofData.content && proofData.typingProofHash && proofData.typingProofData) {
      await verifyHash(proofData.content, proofData.typingProofHash, proofData.typingProofData);
    }
  } catch (error) {
    console.error('[VerifyHash] Error reading file:', error);
    alert('ファイルの読み込みに失敗しました');
  }
}

// 検証ボタン
verifyBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  const hash = hashInput.value.trim();

  if (!code) {
    alert('コードを入力してください');
    return;
  }

  if (!hash) {
    alert('タイピング証明ハッシュを入力してください');
    return;
  }

  // 結果セクションを表示
  resultSection.style.display = 'block';
  resultSection.scrollIntoView({ behavior: 'smooth' });

  // 検証中表示
  showVerifying();

  try {
    // 警告を表示
    hashValidBadge.innerHTML = '⚠️ 制限あり';
    hashValidBadge.className = 'badge warning';
    hashMessage.textContent = 'コードとハッシュのみでは完全な検証ができません。タイピング証明ハッシュにはデバイスIDとイベント履歴が含まれるため、証明ファイル全体が必要です。';

    pureTypingBadge.innerHTML = '❓ 不明';
    pureTypingBadge.className = 'badge warning';
    typingInfo.textContent = '完全な検証には証明ファイル（JSON）を読み込んでください。';

    deviceIdEl.textContent = '-';
    totalEventsEl.textContent = '-';
    insertEventsEl.textContent = '-';
    deleteEventsEl.textContent = '-';
    pasteEventsEl.textContent = '-';
    dropEventsEl.textContent = '-';
    typingTimeEl.textContent = '-';

    detailsGrid.style.display = 'grid';
    showWarning('⚠️ コードとハッシュのみでは検証できません。証明ファイル（JSON）を読み込んでください。');
  } catch (error) {
    console.error('[VerifyHash] Verification error:', error);
    showError('エラーが発生しました', error.message);
  }
});

// 証明データ付きの検証
async function verifyHash(code, hash, proofData) {
  resultSection.style.display = 'block';
  resultSection.scrollIntoView({ behavior: 'smooth' });

  showVerifying();

  try {
    const typingProof = new TypingProof();

    // タイピング証明ハッシュを検証
    const verification = await typingProof.verifyTypingProofHash(hash, proofData, code);

    if (verification.valid) {
      // 検証成功
      hashValidBadge.innerHTML = '✅ 一致';
      hashValidBadge.className = 'badge success';
      hashMessage.textContent = 'コード、ハッシュ、証明データが全て一致しました';

      // 純粋なタイピング判定
      if (verification.isPureTyping) {
        pureTypingBadge.innerHTML = '✅ 純粋なタイピング';
        pureTypingBadge.className = 'badge success';
        typingInfo.textContent = 'このコードは純粋なタイピングのみで作成されました。コピー&ペーストは検出されていません。';
      } else {
        pureTypingBadge.innerHTML = '⚠️ 外部入力あり';
        pureTypingBadge.className = 'badge warning';
        const pasteCount = verification.metadata.pasteEvents || 0;
        const dropCount = verification.metadata.dropEvents || 0;
        typingInfo.textContent = `このコードにはコピー&ペースト(${pasteCount}回)またはドロップ(${dropCount}回)が含まれています。`;
      }

      // 統計情報
      deviceIdEl.textContent = verification.deviceId.substring(0, 16) + '...';
      deviceIdEl.title = verification.deviceId;
      totalEventsEl.textContent = verification.metadata.totalEvents;
      insertEventsEl.textContent = verification.metadata.insertEvents;
      deleteEventsEl.textContent = verification.metadata.deleteEvents;
      pasteEventsEl.textContent = verification.metadata.pasteEvents;
      dropEventsEl.textContent = verification.metadata.dropEvents;
      typingTimeEl.textContent = (verification.metadata.totalTypingTime / 1000).toFixed(2) + '秒';

      detailsGrid.style.display = 'grid';

      if (verification.isPureTyping) {
        showSuccess('✅ 検証成功：純粋なタイピングで作成されたコードです');
      } else {
        showWarning('⚠️ 検証成功：コピー&ペーストが含まれています');
      }
    } else {
      // 検証失敗
      hashValidBadge.innerHTML = '❌ 不一致';
      hashValidBadge.className = 'badge error';
      hashMessage.textContent = verification.reason || 'ハッシュが一致しません';

      pureTypingBadge.innerHTML = '-';
      pureTypingBadge.className = 'badge';
      typingInfo.textContent = '-';

      detailsGrid.style.display = 'none';
      showError('❌ 検証失敗', 'コードとハッシュが一致しません');
    }
  } catch (error) {
    console.error('[VerifyHash] Verification error:', error);
    showError('エラーが発生しました', error.message);
  }
}

// ステータス表示関数
function showVerifying() {
  statusCard.className = 'status-card verifying';
  statusIcon.textContent = '⏳';
  statusTitle.textContent = '検証中...';
  statusMessage.textContent = 'ハッシュを検証しています';
  detailsGrid.style.display = 'none';
}

function showSuccess(message) {
  statusCard.className = 'status-card success';
  statusIcon.textContent = '✅';
  statusTitle.textContent = '検証成功';
  statusMessage.textContent = message;
}

function showWarning(message) {
  statusCard.className = 'status-card warning';
  statusIcon.textContent = '⚠️';
  statusTitle.textContent = '警告';
  statusMessage.textContent = message;
}

function showError(title, message) {
  statusCard.className = 'status-card error';
  statusIcon.textContent = '❌';
  statusTitle.textContent = title;
  statusMessage.textContent = message;
}

// リセットボタン
resetBtn.addEventListener('click', () => {
  codeInput.value = '';
  hashInput.value = '';
  resultSection.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
