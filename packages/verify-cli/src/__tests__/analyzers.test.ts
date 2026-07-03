/**
 * loadExternalAnalyzers (#135 / ADR-0009 プラットフォーム方針) のテスト。
 *
 * `--analyzer <path>` は外部モジュールの動的 import + 契約バリデーションだけを担う
 * (分析ロジックは外部側)。受理する export 形態・不正モジュールの拒否・重複 id の拒否は
 * CLI の入口契約なのでここで固定する。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadExternalAnalyzers } from '../analyzers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'analyzers');
const fx = (name: string): string => join(FIXTURES, name);

describe('loadExternalAnalyzers', () => {
  it('loads a default-exported analyzer', async () => {
    const analyzers = await loadExternalAnalyzers([fx('valid-default.mjs')]);
    expect(analyzers.map((a) => a.id)).toEqual(['fixture-default']);
  });

  it('collects named "analyzer" and "analyzers" exports from one module', async () => {
    const analyzers = await loadExternalAnalyzers([fx('valid-named.mjs')]);
    expect(analyzers.map((a) => a.id)).toEqual(['fixture-named-single', 'fixture-named-a', 'fixture-named-b']);
  });

  it('accumulates analyzers across multiple modules in argument order', async () => {
    const analyzers = await loadExternalAnalyzers([fx('valid-default.mjs'), fx('valid-named.mjs')]);
    expect(analyzers).toHaveLength(4);
    expect(analyzers[0]!.id).toBe('fixture-default');
  });

  it('rejects a module whose exports do not satisfy the Analyzer contract', async () => {
    await expect(loadExternalAnalyzers([fx('invalid-shape.mjs')])).rejects.toThrow(/no valid Analyzer export/);
  });

  it('rejects a module that cannot be imported', async () => {
    await expect(loadExternalAnalyzers([fx('does-not-exist.mjs')])).rejects.toThrow(/Failed to load external analyzer/);
  });

  it('rejects duplicate analyzer ids across modules', async () => {
    await expect(loadExternalAnalyzers([fx('valid-default.mjs'), fx('duplicate-of-default.mjs')])).rejects.toThrow(
      /Duplicate analyzer id "fixture-default"/
    );
  });
});
