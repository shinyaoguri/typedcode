/**
 * 試験の封印スターターと proof の templateInjection の照合 (#718)。
 *
 * `verifyContentReplay` は templateInjection で文書を丸ごと置き換え、`evaluatePureTyping` は
 * これを数えない。試験では「与えられた雛形」は封印 package の該当問題の starter に限られるので、
 * 注入の `data.content` (再生に使われる唯一の値) を封印 starter と照合し、それ以外の内容を
 * 雛形として持ち込んだ proof を束縛失敗にする。
 *
 * 自己申告の `templateName` / `templateHash` / `contentHash` / `contentLength` は使わない
 * (再生に使われず、改造クライアントが任意に合わせられるため)。
 */

import { isTemplateInjectionData } from '../typingProof/replay.js';

/** 照合の対象になるイベントの最小形 (StoredEvent の部分集合) */
export interface ExamStarterEventLike {
  type: string;
  data?: unknown;
}

/** `matchExamStarter` の結果 */
export interface ExamStarterMatchResult {
  status: 'matched' | 'mismatch';
  /** mismatch のときの理由 (英語) */
  reason?: string;
  /** mismatch のとき、最初に照合に失敗した templateInjection のイベント番号 */
  eventIndex?: number;
}

/**
 * 束縛検証の結果に載せる starter 照合 (`ExamBindingVerificationResult.starter`)。
 * - matched / mismatch: v2 (バンドル) で照合した結果
 * - not-evaluated: v1 (legacy 平文) で starter を機械的に取り出せないため照合しない (valid に影響させない)
 */
export interface ExamStarterCheck {
  status: 'matched' | 'mismatch' | 'not-evaluated';
  reason?: string;
  eventIndex?: number;
}

/**
 * proof のイベント列の templateInjection を封印 starter (`expectedStarter`。starter 無しは '') と照合する。
 *
 * - starter が空: templateInjection が 1 つでもあれば mismatch (持ち込める雛形が無い)
 * - starter が非空: すべての templateInjection の content が starter と一致すれば matched
 *   (注入なし・複数回・編集後の同値再注入も、文書を封印内容へ戻すだけなので matched)
 * - content が一致しない・data が `{ content: string }` でない注入は mismatch (最初の 1 つを返す)
 */
export function matchExamStarter(
  events: readonly ExamStarterEventLike[],
  expectedStarter: string
): ExamStarterMatchResult {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event?.type !== 'templateInjection') continue;

    if (!isTemplateInjectionData(event.data)) {
      return { status: 'mismatch', reason: `Template injection at event ${i} has invalid data`, eventIndex: i };
    }
    if (expectedStarter === '') {
      return {
        status: 'mismatch',
        reason: `Template injection at event ${i} is present but the sealed problem has no starter`,
        eventIndex: i,
      };
    }
    if (event.data.content !== expectedStarter) {
      return {
        status: 'mismatch',
        reason: `Template injection at event ${i} does not match the sealed starter`,
        eventIndex: i,
      };
    }
  }
  return { status: 'matched' };
}
