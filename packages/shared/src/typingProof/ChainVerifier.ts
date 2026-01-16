/**
 * ChainVerifier - チェーン検証
 * 完全検証/サンプリング検証ロジックを担当
 */

import type {
  StoredEvent,
  VerificationResult,
  EventHashData,
  CheckpointData,
  SampledSegmentInfo
} from '../types.js';
import { HashChainManager } from './HashChainManager.js';
import { PoswManager } from './PoswManager.js';

interface SegmentInfo {
  startIndex: number;
  endIndex: number;
  startHash: string;
  expectedEndHash: string;
}

/**
 * 単一イベント検証の結果
 */
interface EventVerificationResult {
  valid: boolean;
  error?: VerificationResult;
  newHash?: string;
  newTimestamp?: number;
  hashInfo?: { computed: string; expected: string; poswHash: string };
}

export class ChainVerifier {
  private hashChainManager: HashChainManager;
  private poswManager: PoswManager;

  constructor(hashChainManager: HashChainManager, poswManager: PoswManager) {
    this.hashChainManager = hashChainManager;
    this.poswManager = poswManager;
  }

  /**
   * 単一イベントを検証
   * シーケンス番号、タイムスタンプ、previousHash、PoSW、ハッシュを検証
   * @param event - 検証するイベント
   * @param index - イベントのインデックス
   * @param expectedPreviousHash - 期待されるpreviousHash
   * @param lastTimestamp - 前のイベントのタイムスタンプ
   * @param checkPreviousHash - previousHashのチェックを行うか（セグメント検証時はfalse）
   * @private
   */
  private async verifyEvent(
    event: StoredEvent,
    index: number,
    expectedPreviousHash: string | null,
    lastTimestamp: number,
    checkPreviousHash: boolean = true
  ): Promise<EventVerificationResult> {
    // シーケンス番号チェック
    if (event.sequence !== index) {
      return {
        valid: false,
        error: {
          valid: false,
          errorAt: index,
          message: `Sequence mismatch at event ${index}: expected ${index}, got ${event.sequence}`,
          event
        }
      };
    }

    // タイムスタンプ連続性チェック
    if (event.timestamp < lastTimestamp) {
      return {
        valid: false,
        error: {
          valid: false,
          errorAt: index,
          message: `Timestamp violation at event ${index}: time moved backward from ${lastTimestamp.toFixed(2)}ms to ${event.timestamp.toFixed(2)}ms`,
          event,
          previousTimestamp: lastTimestamp,
          currentTimestamp: event.timestamp
        }
      };
    }

    // previousHashチェック（保存されたpreviousHashが期待値と一致するか）
    if (checkPreviousHash && event.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        error: {
          valid: false,
          errorAt: index,
          message: `Previous hash mismatch at event ${index}: stored previousHash doesn't match computed chain`,
          event,
          expectedHash: expectedPreviousHash ?? undefined,
          computedHash: event.previousHash ?? undefined
        }
      };
    }

    // PoSW検証のためのデータ（poswフィールドなし）
    const eventDataWithoutPoSW = {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      inputType: event.inputType,
      data: event.data,
      rangeOffset: event.rangeOffset,
      rangeLength: event.rangeLength,
      range: event.range,
      previousHash: event.previousHash
    };

    // PoSW検証（決定的なJSON文字列化を使用）
    const eventDataStringForPoSW = this.hashChainManager.deterministicStringify(eventDataWithoutPoSW);
    const poswValid = await this.poswManager.verifyPoSW(expectedPreviousHash ?? '', eventDataStringForPoSW, event.posw);

    if (!poswValid) {
      console.error(`[ChainVerifier] PoSW verification failed at event ${index}:`, {
        posw: event.posw,
        previousHash: expectedPreviousHash
      });
      return {
        valid: false,
        error: {
          valid: false,
          errorAt: index,
          message: `PoSW verification failed at event ${index}: invalid proof of work`,
          event
        }
      };
    }

    // recordEvent()で使用したのと同じフィールドを再構築（PoSW含む）
    const eventData: EventHashData = {
      ...eventDataWithoutPoSW,
      posw: event.posw
    };

    // 決定的なJSON文字列化を使用
    const eventString = this.hashChainManager.deterministicStringify(eventData);
    const combinedData = expectedPreviousHash + eventString;
    const computedHash = await this.hashChainManager.computeHash(combinedData);

    if (computedHash !== event.hash) {
      console.error(`[ChainVerifier] Hash mismatch at event ${index}:`, {
        event,
        eventData,
        eventStringLength: eventString.length,
        previousHash: expectedPreviousHash,
        expectedHash: event.hash,
        computedHash
      });
      return {
        valid: false,
        error: {
          valid: false,
          errorAt: index,
          message: `Hash mismatch at event ${index}`,
          event,
          eventData,
          expectedHash: event.hash,
          computedHash
        }
      };
    }

