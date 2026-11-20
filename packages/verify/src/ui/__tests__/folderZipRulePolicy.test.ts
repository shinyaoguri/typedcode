import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * フォルダ内のファイルを ZIP と見なす規則は `folderScreenshotLoader.isZipInFolder` 1 つ (#834)。
 * チェーン側の imageHash 集合に入れる ZIP (#786)・取り込む ZIP・スクショの読み直しのきっかけになる ZIP が
 * 別々の式で決まると、集合と取り込みが食い違う。`FolderController` に拡張子の直書きを戻させない。
 */
const CONTROLLER = join(dirname(fileURLToPath(import.meta.url)), '../controllers/FolderController.ts');

describe('ZIP rule in the folder controller (#834)', () => {
  it('decides whether a folder file is a ZIP only through isZipInFolder', () => {
    const offenders = readFileSync(CONTROLLER, 'utf8')
      .split('\n')
      .flatMap((line, i) => (/\.endsWith\(\s*['"]\.zip['"]/i.test(line) ? [`FolderController.ts:${i + 1}`] : []));

    expect(offenders).toEqual([]);
  });
});
