import type { StoredEvent, SampledVerificationResult, HumanAttestationEventData } from '@typedcode/shared';
import type { ProofFile } from './types.js';
import { TypingProof } from '@typedcode/shared';
import type { HumanAttestation } from './types.js';

// 新モジュールをインポート
import { VerificationEngine } from './core/VerificationEngine.js';
import { AttestationService } from './services/AttestationService.js';

// シングルトンインスタンス
const verificationEngine = new VerificationEngine();
const attestationService = new AttestationService();

// Re-export for external use
export { VerificationEngine } from './core/VerificationEngine.js';
export { AttestationService } from './services/AttestationService.js';

/**
 * イベントからHumanAttestationを抽出するヘルパー
 * @deprecated VerificationEngine.extractAttestations() を使用してください
 */
function extractAttestationFromEvent(event: StoredEvent | undefined): HumanAttestationEventData | null {
  if (!event) return null;
  if (event.type !== 'humanAttestation' && event.type !== 'preExportAttestation') return null;

  const data = event.data;
  if (!data || typeof data !== 'object') return null;

  const attestation = data as HumanAttestationEventData;
  if (
    typeof attestation.verified !== 'boolean' ||
    typeof attestation.score !== 'number' ||
    typeof attestation.action !== 'string' ||
    typeof attestation.timestamp !== 'string' ||
    typeof attestation.hostname !== 'string' ||
    typeof attestation.signature !== 'string'
  ) {
    return null;
  }

  return attestation;
}

/**
 * イベント#0からHumanAttestationを抽出（作成時認証）
 * @deprecated VerificationEngine.extractAttestations() を使用してください
 */
function extractAttestationFromFirstEvent(events: StoredEvent[]): HumanAttestationEventData | null {
  if (!events || events.length === 0) return null;
  const firstEvent = events[0];
  if (firstEvent?.type !== 'humanAttestation') return null;
  return extractAttestationFromEvent(firstEvent);
}

/**
 * preExportAttestationイベントを抽出（エクスポート前認証）
 * @deprecated VerificationEngine.extractAttestations() を使用してください
 */