    return {
      valid: true,
      newHash: computedHash,
      newTimestamp: event.timestamp,
      hashInfo: {
        computed: computedHash,
        expected: event.hash,
        poswHash: event.posw.intermediateHash
      }
    };
  }

  /**
   * ハッシュ鎖を検証（PoSW検証含む）
   * @param events - 検証するイベント配列
   * @param onProgress - 進捗コールバック (current, total, hashInfo?) => void
   */
  async verify(
    events: StoredEvent[],
    onProgress?: (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => void
  ): Promise<VerificationResult> {
    let hash = events[0]?.previousHash ?? null;
    let lastTimestamp = -Infinity;
    const total = events.length;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;

      const result = await this.verifyEvent(event, i, hash, lastTimestamp, true);

      if (!result.valid) {
        return result.error!;
      }

      hash = result.newHash!;
      lastTimestamp = result.newTimestamp!;

      // 進捗を報告（UIスレッドに制御を戻すためにyield）
      if (onProgress && result.hashInfo) {
        onProgress(i + 1, total, result.hashInfo);
        // 毎回UIスレッドに制御を戻す（ハッシュ表示をリアルタイム更新）
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return {
      valid: true,
      message: 'All hashes verified successfully (including PoSW)'
    };
  }

  /**
   * チェックポイントを使用したサンプリング検証
   * ランダムな区間をサンプリングして、開始ハッシュから再計算し終了ハッシュと一致するか検証
   * @param events - イベント配列
   * @param checkpoints - チェックポイントデータ
   * @param sampleCount - サンプリングする区間数（デフォルト: 3）
   * @param onProgress - 進捗コールバック
   */
  async verifySampled(
    events: StoredEvent[],
    checkpoints: CheckpointData[],
    sampleCount: number = 3,
    onProgress?: (phase: string, current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash?: string }) => void
  ): Promise<VerificationResult> {
    // チェックポイントがない場合は全検証にフォールバック
    if (!checkpoints || checkpoints.length === 0) {
      onProgress?.('fallback', 0, events.length);
      return await this.verify(events, (current, total, hashInfo) => {
        onProgress?.('full', current, total, hashInfo);
      });
    }

    // チェックポイントをソート（念のため）
    const sortedCheckpoints = [...checkpoints].sort((a, b) => a.eventIndex - b.eventIndex);

    // 検証対象の区間を構築（チェックポイント間）
    const allSegments = this.buildCheckpointSegments(sortedCheckpoints, events);

    // ランダムにサンプリング
    const selectedSegments = this.selectRandomSegments(allSegments, sampleCount);

    // 検証対象のイベント総数を計算
    let totalEventsToVerify = 0;
    for (const seg of selectedSegments) {
      totalEventsToVerify += seg.endIndex - seg.startIndex + 1;
    }

    onProgress?.('checkpoint', 0, selectedSegments.length);

    // サンプリング結果を記録
    const sampledSegmentInfos: SampledSegmentInfo[] = [];

    // 各区間を再計算して検証
    let verifiedCount = 0;
    for (let segIdx = 0; segIdx < selectedSegments.length; segIdx++) {
      const segment = selectedSegments[segIdx]!;

      // 区間を再計算検証（開始ハッシュから計算し、終了ハッシュと一致するか）
      const result = await this.verifySegmentWithExpectedEnd(
        events,
        segment.startIndex,
        segment.endIndex,
        segment.startHash,
        segment.expectedEndHash,
        (_current, _total, hashInfo) => {
          verifiedCount++;
          onProgress?.('segment', verifiedCount, totalEventsToVerify, hashInfo);
        }
      );

      // サンプリング結果を記録
      sampledSegmentInfos.push({
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        eventCount: segment.endIndex - segment.startIndex + 1,
        startHash: segment.startHash,
        endHash: segment.expectedEndHash,
        verified: result.valid
      });

      if (!result.valid) {
        return {
          ...result,
          sampledResult: {
            sampledSegments: sampledSegmentInfos,
            totalSegments: allSegments.length,
            totalEventsVerified: verifiedCount,
            totalEvents: events.length
          }
        };
      }

      onProgress?.('checkpoint', segIdx + 1, selectedSegments.length, {
        computed: result.computedHash ?? '',
        expected: segment.expectedEndHash
      });
    }

    return {
      valid: true,
      message: `Sampling verification passed (${selectedSegments.length} segments, ${verifiedCount} events verified out of ${events.length} total)`,
      sampledResult: {
        sampledSegments: sampledSegmentInfos,
        totalSegments: allSegments.length,
        totalEventsVerified: verifiedCount,
        totalEvents: events.length
      }
    };
  }

  /**
   * チェックポイント間の区間を構築
   * 各区間は開始ハッシュと期待される終了ハッシュを持つ
   */
  private buildCheckpointSegments(
    checkpoints: CheckpointData[],
    events: StoredEvent[]
  ): SegmentInfo[] {
    const segments: SegmentInfo[] = [];

    // 最初の区間: イベント0 から 最初のチェックポイントまで
    if (checkpoints.length > 0 && checkpoints[0]!.eventIndex >= 0) {
      const firstCp = checkpoints[0]!;
      segments.push({
        startIndex: 0,
        endIndex: firstCp.eventIndex,
        startHash: events[0]?.previousHash ?? '',
        expectedEndHash: firstCp.hash
      });
    }

    // チェックポイント間の区間
    for (let i = 0; i < checkpoints.length - 1; i++) {
      const currentCp = checkpoints[i]!;
      const nextCp = checkpoints[i + 1]!;

      // 次のチェックポイントまでの区間（現在のチェックポイントの次から）
      segments.push({
        startIndex: currentCp.eventIndex + 1,
        endIndex: nextCp.eventIndex,
        startHash: currentCp.hash,
        expectedEndHash: nextCp.hash
      });
    }

    // 最後の区間: 最後のチェックポイントから最終イベントまで
    const lastCp = checkpoints[checkpoints.length - 1];
    if (lastCp && lastCp.eventIndex < events.length - 1) {
      const lastEvent = events[events.length - 1];
      segments.push({
        startIndex: lastCp.eventIndex + 1,
        endIndex: events.length - 1,
        startHash: lastCp.hash,
        expectedEndHash: lastEvent?.hash ?? ''
      });
    }

    return segments;
  }

  /**
   * 区間からランダムにサンプリング
   * 必ず最初と最後の区間を含め、残りはランダム選択
   */
  private selectRandomSegments(
    segments: SegmentInfo[],
    sampleCount: number
  ): SegmentInfo[] {
    if (segments.length <= sampleCount) {
      return segments;
    }

    const selected: SegmentInfo[] = [];

    // 必ず最初と最後の区間を含める
    selected.push(segments[0]!);
    if (segments.length > 1) {
      selected.push(segments[segments.length - 1]!);
    }

    // 残りの区間からランダムにサンプリング
    const middleSegments = segments.slice(1, -1);
    const remaining = sampleCount - selected.length;

    for (let i = 0; i < remaining && middleSegments.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * middleSegments.length);
      selected.push(middleSegments.splice(randomIndex, 1)[0]!);
    }

    // インデックス順にソート
    return selected.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * 区間を再計算検証し、期待される終了ハッシュと一致するか確認
   */
  private async verifySegmentWithExpectedEnd(
    events: StoredEvent[],
    startIndex: number,
    endIndex: number,
    startHash: string,
    expectedEndHash: string,
    onProgress?: (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => void
  ): Promise<VerificationResult & { computedHash?: string }> {
    let hash: string | null = startIndex === 0 ? (events[0]?.previousHash ?? null) : startHash;
    let lastTimestamp = startIndex > 0 ? (events[startIndex - 1]?.timestamp ?? -Infinity) : -Infinity;
    const total = endIndex - startIndex + 1;

    for (let i = startIndex; i <= endIndex; i++) {
      const event = events[i];
      if (!event) continue;

      // セグメント検証ではpreviousHashのチェックをスキップ（開始ハッシュから再計算するため）
      const result = await this.verifyEvent(event, i, hash, lastTimestamp, false);

      if (!result.valid) {
        return result.error!;
      }

      hash = result.newHash!;
      lastTimestamp = result.newTimestamp!;

      if (onProgress && result.hashInfo) {
        onProgress(i - startIndex + 1, total, result.hashInfo);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // 区間の終了ハッシュが期待値と一致するか確認
    if (hash !== expectedEndHash) {
      return {
        valid: false,
        errorAt: endIndex,
        message: `Segment end hash mismatch at event ${endIndex}: computed ${hash?.substring(0, 16)}..., expected ${expectedEndHash.substring(0, 16)}...`,
        expectedHash: expectedEndHash,
        computedHash: hash ?? undefined
      };
    }

    return {
      valid: true,
      message: `Segment ${startIndex}-${endIndex} verified successfully`,
      computedHash: hash ?? undefined
    };
  }
}
