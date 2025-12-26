import type { StoredEvent, SampledVerificationResult } from '@typedcode/shared';
import type { ProofFile } from './types.js';
import { TypingProof } from '@typedcode/shared';
import type { HumanAttestation } from './types.js';
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
  sampledVerification,
  sampledSummary,
  sampledSegments,
  poswValidBadge,
  poswMessage,
  poswIterationsEl,
  poswAvgTimeEl,
  poswTotalTimeEl,
  humanAttestationSection,
  humanAttestationBadge,
  humanAttestationMessage,
  humanAttestationScore,
  humanAttestationTimestamp,
  humanAttestationHostname,
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
import { cacheEventsForModal } from './charts.js';

// API URL for attestation verification
const API_URL = 'https://typedcode-api.shinya-oguri.workers.dev';

/**
 * 人間証明書をサーバーで検証
 */
async function verifyHumanAttestation(attestation: HumanAttestation): Promise<{ valid: boolean; message: string }> {
  try {
    const response = await fetch(`${API_URL}/api/verify-attestation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attestation }),
    });

    if (!response.ok) {
      return { valid: false, message: `HTTP ${response.status}` };
    }

    const result = await response.json() as { valid: boolean; message: string };
    return result;
  } catch (error) {
    console.error('[Verify] Attestation verification failed:', error);
    return { valid: false, message: 'ネットワークエラー' };
  }
}

/**
 * 人間証明書を表示
 */
async function displayHumanAttestation(attestation: HumanAttestation | undefined): Promise<boolean> {
  if (!humanAttestationSection) return true; // 要素がなければスキップ

  if (!attestation) {
    // 証明書なし
    humanAttestationSection.style.display = 'table-row';
    if (humanAttestationBadge) {
      humanAttestationBadge.innerHTML = '⚠️ なし';
      humanAttestationBadge.className = 'badge warning';
    }
    if (humanAttestationMessage) {
      humanAttestationMessage.textContent = '人間証明書が含まれていません（reCAPTCHA未検証）';
    }
    if (humanAttestationScore) humanAttestationScore.textContent = '-';
    if (humanAttestationTimestamp) humanAttestationTimestamp.textContent = '-';
    if (humanAttestationHostname) humanAttestationHostname.textContent = '-';
    return true; // 証明書なしでも検証自体は成功扱い
  }

  humanAttestationSection.style.display = 'table-row';

  // サーバーで署名を検証
  const verifyLog = addLoadingLog('人間証明書を検証中...');
  await new Promise(r => setTimeout(r, 50));

  const result = await verifyHumanAttestation(attestation);

  if (result.valid) {
    updateLoadingLog(verifyLog, 'success', '人間証明書: 有効（署名検証OK）');
    if (humanAttestationBadge) {
      humanAttestationBadge.innerHTML = '✅ 検証済み';
      humanAttestationBadge.className = 'badge success';
    }
    if (humanAttestationMessage) {
      humanAttestationMessage.textContent = 'サーバー署名が正常に検証されました';
    }
  } else {
    updateLoadingLog(verifyLog, 'error', `人間証明書: 無効 (${result.message})`);
    if (humanAttestationBadge) {
      humanAttestationBadge.innerHTML = '❌ 無効';
      humanAttestationBadge.className = 'badge error';
    }
    if (humanAttestationMessage) {
      humanAttestationMessage.textContent = `署名検証に失敗: ${result.message}`;
    }
  }

  // 詳細を表示
  if (humanAttestationScore) {
    humanAttestationScore.textContent = `${attestation.score.toFixed(2)} (${attestation.score >= 0.5 ? '人間' : 'ボット疑い'})`;
  }
  if (humanAttestationTimestamp) {
    humanAttestationTimestamp.textContent = attestation.timestamp;
  }
  if (humanAttestationHostname) {
    humanAttestationHostname.textContent = attestation.hostname;
  }

  return result.valid;
}

/**
 * サンプリング検証結果を表示
 */
function displaySampledVerification(result: SampledVerificationResult): void {
  if (!sampledVerification || !sampledSummary || !sampledSegments) return;

  sampledVerification.style.display = 'block';

  // サマリー表示
  const percentage = ((result.totalEventsVerified / result.totalEvents) * 100).toFixed(1);
  sampledSummary.innerHTML = `
    <div class="sampled-summary-text">
      <strong>サンプリング検証:</strong>
      ${result.sampledSegments.length} / ${result.totalSegments} 区間を検証
      (${result.totalEventsVerified} / ${result.totalEvents} イベント, ${percentage}%)
    </div>
  `;

  // 各区間の詳細を表示
  let segmentsHtml = '<div class="sampled-segments-list">';
  for (const segment of result.sampledSegments) {
    const statusIcon = segment.verified ? '✅' : '❌';
    const statusClass = segment.verified ? 'verified' : 'failed';
    segmentsHtml += `
      <div class="sampled-segment-item ${statusClass}">
        <span class="segment-status">${statusIcon}</span>
        <span class="segment-range">イベント ${segment.startIndex} - ${segment.endIndex}</span>
        <span class="segment-count">(${segment.eventCount} イベント)</span>
        <div class="segment-hashes">
          <span class="segment-hash" title="${segment.startHash}">開始: ${segment.startHash.substring(0, 12)}...</span>
          <span class="segment-hash" title="${segment.endHash}">終了: ${segment.endHash.substring(0, 12)}...</span>
        </div>
      </div>
    `;
  }
  segmentsHtml += '</div>';
  sampledSegments.innerHTML = segmentsHtml;
}

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

    // 2. ハッシュ鎖の検証（チェックポイントがあればサンプリング検証）
    let chainValid = false;
    let chainError: { message: string } | null = null;

    if (data.proof?.events) {
      const eventCount = data.proof.events.length;
      const hasCheckpoints = data.checkpoints && data.checkpoints.length > 0;
      const verificationMode = hasCheckpoints ? 'サンプリング' : '全件';
      const chainLog = addLoadingLogWithHash(`ハッシュ鎖を検証中 (${verificationMode})... (0/${eventCount})`);
      await new Promise(r => setTimeout(r, 50));

      typingProof.events = data.proof.events;
      typingProof.currentHash = data.proof.finalHash;

      let chainVerification;

      if (hasCheckpoints) {
        // サンプリング検証（チェックポイントあり）
        let currentPhase = '';
        const onSampledProgress = (phase: string, current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash?: string }): void => {
          const msgEl = chainLog.querySelector('.log-message');
          const hashEl = chainLog.querySelector('.log-hash-display');

          let phaseLabel = '';
          switch (phase) {
            case 'checkpoint':
              phaseLabel = `チェックポイント検証 (${current}/${total})`;
              break;
            case 'segment':
              phaseLabel = `区間検証 (${current}/${total})`;
              break;
            case 'final':
              phaseLabel = '最終ハッシュ検証';
              break;
            case 'fallback':
              phaseLabel = 'フォールバック: 全件検証';
              break;
            default:
              phaseLabel = `検証中 (${current}/${total})`;
          }

          if (msgEl) {
            if (phase !== currentPhase) {
              currentPhase = phase;
            }
            msgEl.textContent = `ハッシュ鎖を検証中 (${verificationMode})... ${phaseLabel}`;
          }

          if (hashEl && hashInfo) {
            const shortHash = hashInfo.computed.substring(0, 16);
            const poswShort = hashInfo.poswHash?.substring(0, 12) ?? '-';
            hashEl.innerHTML = `<span class="hash-chain">${shortHash}...</span> <span class="hash-posw">PoSW:${poswShort}</span>`;

            if (loadingLog.container) {
              loadingLog.container.scrollTop = loadingLog.container.scrollHeight;
            }
          }
        };

        chainVerification = await typingProof.verifySampled(data.checkpoints!, 3, onSampledProgress);
      } else {
        // 全件検証（チェックポイントなし - 旧バージョン互換）
        const onProgress = (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }): void => {
          const msgEl = chainLog.querySelector('.log-message');
          const hashEl = chainLog.querySelector('.log-hash-display');
          if (msgEl) {
            const percent = Math.round((current / total) * 100);
            msgEl.textContent = `ハッシュ鎖を検証中 (${verificationMode})... (${current}/${total}) ${percent}%`;
          }
          if (hashEl && hashInfo) {
            const shortHash = hashInfo.computed.substring(0, 16);
            const poswShort = hashInfo.poswHash.substring(0, 12);
            hashEl.innerHTML = `<span class="hash-chain">${shortHash}...</span> <span class="hash-posw">PoSW:${poswShort}</span>`;

            if (loadingLog.container) {
              loadingLog.container.scrollTop = loadingLog.container.scrollHeight;
            }
          }
        };

        chainVerification = await typingProof.verify(onProgress);
      }

      chainValid = chainVerification.valid;

      if (chainValid) {
        const checkpointInfo = hasCheckpoints ? ` (${data.checkpoints!.length}チェックポイント)` : '';
        updateLoadingLog(chainLog, 'success', `ハッシュ鎖: ${eventCount} イベント検証完了${checkpointInfo}`);
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '✅ 有効';
          chainValidBadge.className = 'badge success';
        }
        if (chainMessage) {
          const modeInfo = hasCheckpoints
            ? `サンプリング検証で${data.checkpoints!.length}チェックポイントを使用`
            : '全イベントを検証';
          chainMessage.textContent = `${modeInfo}して正常に検証されました`;
        }
      } else {
        updateLoadingLog(chainLog, 'error', 'ハッシュ鎖: 検証失敗');
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '❌ 無効';
          chainValidBadge.className = 'badge error';
        }
        if (chainMessage) chainMessage.textContent = `エラー: ${chainVerification.message}`;
        chainError = chainVerification;
      }

      // サンプリング検証結果を表示
      if (chainVerification.sampledResult) {
        displaySampledVerification(chainVerification.sampledResult);
      }

      // PoSW検証ログ
      const poswLog = addLoadingLog('PoSW (Proof of Sequential Work) を検証中...');
      await new Promise(r => setTimeout(r, 50));

      // 2b. PoSW統計を表示
      displayPoSWStats(data.proof.events, chainValid);
      updateLoadingLog(poswLog, 'success', 'PoSW検証完了');
    }

    // 3. 人間証明書の検証
    await displayHumanAttestation(data.humanAttestation);

    // 4. メタデータ表示
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
      resultSection.style.display = 'flex';
    }

    // 5. タイムシークバーの初期化（結果セクション表示後にチャートを描画）
    if (data.proof?.events) {
      // モーダル用にイベントデータをキャッシュ
      cacheEventsForModal(data.proof.events, data.proof.events);
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
