// @vitest-environment happy-dom
/**
 * ProofStatusDisplay が出すカウンタの状態契約 (`#event-count[data-count]` / `#current-hash[data-hash]`) のテスト (#433)。
 * 表示は省略形 (`abcd…`) だが、E2E が active タブの currentHash と突き合わせるのは省略しない data-hash。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProofStatusDisplay, type ProofStats } from '../ProofStatusDisplay.js';

const FULL_HASH = 'a'.repeat(32) + 'b'.repeat(32);

function display(stats: ProofStats | null): ProofStatusDisplay {
  const d = new ProofStatusDisplay();
  d.setGetStats(() => stats);
  return d;
}

const eventCount = (): HTMLElement => document.getElementById('event-count')!;
const currentHash = (): HTMLElement => document.getElementById('current-hash')!;

describe('ProofStatusDisplay state contract', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<span id="event-count" data-count="0">0</span><span id="current-hash" data-hash="">-</span>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes the total event count as data-count and the unabbreviated hash as data-hash', () => {
    display({ totalEvents: 42, currentHash: FULL_HASH, pendingCount: 0 }).update();

    expect(eventCount().dataset.count).toBe('42');
    expect(currentHash().dataset.hash).toBe(FULL_HASH);
    expect(currentHash().textContent).not.toBe(FULL_HASH);
  });

  it('clears data-hash and zeroes data-count on reset', () => {
    const d = display({ totalEvents: 7, currentHash: FULL_HASH, pendingCount: 0 });
    d.update();

    d.reset();

    expect(eventCount().dataset.count).toBe('0');
    expect(currentHash().dataset.hash).toBe('');
  });
});
