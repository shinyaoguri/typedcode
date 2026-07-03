/**
 * content replay の共有プリミティブ。
 *
 * 厳密な検証 (`verification.ts` の `verifyContentReplay` — 不正イベントで fail) と、
 * advisory な分類 (`structuralEdit.ts` の内部ペースト検証 — 不正イベントは黙って無視) の
 * 両方が同じ適用規則を使うためにここへ置く。適用規則が 2 実装に分かれると
 * 「replay は通るのに分類だけずれる」ドリフトが起きる (#140 と同型の問題)。
 */

import type { StoredEvent } from '../types.js';

export function isTemplateInjectionData(data: unknown): data is { content: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'content' in data &&
    typeof (data as { content: unknown }).content === 'string'
  );
}

/**
 * contentSnapshot が replay 文書と乖離しているか (#175)。
 *
 * editor の正規 snapshot (100 イベント毎、`ProofStatusDisplay.checkSnapshot`) は取得時の
 * エディタ内容そのものなので、忠実な replay とは常に完全一致する (= replay 上 no-op)。
 * 乖離する snapshot は replay 文書を挿入イベント無しで丸ごと差し替えられる唯一の口であり、
 * 手製 proof が AI 解答全体を 1 イベントで持ち込む laundering に使える。
 * 判定は advisory のみ (isPureTyping / 分析シグナル / processSummary)。`valid` には影響させない。
 */
export function isDivergentContentSnapshot(event: StoredEvent, replayContentBeforeApply: string): boolean {
  return event.type === 'contentSnapshot' && typeof event.data === 'string' && event.data !== replayContentBeforeApply;
}

/** Monaco の range (1-origin 行/列) を文書内 offset へ変換する。範囲外なら null。 */
export function offsetFromRange(content: string, event: StoredEvent): number | null {
  if (typeof event.rangeOffset === 'number') {
    return event.rangeOffset;
  }

  const range = event.range;
  if (!range) return null;

  const lines = content.split('\n');
  const lineIndex = range.startLineNumber - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;

  const columnIndex = range.startColumn - 1;
  const line = lines[lineIndex] ?? '';
  if (columnIndex < 0 || columnIndex > line.length) return null;

  let offset = columnIndex;
  for (let i = 0; i < lineIndex; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset;
}

/**
 * 1 イベントを replay 文書へ **best-effort** で適用する (分類用途)。
 * 適用できないイベント (範囲外・型不正) は黙って無視して元の content を返す —
 * 厳密な整合性は `verifyContentReplay` が別途 fail させるので、ここでは落とさない。
 * `insertFromInternalPaste` の監査マーカー (rangeOffset==null) は文書に触れない。
 */
export function applyReplayEventTolerant(content: string, event: StoredEvent): string {
  if (event.type === 'templateInjection') {
    return isTemplateInjectionData(event.data) ? event.data.content : content;
  }

  if (event.type === 'contentSnapshot') {
    return typeof event.data === 'string' ? event.data : content;
  }

  if (event.type !== 'contentChange') return content;

  if (event.inputType === 'insertFromInternalPaste' && event.rangeOffset == null) {
    return content;
  }

  if (typeof event.data !== 'string') return content;

  const offset = offsetFromRange(content, event);
  const rangeLength = event.rangeLength ?? 0;
  if (offset === null || rangeLength < 0 || offset < 0 || offset + rangeLength > content.length) {
    return content;
  }

  return content.slice(0, offset) + event.data + content.slice(offset + rangeLength);
}
