import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ZIP エントリの展開を予算付きリーダー (`readZipEntryBytes` / `readZipEntryText`) に
 * 一本化するための機械的な歯止め (#234)。
 *
 * JSZip の `entry.async(...)` は申告 uncompressedSize を無視して**実際のバイト**を最後まで
 * 展開するので、詐称 ZIP を直接食わせると検証側が OOM する。予算を通すのは `zipBudget.ts`
 * だけなので、そこ以外での直接呼び出しを禁止する。
 */
/** 走査対象はこのパッケージの `src/` 全体 (cwd に依存しないようテストファイル位置から解決する)。 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 予算計上そのものを実装している唯一の例外。 */
const BUDGET_READER = 'fileProcessing/zipBudget.ts';
const ASYNC_READ = /\.async\(\s*['"](string|text|blob|arraybuffer|uint8array|nodebuffer|base64)['"]/;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('zip read policy (shared)', () => {
  it('never calls JSZip async readers directly outside the budget reader', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const path = relative(SRC_ROOT, file);
          if (path !== BUDGET_READER && ASYNC_READ.test(line)) offenders.push(`${path}:${i + 1}`);
        });
    }

    expect(offenders).toEqual([]);
  });
});
