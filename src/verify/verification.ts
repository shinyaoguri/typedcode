import type { StoredEvent } from '../types.js';
import type { ProofFile } from './types.js';
import { TypingProof } from '../typingProof.js';
import {
  typingProofHashEl,
  copyHashBtn,
  pureTypingBadge,
  pasteInfo,
  deviceIdEl,
  totalEventsEl,
  insertEventsEl,
  deleteEventsEl,
  typingTimeEl,
  typingSpeedEl,
  chainValidBadge,
  chainMessage,
  poswValidBadge,
  poswMessage,
  poswIterationsEl,
  poswAvgTimeEl,
  poswTotalTimeEl,
  versionEl,
  languageEl,
  timestampEl,
  userAgentEl,
  contentPreview,
  externalInputPreview,
  externalInputList,
  resultSection,
} from './elements.js';
import {
  loadingLog,
  addLoadingLog,
  addLoadingLogWithHash,
  updateLoadingLog,
  showVerifying,
  showSuccess,
  showWarning,
  showError,
} from './ui.js';
import { initializeSeekbar } from './seekbar.js';

/**
 * 外部入力イベントを表示
 */
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

/**
 * PoSW統計を表示
 */
function displayPoSWStats(events: StoredEvent[], chainValid: boolean): void {
  // PoSWを含むイベントを抽出
  const eventsWithPoSW = events.filter(event => {
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
  let totalComputeTime = 0;
  const computeTimes: number[] = [];

  eventsWithPoSW.forEach(event => {
    const posw = (event as StoredEvent & { posw: { iterations: number; computeTimeMs: number } }).posw;
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
}

/**
 * 証明データの検証
 */
export async function verifyProofData(data: ProofFile): Promise<void> {
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
      } else {
        updateLoadingLog(chainLog, 'error', 'ハッシュ鎖: 検証失敗');
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '❌ 無効';
          chainValidBadge.className = 'badge error';
        }
        if (chainMessage) chainMessage.textContent = `エラー: ${chainVerification.message}`;
        chainError = chainVerification;
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
