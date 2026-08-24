/**
 * `cli.ts` が `process.exit()` を使わないことの固定 (#283 c1 / 旧 #238)。
 *
 * stdout がパイプのとき Node の書き込みは非同期なので、`process.exit()` は**未 flush の
 * 出力を捨てて**プロセスを落とす。クラス単位の ZIP (数十 proof) を
 * `typedcode-verify class.zip | tee report.txt` のように受けると、最後の
 * `=== Summary: N/M proofs passed ===` から欠ける — 採点運用がまさに壊れる形で欠ける。
 *
 * 直し方は `process.exitCode` を立てて `main()` を素直に return させること
 * (イベントループが空になった時点で Node が flush してから終了する)。
 * 挙動そのものはプロセスを跨ぐので e2e の領分だが、**再導入を止めるのはここ** —
 * `process.exit()` は 1 箇所足すだけで同じ穴が開き、しかも普段の TTY 実行では再現しない。
 *
 * 終了コードの意味 (0 = 成功 / 1 = 失敗・エラー) は verify-cli/CLAUDE.md の不変条件 2。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI_SOURCE = readFileSync(fileURLToPath(new URL('../cli.ts', import.meta.url)), 'utf-8');

describe('CLI の終了経路 (#283 c1)', () => {
  it('process.exit() を呼ばない (パイプ時に stdout を切り捨てるため)', () => {
    const calls = CLI_SOURCE.match(/process\.exit\s*\(/g) ?? [];
    expect(calls).toEqual([]);
  });

  it('終了コードは process.exitCode で立てる', () => {
    expect(CLI_SOURCE).toMatch(/process\.exitCode\s*=/);
  });

  it('検証結果の集計がそのまま終了コードになる (成功 0 / 失敗 1)', () => {
    expect(CLI_SOURCE).toMatch(/process\.exitCode = summary\.every\(\(s\) => s\.valid\) \? 0 : 1;/);
  });
});
