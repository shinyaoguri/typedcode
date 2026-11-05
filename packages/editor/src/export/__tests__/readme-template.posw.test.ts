/**
 * export ZIP の README の PoSW の説明の固定 (#241 / ADR-0045)。
 *
 * PoSW は 1 本のチェーンに逐次コストを課すだけで、時間の証明でもタイムスタンプ偽造の検出手段でもない
 * (高性能な CPU ほど速く回せ、偽造側の下限は 10,000 反復でも 10,000 events で 1 分前後)。
 * 「生成に時間がかかる証明」「計算コストが膨大」「PoSW のタイミングと矛盾」のような、時間の証明と
 * 読める説明が戻らないことを確かめる。
 */

import { describe, it, expect } from 'vitest';
import { generateReadmeJa } from '../readme-template-ja.js';
import { generateReadmeEn } from '../readme-template-en.js';

const params = {
  timestamp: '2026-01-01T00:00:00.000Z',
  totalFiles: 1,
  totalScreenshots: 0,
  sourceFiles: ['main.ts'],
  proofFiles: ['proof.json'],
};

describe('README の PoSW の説明', () => {
  it('ja: PoSW を時間の証明・タイムスタンプの根拠として書かない', () => {
    const readme = generateReadmeJa(params);
    expect(readme).not.toContain('生成に時間がかかる');
    expect(readme).not.toContain('計算コストが膨大');
    expect(readme).not.toMatch(/PoSW\s*の?タイミング/);
    expect(readme).toContain('作業時間や打鍵時刻の証明ではない');
    expect(readme).toContain('PoSW は時刻の根拠にならない');
  });

  it('en: does not describe PoSW as a proof of time or as timestamp evidence', () => {
    const readme = generateReadmeEn(params);
    expect(readme).not.toMatch(/takes time to generate/i);
    expect(readme).not.toMatch(/computationally expensive/i);
    expect(readme).not.toMatch(/PoSW timing/i);
    expect(readme).toContain('not a proof of working time or keystroke timing');
    expect(readme).toContain('PoSW is not evidence of time');
  });
});
