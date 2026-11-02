/**
 * ProofExporter の `onProofChanged` 通知のテスト (#433)。
 *
 * export は reflectionNote / preExportAttestation を EventRecorder を通さず proof へ直接記録するので、
 * 通知が無いとステータスバーの件数・ハッシュ (状態契約 `#event-count[data-count]` / `#current-hash[data-hash]`)
 * が export 前の値で止まり、内部状態と食い違う (state-contract.spec の `expectConsistent()` が検出した)。
 * どの経路で export が終わっても通知が出ることを、途中で抜ける経路で固定する。
 */

import { describe, it, expect, vi } from 'vitest';
import type { TabManager } from '../../ui/tabs/TabManager.js';

vi.mock('../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => false,
  loadTurnstileScript: async (): Promise<void> => {},
  performTurnstileVerification: async () => ({ success: true, attestation: null }),
}));

vi.mock('../../ui/components/ExportProgressDialog.js', () => ({
  ExportProgressDialog: class {
    show(): void {}
    hide(): void {}
    updatePhase(): void {}
    updateProgress(): void {}
    getTurnstileContainer(): HTMLElement | null {
      return null;
    }
  },
}));

const { ProofExporter } = await import('../ProofExporter.js');

function exporterWithoutTabs(onProofChanged: () => void): InstanceType<typeof ProofExporter> {
  const exporter = new ProofExporter();
  exporter.setTabManager({ getActiveTab: () => null, getAllTabs: () => [] } as unknown as TabManager);
  exporter.setCallbacks({ onProofChanged });
  return exporter;
}

describe('ProofExporter onProofChanged', () => {
  it('notifies onProofChanged once when a current-tab export finishes, even if it returns early', async () => {
    const onProofChanged = vi.fn();

    await exporterWithoutTabs(onProofChanged).exportCurrentTab();

    expect(onProofChanged).toHaveBeenCalledTimes(1);
  });

  it('notifies onProofChanged once when an all-tabs export finishes, even if it returns early', async () => {
    const onProofChanged = vi.fn();

    await exporterWithoutTabs(onProofChanged).exportAllTabsAsZip();

    expect(onProofChanged).toHaveBeenCalledTimes(1);
  });
});
