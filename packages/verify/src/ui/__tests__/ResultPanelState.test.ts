// @vitest-environment happy-dom
/**
 * 結果パネルの判定の状態契約 (verify/AGENTS.md「状態契約 (data-* 属性)」, ADR-0034)。
 *
 * E2E は翻訳テキストや色クラスではなく、ここで固定する data-* を読んで判定を assert する。
 * 色クラスは整合性 partial と時刻アンカー partial がどちらも `warning` で区別できないため、
 * 生の enum 値を属性で出すこと自体を仕様として固定する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssuranceResult, IntegrityLevel, TemporalLevel } from '@typedcode/shared';
import { ResultPanel, type ResultData } from '../ResultPanel.js';
import { TabController, type TabControllerDependencies } from '../controllers/TabController.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import type { TrustLevel } from '../../types.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

function assurance(overrides: Partial<AssuranceResult> = {}): AssuranceResult {
  return {
    integrity: 'proven',
    temporal: 'anchored',
    provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
    ...overrides,
  };
}

function resultData(overrides: Partial<ResultData> = {}, level: TrustLevel = 'verified'): ResultData {
  return {
    filename: 'main.c_proof.json',
    content: 'int main(void) { return 0; }',
    language: 'c',
    result: { chainValid: true, pureTyping: true },
    eventCount: 10,
    typingTime: '1s',
    typingSpeed: '1',
    trustResult: { level, summary: 'summary', issues: [] },
    assurance: assurance(),
    ...overrides,
  };
}

function strip(): HTMLElement {
  return document.getElementById('assurance-strip')!;
}

function chip(axis: string): HTMLElement | null {
  return strip().querySelector<HTMLElement>(`.assurance-chip[data-axis="${axis}"]`);
}

function statusIcon(): HTMLElement {
  return document.getElementById('result-status-icon')!;
}

let panel: ResultPanel;

beforeEach(() => {
  mountVerifyIndexHtml();
  panel = new ResultPanel();
});

afterEach(() => {
  panel.stopProgressTimer();
});

describe('ResultPanel assurance state contract', () => {
  it.each<IntegrityLevel>(['proven', 'partial', 'failed'])(
    'exposes integrity=%s as the raw value on both the strip and the integrity chip',
    (integrity) => {
      panel.render(resultData({ assurance: assurance({ integrity }) }));

      expect(strip().dataset.integrity).toBe(integrity);
      expect(chip('integrity')?.dataset.level).toBe(integrity);
    }
  );

  it.each<TemporalLevel>(['anchored', 'partial', 'unanchored', 'exam-t0'])(
    'exposes temporal=%s as the raw value on both the strip and the temporal chip',
    (temporal) => {
      panel.render(resultData({ assurance: assurance({ temporal }) }));

      expect(strip().dataset.temporal).toBe(temporal);
      expect(chip('temporal')?.dataset.level).toBe(temporal);
    }
  );

  it('tells integrity=partial apart from temporal=partial although both chips share the warning colour', () => {
    panel.render(resultData({ assurance: assurance({ integrity: 'partial', temporal: 'anchored' }) }));
    const integrityPartial = { strip: { ...strip().dataset }, warningAxis: warningChipAxes() };

    panel.render(resultData({ assurance: assurance({ integrity: 'proven', temporal: 'partial' }) }));
    const temporalPartial = { strip: { ...strip().dataset }, warningAxis: warningChipAxes() };

    expect(integrityPartial.strip).toMatchObject({ integrity: 'partial', temporal: 'anchored' });
    expect(temporalPartial.strip).toMatchObject({ integrity: 'proven', temporal: 'partial' });
    // 色クラスだけを見ると、どちらも「warning のチップが 1 枚」で同じに見える。
    expect(integrityPartial.warningAxis).toEqual(['integrity']);
    expect(temporalPartial.warningAxis).toEqual(['temporal']);
  });

  it.each([true, false])('exposes pureTyping=%s without giving the advisory provenance chip a level', (pureTyping) => {
    panel.render(
      resultData({
        assurance: assurance({ provenance: { pureTyping, notableSignals: null, reviewPriority: null } }),
      })
    );

    expect(strip().dataset.pureTyping).toBe(String(pureTyping));
    expect(chip('provenance')?.dataset.pureTyping).toBe(String(pureTyping));
    expect(chip('provenance')?.hasAttribute('data-level')).toBe(false);
  });

  it('round-trips a hostile self-asserted mode through data-mode without injecting attributes', () => {
    const payload = '" data-level="proven';
    panel.render(resultData({ mode: payload as ResultData['mode'] }));

    const modeChip = chip('mode');
    expect(modeChip?.dataset.mode).toBe(payload);
    expect(modeChip?.hasAttribute('data-level')).toBe(false);
  });

  it('carries no assurance attributes when the result has no assurance', () => {
    panel.render(resultData({ assurance: assurance({ integrity: 'failed' }) }));
    panel.render(resultData({ assurance: undefined }));

    expect(strip().hasAttribute('data-integrity')).toBe(false);
    expect(strip().hasAttribute('data-temporal')).toBe(false);
    expect(strip().hasAttribute('data-pure-typing')).toBe(false);
  });
});

describe('ResultPanel overall verdict state contract', () => {
  it.each<TrustLevel>(['verified', 'partial', 'failed'])(
    'exposes the TrustCalculator level %s on the status icon',
    (level) => {
      panel.render(resultData({}, level));

      expect(statusIcon().dataset.level).toBe(level);
    }
  );

  it('does not invent a level when rendered without a TrustCalculator result', () => {
    panel.render(resultData({}, 'failed'));
    panel.render(resultData({ trustResult: undefined }));

    expect(statusIcon().hasAttribute('data-level')).toBe(false);
  });
});

describe('ResultPanel verdict while no verdict is shown', () => {
  const transitions: Array<[string, (p: ResultPanel) => void]> = [
    ['another file starts verifying', (p) => p.startProgress('other_proof.json')],
    ['a plaintext file is opened', (p) => p.renderPlaintext({ filename: 'main.c', content: '', language: 'c' })],
    ['the panel is reset', (p) => p.reset()],
  ];

  it.each(transitions)('drops the previous verdict attributes when %s', (_label, transition) => {
    panel.render(resultData({ assurance: assurance({ integrity: 'failed' }) }, 'failed'));

    transition(panel);

    expect(strip().hasAttribute('data-integrity')).toBe(false);
    expect(strip().hasAttribute('data-temporal')).toBe(false);
    expect(strip().hasAttribute('data-pure-typing')).toBe(false);
    expect(statusIcon().hasAttribute('data-level')).toBe(false);
  });
});

describe('TabController opening a tab whose verification errored', () => {
  it('replaces the previously shown verdict instead of leaving it on screen', () => {
    const tabManager = new VerifyTabManager();
    const uiState = new UIStateManager();
    const controller = new TabController({
      tabManager,
      uiState,
      resultPanel: panel,
      getTimelineChart: () => null,
      getMouseChart: () => null,
    } as unknown as TabControllerDependencies);

    // 直前に別ファイルの判定を表示していた。
    panel.render(resultData({ filename: 'good_proof.json' }, 'verified'));
    uiState.setCurrentDisplayedTabId('good', 'success');
    tabManager.addTab({
      id: 'broken',
      filename: 'broken_proof.json',
      language: 'json',
      status: 'error',
      progress: 0,
      proofData: null,
      verificationResult: null,
      error: 'unsupported format',
    });

    controller.showTabContent('broken');

    expect(strip().hasAttribute('data-integrity')).toBe(false);
    expect(statusIcon().hasAttribute('data-level')).toBe(false);
    expect(document.getElementById('vp-filename')?.textContent).toBe('broken_proof.json');
  });
});

/** 色クラス `warning` を持つチップの軸 (data-axis) の一覧。 */
function warningChipAxes(): string[] {
  return Array.from(strip().querySelectorAll<HTMLElement>('.assurance-chip.warning')).map(
    (el) => el.dataset.axis ?? '?'
  );
}
