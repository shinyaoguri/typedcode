/**
 * export の容量の測定 (#628) 専用: 実際の打鍵で記録したイベント列を複製して、長時間セッション相当の件数に水増しする。
 *
 * **できる列は容量の測定用で、正規の proof ではない**。複製したイベントは hash / posw を元のまま
 * 写すのでハッシュチェーンが繋がらず、verify-cli は必ず失敗する。PoSW も計算しない。測るのは「この件数・この
 * 大きさの proof を、本物の export の経路 (`ProofExporter`) が組み立て・文字列化・ZIP 化できるか」だけ。
 *
 * - 複製するのは `bodyStart` 以降 (起動時の一回きりのイベント = #0 humanAttestation・environmentProbe などを除いた、
 *   打鍵の本体)。先頭の `bodyStart` 件はそのまま残す
 * - 複製は深く行い (文字列とオブジェクトを元と共有しない。ヒープの使い方を実物に近づけるため)、`sequence` は配列の位置に
 *   振り直し、`timestamp` は複製のたびに本体の長さぶんずらして単調にする。`previousHash` は直前の `hash` を指す (hash は
 *   元のままなので、それでもチェーンは繋がらない)
 * - チェックポイントも本体の範囲にあるものを同じ密度で複製する (署名の envelope ごと写す。大きさを実物に合わせるため)
 * - `finalSnapshotChars` を渡すと、contentSnapshot (全文) の data を列の位置に比例して伸ばし、末尾でその文字数にする。
 *   長いセッションでは全文が育つので、短い元の列の全文をそのまま写すと小さく見積もるため
 *
 * dev ビルドの E2E 専用フック (`devCapacityHook.ts`) からだけ使う。製品の経路からは呼ばない。
 */

import type { CheckpointData, StoredEvent } from '@typedcode/shared';

export interface CapacityPaddingOptions {
  /** 水増し後のイベント件数 (base より小さければ base をそのまま返す) */
  targetEvents: number;
  /** 複製する本体の先頭の位置。これより前は 1 回だけ置く */
  bodyStart: number;
  /** contentSnapshot の全文を末尾で何文字にするか。省略時は元の data のまま */
  finalSnapshotChars?: number;
}

export interface CapacityPaddingResult {
  events: StoredEvent[];
  checkpoints: CheckpointData[];
}

/** s を繰り返して長さ len にする (s が空なら空白で埋める)。 */
function fillTo(s: string, len: number): string {
  if (len <= s.length) return s;
  const unit = s.length > 0 ? s : ' ';
  return unit.repeat(Math.ceil(len / unit.length)).slice(0, len);
}

export function buildCapacityPadding(
  baseEvents: readonly StoredEvent[],
  baseCheckpoints: readonly CheckpointData[],
  options: CapacityPaddingOptions
): CapacityPaddingResult {
  const { targetEvents, finalSnapshotChars } = options;
  const bodyStart = Math.max(0, Math.min(options.bodyStart, baseEvents.length));
  const body = baseEvents.slice(bodyStart);
  if (targetEvents <= baseEvents.length || body.length === 0) {
    return { events: baseEvents.slice(), checkpoints: baseCheckpoints.slice() };
  }

  const first = body[0] as StoredEvent;
  const last = body[body.length - 1] as StoredEvent;
  // 複製 1 回ぶんの時間幅。本体が 1 件でも時刻が進むよう、平均間隔を足す
  const span = last.timestamp - first.timestamp + Math.max(1, (last.timestamp - first.timestamp) / body.length);

  const events: StoredEvent[] = baseEvents.slice();
  for (let i = baseEvents.length; i < targetEvents; i++) {
    const offset = i - bodyStart;
    const cycle = Math.floor(offset / body.length);
    const src = body[offset % body.length] as StoredEvent;
    // 深く複製する (文字列・data のオブジェクトを元と共有しない)。実際の長いセッションでは各イベントが自分の文字列と
    // オブジェクトをヒープに持つので、浅い複製ではメモリを小さく見積もる。previousHash は実物と同じく直前の hash を指す
    const copy: StoredEvent = structuredClone(src);
    copy.sequence = i;
    copy.timestamp = src.timestamp + span * cycle;
    copy.previousHash = (events[i - 1] as StoredEvent).hash;
    if (finalSnapshotChars !== undefined && src.type === 'contentSnapshot' && typeof src.data === 'string') {
      copy.data = fillTo(src.data, Math.round((finalSnapshotChars * (i + 1)) / targetEvents));
    }
    events.push(copy);
  }

  const bodyCheckpoints = baseCheckpoints.filter((cp) => cp.eventIndex >= bodyStart);
  const checkpoints: CheckpointData[] = baseCheckpoints.slice();
  for (let cycle = 1; bodyCheckpoints.length > 0; cycle++) {
    let added = false;
    for (const cp of bodyCheckpoints) {
      const eventIndex = cp.eventIndex + body.length * cycle;
      if (eventIndex >= targetEvents) continue;
      checkpoints.push({ ...cp, eventIndex, timestamp: cp.timestamp + span * cycle });
      added = true;
    }
    if (!added) break;
  }

  return { events, checkpoints };
}
