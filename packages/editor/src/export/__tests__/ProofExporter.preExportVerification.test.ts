/**
 * ProofExporter のエクスポート前 Turnstile 認証 (best-effort 分岐) のテスト。
 *
 * editor/CLAUDE.md 不変条件 6: export は Turnstile 検証を通すが、exam/class/assignment は
 * `preExportBestEffort=true` で、不達/失敗でも**失敗 attestation を記録して**提出 ZIP を出す
 * (ADR-0006/0011: 教室の不安定網で提出そのものを不能にしない)。casual は従来どおりブロックする。
 *
 * #224: 単一タブ用の `performPreExportVerification` にだけこの分岐が無く、class/assignment の
 * 受講者が Turnstile 不達で単一タブ ZIP を一切出せなくなっていた。全タブ版と同じ意味論
 * (失敗 attestation を記録してから続行) に揃えたことをここで固定する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HumanAttestationEventData } from '@typedcode/shared';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';

/** Turnstile 層の振る舞いを差し替えるためのハンドル (vi.mock はホイストされるので hoisted で共有)。 */
const turnstile = vi.hoisted(() => ({
  configured: true,
  loadScript: async (): Promise<void> => {},
  verify: async (): Promise<{ success: boolean; error?: string; attestation?: unknown }> => ({
    success: true,
    attestation: {
      verified: true,
      score: 1,
      action: 'export_proof',
      timestamp: '2026-08-05T00:00:00.000Z',
      hostname: 'unit-test.local',
      signature: 'sig',
    },
  }),
}));

/** ExportProgressDialog は DOM を触るのでモックし、hide 呼び出し回数だけ観測する。 */
const progressDialog = vi.hoisted(() => ({
  hideCount: 0,
  turnstileContainer: {} as unknown as HTMLElement | null,
}));

vi.mock('../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => turnstile.configured,
  loadTurnstileScript: () => turnstile.loadScript(),
  performTurnstileVerification: () => turnstile.verify(),
}));

vi.mock('../../ui/components/ExportProgressDialog.js', () => ({
  ExportProgressDialog: class {
    show(): void {}
    hide(): void {
      progressDialog.hideCount++;
    }
    updatePhase(): void {}
    updateProgress(): void {}
    getTurnstileContainer(): HTMLElement | null {
      return progressDialog.turnstileContainer;
    }
  },
}));

const { ProofExporter } = await import('../ProofExporter.js');

/** private な検証メソッドを直接叩くためのビュー (export 全体は DOM/ZIP 依存が厚い)。 */
interface PreExportVerifier {
  performPreExportVerification(activeTab: TabState): Promise<boolean>;
  performPreExportVerificationForAllTabs(): Promise<boolean>;
}

interface FakeTab {
  tab: TabState;
  attestations: HumanAttestationEventData[];
}

function makeTab(id: string): FakeTab {
  const attestations: HumanAttestationEventData[] = [];
  const tab = {
    id,
    typingProof: {
      recordPreExportAttestation: async (attestation: HumanAttestationEventData) => {
        attestations.push(attestation);
      },
    },
  } as unknown as TabState;
  return { tab, attestations };
}

function createExporter(tabs: FakeTab[], bestEffort: boolean) {
  const exporter = new ProofExporter();
  const notifications: string[] = [];
  exporter.setPreExportBestEffort(bestEffort);
  exporter.setCallbacks({ onNotification: (message) => notifications.push(message) });
  exporter.setTabManager({
    getAllTabs: () => tabs.map((t) => t.tab),
    getActiveTab: () => tabs[0]?.tab ?? null,
  } as unknown as TabManager);
  return { exporter, verifier: exporter as unknown as PreExportVerifier, notifications };
}

