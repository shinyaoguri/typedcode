// @vitest-environment happy-dom
/**
 * ProofStatusDisplay が出すカウンタの状態契約 (`#event-count[data-count]` / `#current-hash[data-hash]`) のテスト (#433)。
 * 表示は省略形 (`abcd…`) だが、E2E が active タブの currentHash と突き合わせるのは省略しない data-hash。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getI18n } from '../../../i18n/index.js';
import { ja } from '../../../i18n/translations/ja.js';
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

  it('re-renders the counter after the content snapshot it records, so data-count does not lag behind the proof', async () => {
    let stats: ProofStats = { totalEvents: 100, currentHash: FULL_HASH, pendingCount: 0 };
    const d = new ProofStatusDisplay();
    d.setGetStats(() => stats);
    let snapshots = 0;
    d.setSnapshotCallback(
      async () => {
        snapshots += 1;
        stats = { totalEvents: 101, currentHash: 'c'.repeat(64), pendingCount: 0 };
        return { index: 100, recorded: true };
      },
      () => 'content'
    );

    d.update();
    await Promise.resolve();
    await Promise.resolve();

    expect(snapshots).toBe(1);
    expect(eventCount().dataset.count).toBe('101');
    expect(currentHash().dataset.hash).toBe('c'.repeat(64));
  });

  it('clears data-hash and zeroes data-count on reset', () => {
    const d = display({ totalEvents: 7, currentHash: FULL_HASH, pendingCount: 0 });
    d.update();

    d.reset();

    expect(eventCount().dataset.count).toBe('0');
    expect(currentHash().dataset.hash).toBe('');
  });
});

// 証明ステータスのツールチップは index.html では data-i18n-title で訳すが、表示の更新のたびに書き直すので、
// 書き直す側も表示言語で出す (ja の UI で英語に戻さない。#739)
describe('ProofStatusDisplay tooltip', () => {
  const statusItem = (): HTMLElement => document.getElementById('proof-status-item')!;

  beforeEach(() => {
    getI18n().setLocale('ja');
    document.body.innerHTML = `
      <div id="proof-status-item" title="">
        <div id="proof-progress-ring"><svg><circle id="progress-bar"></circle></svg></div>
      </div>`;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('writes the idle tooltip in the display language', () => {
    display({ totalEvents: 1, currentHash: FULL_HASH, pendingCount: 0 }).update();
    expect(statusItem().title).toBe(ja.statusBar.proofStatusTitle);
  });

  it('writes the processing tooltip in the display language', () => {
    display({ totalEvents: 1, currentHash: FULL_HASH, pendingCount: 3 }).update();
    expect(statusItem().title).toBe('処理中: 3 件待機中 (0/3 完了)');
  });
});
