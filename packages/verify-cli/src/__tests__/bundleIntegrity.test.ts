/**
 * Tier A バンドル (ADR-0024) の `integrityValid` に何を渡すか (#219)。
 *
 * バンドルの契約は「派生元 proof が**整合性検証**を通ったか」であって、CLI の総合 valid
 * (gate 込み) ではない。かつ ADR-0031 の `'partial'` (検査を省略した) を「整合性が失敗した」に
 * 潰してはいけない。この 2 点が守られていることを固定する。
 */

import { describe, expect, it } from 'vitest';
import type { AssuranceResult } from '@typedcode/shared';
import { toBundleIntegrityValid } from '../verify.js';

function assurance(integrity: AssuranceResult['integrity']): AssuranceResult {
  return {
    integrity,
    temporal: 'anchored',
    provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
  };
}

describe('toBundleIntegrityValid (ADR-0024 / ADR-0031)', () => {
  it('reports integrity as valid when the proof was fully proven', () => {
    expect(toBundleIntegrityValid(assurance('proven'))).toBe(true);
  });

  it('keeps integrity valid when checks were skipped (partial), not treating them as tampering', () => {
    expect(toBundleIntegrityValid(assurance('partial'))).toBe(true);
  });

  it('reports integrity as invalid only when the integrity checks actually failed', () => {
    expect(toBundleIntegrityValid(assurance('failed'))).toBe(false);
  });
});