beforeEach(() => {
  turnstile.configured = true;
  turnstile.loadScript = async () => {};
  turnstile.verify = async () => ({
    success: true,
    attestation: {
      verified: true,
      score: 1,
      action: 'export_proof',
      timestamp: '2026-08-05T00:00:00.000Z',
      hostname: 'unit-test.local',
      signature: 'sig',
    },
  });
  progressDialog.hideCount = 0;
  progressDialog.turnstileContainer = {} as unknown as HTMLElement;
  // node 環境には DOM が無い。検証経路が読む範囲だけ偽装する。
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('window', { location: { hostname: 'unit-test.local' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProofExporter.performPreExportVerification (single tab, #224)', () => {
  it('continues the export when the Turnstile script cannot be loaded in best-effort mode', async () => {
    const tab = makeTab('tab-1');
    const { verifier } = createExporter([tab], true);
    turnstile.loadScript = async () => {
      throw new Error('network down');
    };

    await expect(verifier.performPreExportVerification(tab.tab)).resolves.toBe(true);
  });

  it('records a failure attestation on the active tab when Turnstile is unreachable in best-effort mode', async () => {
    const tab = makeTab('tab-1');
    const { verifier } = createExporter([tab], true);
    turnstile.loadScript = async () => {
      throw new Error('network down');
    };

    await verifier.performPreExportVerification(tab.tab);

    expect(tab.attestations).toEqual([
      {
        success: false,
        verified: false,
        score: 0,
        action: 'export_proof',
        timestamp: expect.any(String),
        hostname: 'unit-test.local',
        signature: '',
      },
    ]);
  });

  it('continues the export when Turnstile verification itself fails in best-effort mode', async () => {
    const tab = makeTab('tab-1');
    const { verifier } = createExporter([tab], true);
    turnstile.verify = async () => ({ success: false, error: 'timeout' });

    await expect(verifier.performPreExportVerification(tab.tab)).resolves.toBe(true);
    expect(tab.attestations[0]?.success).toBe(false);
  });

  it('records the best-effort failure attestation only on the active tab', async () => {
    const active = makeTab('tab-1');
    const other = makeTab('tab-2');
    const { verifier } = createExporter([active, other], true);
    turnstile.verify = async () => ({ success: false, error: 'timeout' });

    await verifier.performPreExportVerification(active.tab);

    expect(active.attestations).toHaveLength(1);
    expect(other.attestations).toHaveLength(0);
  });

  it('aborts the export and notifies the user when Turnstile fails and best-effort is disabled', async () => {
    const tab = makeTab('tab-1');
    const { verifier, notifications } = createExporter([tab], false);
    turnstile.verify = async () => ({ success: false, error: 'timeout' });

    await expect(verifier.performPreExportVerification(tab.tab)).resolves.toBe(false);
    expect(tab.attestations).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(progressDialog.hideCount).toBe(1);
  });

  it('records a successful attestation on the active tab when Turnstile verification succeeds', async () => {
    const tab = makeTab('tab-1');
    const { verifier } = createExporter([tab], true);

    await expect(verifier.performPreExportVerification(tab.tab)).resolves.toBe(true);
    expect(tab.attestations[0]).toMatchObject({ success: true, verified: true, signature: 'sig' });
  });

  it('skips verification without recording an attestation when Turnstile is not configured', async () => {
    const tab = makeTab('tab-1');
    const { verifier } = createExporter([tab], false);
    turnstile.configured = false;

    await expect(verifier.performPreExportVerification(tab.tab)).resolves.toBe(true);
    expect(tab.attestations).toHaveLength(0);
  });
});

describe('ProofExporter.performPreExportVerificationForAllTabs', () => {
  it('records a failure attestation on every tab when Turnstile fails in best-effort mode', async () => {
    const first = makeTab('tab-1');
    const second = makeTab('tab-2');
    const { verifier } = createExporter([first, second], true);
    turnstile.verify = async () => ({ success: false, error: 'timeout' });

    await expect(verifier.performPreExportVerificationForAllTabs()).resolves.toBe(true);
    expect(first.attestations[0]?.success).toBe(false);
    expect(second.attestations[0]?.success).toBe(false);
  });

  it('aborts the export when Turnstile fails and best-effort is disabled', async () => {
    const first = makeTab('tab-1');
    const { verifier, notifications } = createExporter([first], false);
    turnstile.verify = async () => ({ success: false, error: 'timeout' });

    await expect(verifier.performPreExportVerificationForAllTabs()).resolves.toBe(false);
    expect(first.attestations).toHaveLength(0);
    expect(notifications).toHaveLength(1);
  });
});
