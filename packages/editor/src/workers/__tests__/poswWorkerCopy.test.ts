/**
 * editor の poswWorker.ts が shared のコピーとずれていないことの検査 (#344)。
 *
 * Vite が symlink 越しのパッケージ内 Worker を解決できないため、editor は
 * packages/shared/src/poswWorker.ts を丸ごとコピーして持っている。片方だけ直すと
 * 記録側の PoSW 計算が静かに分岐するので、本体が同一であることをここで固定する。
 *
 * 比較から除くもの (意図的な差分):
 * - ファイル先頭のヘッダコメント (最初の block コメント 1 つ)。editor 側にだけ
 *   「これは shared のコピー」という NOTE がある
 * - 空行 (shared 側にだけ区切りの空行が 1 つ余分にある)
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readBody(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^\/\*\*[\s\S]*?\*\//, '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
}

describe('poswWorker のコピー', () => {
  it('editor の本体は shared の poswWorker.ts と一致する', () => {
    const shared = readBody(new URL('../../../../shared/src/poswWorker.ts', import.meta.url));
    const editor = readBody(new URL('../poswWorker.ts', import.meta.url));

    expect(shared.length).toBeGreaterThan(0);
    expect(editor).toBe(shared);
  });
});
