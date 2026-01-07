/**
 * DiffService - ソースファイルと証明内容の差分を計算するサービス
 */
import { diffLines } from 'diff';
import type { DiffResult, DiffHunk, DiffLine } from '../types';

export class DiffService {
  /**
   * ソースファイル内容と証明内容を比較
   * @param sourceContent - ソースファイルの内容
   * @param proofContent - 証明ファイルの最終コンテンツ（proofData.content）
   * @returns 差分結果
   */
  static compare(sourceContent: string, proofContent: string): DiffResult {
    // proofContent を「元」、sourceContent を「新」として比較
    // - 削除（赤）= proofにあるがソースにない
    // - 追加（緑）= ソースにあるがproofにない
    const changes = diffLines(proofContent, sourceContent);

    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;
    let unchanged = 0;

    let oldLineNum = 1;
    let newLineNum = 1;

    for (const part of changes) {
      // 改行で分割し、末尾の空文字列を除去
      const partLines = part.value.split('\n');
      if (partLines[partLines.length - 1] === '') {
        partLines.pop();
      }

      for (const line of partLines) {
        if (part.added) {
          // ソースにあるがproofにない（追加）
          lines.push({
            type: 'added',
            content: line,
            newLineNumber: newLineNum++,
          });
          additions++;
        } else if (part.removed) {
          // proofにあるがソースにない（削除）
          lines.push({
            type: 'removed',
            content: line,
            oldLineNumber: oldLineNum++,
          });
          deletions++;
        } else {
          // 変更なし
          lines.push({
            type: 'unchanged',
            content: line,
            oldLineNumber: oldLineNum++,
            newLineNumber: newLineNum++,
          });
          unchanged++;
        }
      }
    }

    // シンプルに全体を1つのハンクとして扱う
    const hunks: DiffHunk[] = [];
    if (lines.length > 0) {
      hunks.push({ lines });
    }

    return {
      isIdentical: additions === 0 && deletions === 0,
      hunks,
      stats: { additions, deletions, unchanged },
    };
  }
}
