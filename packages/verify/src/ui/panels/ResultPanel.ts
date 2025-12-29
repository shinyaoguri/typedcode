/**
 * ResultPanel - 検証結果パネル統括
 *
 * 各サブパネル（Chain, PoSW, Attestation, Metadata）を統括し、
 * 検証結果の表示を一元管理します。
 */

import type { HumanAttestationEventData } from '@typedcode/shared';
import type { ProofFile, VerificationResultData, HumanAttestation } from '../../types.js';
import { VerificationEngine } from '../../core/VerificationEngine.js';
import { ChainPanel, type ChainPanelOptions } from './ChainPanel.js';
import { PoswPanel, type PoswPanelOptions } from './PoswPanel.js';
import { AttestationPanel, type AttestationPanelOptions, type AttestationPanelCallbacks } from './AttestationPanel.js';
import { MetadataPanel, type MetadataPanelOptions } from './MetadataPanel.js';
import type { PanelRenderContext } from './types.js';

/** ResultPanel の設定 */
export interface ResultPanelOptions {
  /** 結果セクション要素 */
  resultSectionEl: HTMLElement | null;
  /** Chain パネル設定 */
  chain: ChainPanelOptions;
  /** PoSW パネル設定 */
  posw: PoswPanelOptions;
  /** Attestation パネル設定 */
  attestation: AttestationPanelOptions;
  /** Metadata パネル設定 */
  metadata: MetadataPanelOptions;
}

/** ResultPanel コールバック */
export interface ResultPanelCallbacks {
  /** Attestation検証コールバック */
  attestation?: AttestationPanelCallbacks;
}

/**
 * 検証結果パネル統括
 */
export class ResultPanel {
  private options: ResultPanelOptions;
  private chainPanel: ChainPanel;
  private poswPanel: PoswPanel;
  private attestationPanel: AttestationPanel;
  private metadataPanel: MetadataPanel;
  private verificationEngine: VerificationEngine;

  constructor(options: ResultPanelOptions, callbacks: ResultPanelCallbacks = {}) {
    this.options = options;
    this.chainPanel = new ChainPanel(options.chain);
    this.poswPanel = new PoswPanel(options.posw);
    this.attestationPanel = new AttestationPanel(options.attestation, callbacks.attestation);
    this.metadataPanel = new MetadataPanel(options.metadata);
    this.verificationEngine = new VerificationEngine();
  }

  /**
   * 検証結果をレンダリング
   *
   * @param proofData 証明データ
   * @param verificationResult 検証結果（Workerで計算済み）
   */
  async render(proofData: ProofFile, verificationResult: VerificationResultData): Promise<void> {
    // 結果セクションを表示
    if (this.options.resultSectionEl) {
      this.options.resultSectionEl.style.display = 'flex';
    }

    // レンダリングコンテキストを作成
    const context: PanelRenderContext = {
      proofData,
      verificationResult,
      chainValid: verificationResult.chainValid,
      isPureTyping: verificationResult.isPureTyping,
    };

    // 各パネルをレンダリング
    this.chainPanel.render(context);
    this.poswPanel.render(context);
    this.metadataPanel.render(context);

    // Attestation は API 検証が必要なので別途処理
    const attestationInfo = this.verificationEngine.extractAttestations(proofData);
    await this.attestationPanel.verifyAndRender(
      attestationInfo.createAttestation,
      attestationInfo.exportAttestation,
      attestationInfo.legacyAttestation
    );
  }

  /**
   * Attestation を個別に検証・レンダリング
   */
  async renderAttestation(
    createAttestation: HumanAttestationEventData | null,
    exportAttestation: HumanAttestationEventData | null,
    legacyAttestation: HumanAttestation | undefined
  ): Promise<boolean> {
    return this.attestationPanel.verifyAndRender(
      createAttestation,
      exportAttestation,
      legacyAttestation
    );
  }

  /**
   * Chain パネルのみレンダリング
   */
  renderChain(context: PanelRenderContext): void {
    this.chainPanel.render(context);
  }

  /**
   * PoSW パネルのみレンダリング
   */
  renderPosw(context: PanelRenderContext): void {
    this.poswPanel.render(context);
  }

  /**
   * Metadata パネルのみレンダリング
   */
  renderMetadata(context: PanelRenderContext): void {
    this.metadataPanel.render(context);
  }

  /**
   * すべてのパネルをクリア
   */
  clear(): void {
    this.chainPanel.clear();
    this.poswPanel.clear();
    this.attestationPanel.clear();
    this.metadataPanel.clear();
  }

  /**
   * 結果セクションの表示/非表示を設定
   */
  setVisible(visible: boolean): void {
    if (this.options.resultSectionEl) {
      this.options.resultSectionEl.style.display = visible ? 'flex' : 'none';
    }
  }

  /**
   * 結果セクションを表示してスクロール
   */
  showAndScroll(): void {
    if (this.options.resultSectionEl) {
      this.options.resultSectionEl.style.display = 'flex';
      this.options.resultSectionEl.scrollIntoView({ behavior: 'smooth' });
    }
  }
}
