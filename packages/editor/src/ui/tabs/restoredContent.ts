/**
 * 復元した content をチェーンの replay に整合させる (#142 / #413)。
 *
 * クラッシュや、PoSW の処理待ちが残ったままの再開では、打鍵はチェーンに載らないのに、直近の
 * debounced 保存で content にだけ残る。その content のまま完成させて export すると Layer 4 の
 * content replay が一致せず、proof 全体が invalid になる (学習者に落ち度はない)。打鍵はチェーンに
 * 戻せないので、エディタのバッファは replay 版にする。
 *
 * ただし元の content は捨てない (#413。ADR-0042 段階 2)。食い違ったときは `divergence` に元の全文と
 * replay 版を返し、呼び出し側 (`TabManager`) が IndexedDB の `unprovenContents` に保全して知らせる。
 * 処理待ちが途中の編集や削除だと、差分は末尾に限らず、元のほうが短いこともある。
 *
 * replay 自体が途中で失敗する (再構成できない、より深い破損) ときは content を変えない。理由は
 * `replayError` で返し、判断は他の検証レイヤに任せる。
 */

import { verifyContentReplay, type StoredEvent } from '@typedcode/shared';

/** 復元した content とチェーンの replay が食い違ったときの両方の版 */
export interface RestoredContentDivergence {
  /** 保存されていた元の content (チェーンに載っていない編集を含む) */
  original: string;
  /** チェーンの replay で作った内容 (バッファに置く版。proof と一致する) */
  chainContent: string;
}

export interface ReconciledRestoredContent {
  /** エディタのバッファに置く内容 */
  content: string;
  /** 食い違って replay 版に置き換えたときの両方の版。置き換えていなければ `null` */
  divergence: RestoredContentDivergence | null;
  /** replay が途中で失敗した理由 (content は変えていない) */
  replayError?: string;
}

/** 復元した content を replay に整合させる (純関数。保存も通知もしない) */
export function reconcileRestoredContent(
  savedContent: string,
  events: readonly StoredEvent[]
): ReconciledRestoredContent {
  // 整合先が無い (別種の破損はここで判断しない)
  if (events.length === 0) return { content: savedContent, divergence: null };

  const replay = verifyContentReplay(events as StoredEvent[], savedContent);
  if (replay.valid) return { content: savedContent, divergence: null };

  if (replay.reconstructedContent !== undefined) {
    return {
      content: replay.reconstructedContent,
      divergence: { original: savedContent, chainContent: replay.reconstructedContent },
    };
  }

  return { content: savedContent, divergence: null, replayError: replay.reason ?? 'content replay failed' };
}