function extractPreExportAttestation(events: StoredEvent[]): HumanAttestationEventData | null {
  if (!events || events.length === 0) return null;
  // 最後のpreExportAttestationイベントを探す
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'preExportAttestation') {
      return extractAttestationFromEvent(event);
    }
  }
  return null;
}
import {
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
  createAttestationItem,
  createAttestationBadge,
  createAttestationTime,
  exportAttestationItem,
  exportAttestationBadge,
  exportAttestationTime,
  legacyAttestationItem,
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

/**
 * 人間証明書をサーバーで検証
 * @deprecated AttestationService.verify() を使用してください
 */
async function verifyHumanAttestation(attestation: HumanAttestation): Promise<{ valid: boolean; message: string }> {
  // 新しいサービスに委譲
  return attestationService.verify(attestation);
}

/**
 * タイムスタンプをフォーマット
 * @deprecated AttestationService.formatTimestamp() を使用してください
 */
function formatAttestationTime(timestamp: string): string {
  // 新しいサービスに委譲
  return attestationService.formatTimestamp(timestamp);
}

/**
 * 単一のattestation項目を検証・表示
 */
async function verifySingleAttestation(
  attestation: HumanAttestation | HumanAttestationEventData,
  badgeEl: HTMLElement | null,
  timeEl: HTMLElement | null,
  itemEl: HTMLElement | null,
  logLabel: string
): Promise<boolean> {
  if (!itemEl) return true;
  itemEl.style.display = 'flex';

  const verifyLog = addLoadingLog(`人間証明書を検証中 (${logLabel})...`);

  const result = await verifyHumanAttestation(attestation);

  if (result.valid) {
    updateLoadingLog(verifyLog, 'success', `人間証明書: 有効 (${logLabel})`);
    if (badgeEl) {
      badgeEl.innerHTML = '✅ 有効';
      badgeEl.className = 'badge-inline success';
    }
  } else {
    updateLoadingLog(verifyLog, 'error', `人間証明書: 無効 (${logLabel}) - ${result.message}`);
    if (badgeEl) {
      badgeEl.innerHTML = '❌ 無効';
      badgeEl.className = 'badge-inline error';
    }
  }

  if (timeEl) {
    timeEl.textContent = formatAttestationTime(attestation.timestamp);
  }

  return result.valid;
}

/**
 * 人間証明書を表示（新形式: 作成時 + エクスポート時の2つ）
 */
async function displayHumanAttestations(
  createAttestation: HumanAttestationEventData | null,
  exportAttestation: HumanAttestationEventData | null,
  legacyAttestation: HumanAttestation | undefined
): Promise<boolean> {
  if (!humanAttestationSection) return true;
  humanAttestationSection.style.display = 'table-row';

  // すべての項目を非表示に初期化
  if (createAttestationItem) createAttestationItem.style.display = 'none';
  if (exportAttestationItem) exportAttestationItem.style.display = 'none';
  if (legacyAttestationItem) legacyAttestationItem.style.display = 'none';

  let allValid = true;

  // 新形式: 作成時 + エクスポート時の両方がある場合
  if (createAttestation && exportAttestation) {
    const createValid = await verifySingleAttestation(
      createAttestation,
      createAttestationBadge,
      createAttestationTime,
      createAttestationItem,
      '作成時'
    );
    const exportValid = await verifySingleAttestation(
      exportAttestation,
      exportAttestationBadge,
      exportAttestationTime,
      exportAttestationItem,
      'エクスポート時'
    );
    allValid = createValid && exportValid;
  }
  // 新形式: 作成時のみ（エクスポート前検証なし）
  else if (createAttestation) {
    allValid = await verifySingleAttestation(
      createAttestation,
      createAttestationBadge,
      createAttestationTime,
      createAttestationItem,
      '作成時'
    );
  }
  // 旧形式: トップレベルのhumanAttestation
  else if (legacyAttestation) {
    if (legacyAttestationItem) legacyAttestationItem.style.display = 'flex';
    const verifyLog = addLoadingLog('人間証明書を検証中 (旧形式)...');
    const result = await verifyHumanAttestation(legacyAttestation);

    if (result.valid) {
      updateLoadingLog(verifyLog, 'success', '人間証明書: 有効 (旧形式)');
      if (humanAttestationBadge) {
        humanAttestationBadge.innerHTML = '✅ 検証済み（旧形式）';
        humanAttestationBadge.className = 'badge-inline success';
      }
      if (humanAttestationMessage) {
        humanAttestationMessage.textContent = 'エクスポート時に認証';
      }
    } else {
      updateLoadingLog(verifyLog, 'error', `人間証明書: 無効 - ${result.message}`);
      if (humanAttestationBadge) {
        humanAttestationBadge.innerHTML = '❌ 無効';
        humanAttestationBadge.className = 'badge-inline error';
      }
      if (humanAttestationMessage) {
        humanAttestationMessage.textContent = result.message;
      }
    }
    allValid = result.valid;
  }
  // 証明書なし
  else {
    if (legacyAttestationItem) legacyAttestationItem.style.display = 'flex';
    if (humanAttestationBadge) {
      humanAttestationBadge.innerHTML = '⚠️ なし';
      humanAttestationBadge.className = 'badge-inline warning';
    }
    if (humanAttestationMessage) {
      humanAttestationMessage.textContent = '人間証明書が含まれていません';
    }
    // 証明書なしでも検証自体は成功扱い
    allValid = true;
  }

  // 旧形式の隠し要素も更新（互換性のため）
  const attestation = createAttestation ?? legacyAttestation;
  if (attestation) {
    if (humanAttestationScore) {
      const score = attestation.score;
      humanAttestationScore.textContent = Number.isFinite(score) && score >= 0 && score <= 1
        ? `${score.toFixed(2)}`
        : '-';
    }
    if (humanAttestationTimestamp) {
      humanAttestationTimestamp.textContent = attestation.timestamp;
    }
    if (humanAttestationHostname) {
      humanAttestationHostname.textContent = attestation.hostname;
    }
  }

  return allValid;
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
 * Workerで計算済みのPoSW統計を表示
 */
function displayPoSWStatsFromPreVerified(
  poswStats: { count: number; avgTimeMs: number; totalTimeMs: number; iterations: number },
  chainValid: boolean
): void {
  // 表示を更新
  if (chainValid) {
    if (poswValidBadge) {
      poswValidBadge.innerHTML = '✅ 検証済み';
      poswValidBadge.className = 'badge success';
    }
    if (poswMessage) poswMessage.textContent = `全${poswStats.count}イベントのPoSWが検証されました`;
  } else {
    if (poswValidBadge) {
      poswValidBadge.innerHTML = '❌ 検証失敗';
      poswValidBadge.className = 'badge error';
    }
    if (poswMessage) poswMessage.textContent = 'ハッシュ鎖検証に失敗したためPoSWも無効';
  }

  // 統計を表示
  if (poswIterationsEl) {
    poswIterationsEl.textContent = `${poswStats.iterations.toLocaleString()}回/イベント`;
  }
  if (poswAvgTimeEl) {
    poswAvgTimeEl.textContent = `${poswStats.avgTimeMs.toFixed(1)}ms`;
  }
  if (poswTotalTimeEl) {
    poswTotalTimeEl.textContent = `${(poswStats.totalTimeMs / 1000).toFixed(2)}秒`;
  }
}

// イベント数の上限（パフォーマンス保護）
const MAX_EVENTS = 100000;

/**
 * 処理進捗イベントを発火
 */
function emitProgress(phase: string, message: string, progress?: number): void {
  window.dispatchEvent(new CustomEvent('verification-progress', {
    detail: { phase, message, progress }
  }));
}

/** 検証済み結果（Workerから渡される場合） */
export interface PreVerifiedResult {
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  poswStats?: {
    count: number;
    avgTimeMs: number;
    totalTimeMs: number;
    iterations: number;
  };
  sampledResult?: {
    sampledSegments: Array<{
      startIndex: number;
      endIndex: number;
      eventCount: number;
      startHash: string;
      endHash: string;
      verified: boolean;
    }>;
    totalSegments: number;
    totalEventsVerified: number;
    totalEvents: number;
  };
}

/**
 * 証明データの検証
 * @param data 証明データ
 * @param preVerified Workerで検証済みの結果（省略時は全て再検証）
 */
export async function verifyProofData(data: ProofFile, preVerified?: PreVerifiedResult): Promise<void> {
  const skipChainVerification = preVerified !== undefined;

  // preVerified がある場合は検証済みなので「検証中」表示をスキップ
  if (!skipChainVerification) {
    // メタデータ確認ログ
    emitProgress('metadata', 'メタデータを確認中...', 0);
    const metaLog = addLoadingLog('メタデータを確認中...');

    showVerifying();
    updateLoadingLog(metaLog, 'success', `バージョン ${data.version ?? 'unknown'} を検出`);
  }

  // イベント数上限チェック
  if (data.proof?.events && data.proof.events.length > MAX_EVENTS) {
    showError('イベント数が多すぎます', `最大${MAX_EVENTS.toLocaleString()}イベントまで対応しています（${data.proof.events.length.toLocaleString()}イベント検出）`);
    return;
  }

  try {
    const typingProof = new TypingProof();

    // 1. メタデータ整合性の検証（最終コードとメタデータが改竄されていないか）
    let metadataValid = false;
    let isPureTyping = false;

    if (skipChainVerification && preVerified) {
      // Workerで検証済みの結果を使用
      metadataValid = preVerified.metadataValid;
      isPureTyping = preVerified.isPureTyping;
      addLoadingLog('メタデータ: 検証済み', 'success');
    } else if (data.typingProofHash && data.typingProofData && data.content) {
      const hashLog = addLoadingLog('メタデータ整合性を検証中...');

      const hashVerification = await typingProof.verifyTypingProofHash(
        data.typingProofHash,
        data.typingProofData,
        data.content
      );

      metadataValid = hashVerification.valid;
      isPureTyping = hashVerification.isPureTyping ?? false;

      if (metadataValid) {
        updateLoadingLog(hashLog, 'success', 'メタデータ: 整合');
      } else {
        updateLoadingLog(hashLog, 'error', 'メタデータ: 不整合');
      }
    }

    // UI表示（検証済みでも必要）
    if (data.typingProofHash && data.typingProofData && data.content) {
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

    if (skipChainVerification && preVerified) {
      // Workerで検証済みの結果を使用（再検証をスキップ）
      emitProgress('chain', 'ハッシュ鎖: 検証済み', 50);
      chainValid = preVerified.chainValid;

      const eventCount = data.proof?.events?.length ?? 0;
      const hasCheckpoints = data.checkpoints && data.checkpoints.length > 0;

      addLoadingLog(`ハッシュ鎖: ${eventCount} イベント 検証済み`, 'success');

      if (chainValid) {
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
        if (chainValidBadge) {
          chainValidBadge.innerHTML = '❌ 無効';
          chainValidBadge.className = 'badge error';
        }
        if (chainMessage) chainMessage.textContent = 'ハッシュ鎖の検証に失敗しました';
        chainError = { message: 'ハッシュ鎖の検証に失敗しました' };
      }

      // サンプリング検証結果を表示
      if (preVerified.sampledResult) {
        displaySampledVerification(preVerified.sampledResult);
      }

      // PoSW統計を表示（Workerで計算済み）
      emitProgress('posw', 'PoSW統計を表示中...', 60);
      if (preVerified.poswStats && data.proof?.events) {
        displayPoSWStatsFromPreVerified(preVerified.poswStats, chainValid);
      }
      addLoadingLog('PoSW: 検証済み', 'success');
    } else if (data.proof?.events) {
      // 通常の検証（Workerを使わない場合）
      emitProgress('chain', 'ハッシュ鎖を検証中...', 20);
      const eventCount = data.proof.events.length;
      const hasCheckpoints = data.checkpoints && data.checkpoints.length > 0;
      const verificationMode = hasCheckpoints ? 'サンプリング' : '全件';
      const chainLog = addLoadingLogWithHash(`ハッシュ鎖を検証中 (${verificationMode})... (0/${eventCount})`);

      typingProof.events = data.proof.events;
      typingProof.currentHash = data.proof.finalHash;

      let chainVerification;

      // DOM要素をキャッシュ（コールバック内での繰り返しquerySelector呼び出しを避ける）
      const msgEl = chainLog.querySelector('.log-message');
      const hashEl = chainLog.querySelector('.log-hash-display');

      if (hasCheckpoints) {
        // サンプリング検証（チェックポイントあり）
        const onSampledProgress = (phase: string, current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash?: string }): void => {
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
            msgEl.textContent = `ハッシュ鎖を検証中 (${verificationMode})... ${phaseLabel}`;
          }

          if (hashEl && hashInfo) {
            const shortHash = hashInfo.computed.substring(0, 16);
            const poswShort = hashInfo.poswHash?.substring(0, 12) ?? '-';
            hashEl.innerHTML = `<span class="hash-chain">${shortHash}...</span> <span class="hash-posw">PoSW:${poswShort}</span>`;
          }
        };

        chainVerification = await typingProof.verifySampled(data.checkpoints!, 3, onSampledProgress);
      } else {
        // 全件検証（チェックポイントなし - 旧バージョン互換）
        const onProgress = (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }): void => {
          if (msgEl) {
            const percent = Math.round((current / total) * 100);
            msgEl.textContent = `ハッシュ鎖を検証中 (${verificationMode})... (${current}/${total}) ${percent}%`;
          }
          if (hashEl && hashInfo) {
            const shortHash = hashInfo.computed.substring(0, 16);
            const poswShort = hashInfo.poswHash.substring(0, 12);
            hashEl.innerHTML = `<span class="hash-chain">${shortHash}...</span> <span class="hash-posw">PoSW:${poswShort}</span>`;
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
      emitProgress('posw', 'PoSW統計を計算中...', 60);
      const poswLog = addLoadingLog('PoSW (Proof of Sequential Work) を検証中...');

      // 2b. PoSW統計を表示
      displayPoSWStats(data.proof.events, chainValid);
      updateLoadingLog(poswLog, 'success', 'PoSW検証完了');
    }

    // 3. 人間証明書の検証
    emitProgress('attestation', '人間証明書を検証中...', 70);
    // イベント#0から作成時attestation、preExportAttestationからエクスポート時attestationを探す
    const createAttestation = data.proof?.events ? extractAttestationFromFirstEvent(data.proof.events) : null;
    const exportAttestation = data.proof?.events ? extractPreExportAttestation(data.proof.events) : null;

    // 新しいdisplayHumanAttestations関数を使用
    await displayHumanAttestations(createAttestation, exportAttestation, data.humanAttestation);

    // 4. メタデータ表示
    emitProgress('display', 'データを表示中...', 80);
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
    emitProgress('chart', '分析チャートを生成中...', 90);
    const uiLog = addLoadingLog('分析チャートを生成中...');
    updateLoadingLog(uiLog, 'success', 'チャート生成完了');

    // 検証完了ログ
    emitProgress('complete', '完了', 100);
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
    const allValid = metadataValid && chainValid;

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
