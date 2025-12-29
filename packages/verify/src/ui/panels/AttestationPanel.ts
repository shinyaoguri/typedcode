/**
 * AttestationPanel - 人間証明書パネル
 *
 * 人間証明書（作成時・エクスポート時・旧形式）の検証結果を表示します。
 */

import type { HumanAttestationEventData } from '@typedcode/shared';
import type { HumanAttestation } from '../../types.js';
import { AttestationService } from '../../services/AttestationService.js';
import type { IPanel, PanelRenderContext } from './types.js';

/** AttestationPanel の設定 */
export interface AttestationPanelOptions {
  /** セクション要素 */
  sectionEl: HTMLElement | null;
  /** 作成時attestation項目 */
  createItemEl: HTMLElement | null;
  /** 作成時バッジ */
  createBadgeEl: HTMLElement | null;
  /** 作成時時刻 */
  createTimeEl: HTMLElement | null;
  /** エクスポート時attestation項目 */
  exportItemEl: HTMLElement | null;
  /** エクスポート時バッジ */
  exportBadgeEl: HTMLElement | null;
  /** エクスポート時時刻 */
  exportTimeEl: HTMLElement | null;
  /** 旧形式attestation項目 */
  legacyItemEl: HTMLElement | null;
  /** 旧形式バッジ */
  legacyBadgeEl: HTMLElement | null;
  /** 旧形式メッセージ */
  legacyMessageEl: HTMLElement | null;
  /** スコア要素（旧形式互換） */
  scoreEl: HTMLElement | null;
  /** タイムスタンプ要素（旧形式互換） */
  timestampEl: HTMLElement | null;
  /** ホスト名要素（旧形式互換） */
  hostnameEl: HTMLElement | null;
}

/** 検証コールバック */
export interface AttestationPanelCallbacks {
  /** 検証開始 */
  onVerifyStart?: (label: string) => void;
  /** 検証完了 */
  onVerifyComplete?: (label: string, valid: boolean) => void;
}

/**
 * 人間証明書パネル
 */
export class AttestationPanel implements IPanel {
  private options: AttestationPanelOptions;
  private callbacks: AttestationPanelCallbacks;
  private attestationService: AttestationService;

  constructor(options: AttestationPanelOptions, callbacks: AttestationPanelCallbacks = {}) {
    this.options = options;
    this.callbacks = callbacks;
    this.attestationService = new AttestationService();
  }

  /**
   * レンダリング（検証は別途 verifyAndRender を使用）
   *
   * 注意: このメソッドは同期的なレンダリングのみ行います。
   * API検証を含む場合は verifyAndRender() を使用してください。
   */
  render(_context: PanelRenderContext): void {
    // 検証結果がキャッシュされている場合のみ表示
    // 通常は verifyAndRender() を使用
  }

  /**
   * 検証してレンダリング
   */
  async verifyAndRender(
    createAttestation: HumanAttestationEventData | null,
    exportAttestation: HumanAttestationEventData | null,
    legacyAttestation: HumanAttestation | undefined
  ): Promise<boolean> {
    if (this.options.sectionEl) {
      this.options.sectionEl.style.display = 'table-row';
    }

    // すべての項目を非表示に初期化
    this.hideAllItems();

    let allValid = true;

    // 新形式: 作成時 + エクスポート時の両方がある場合
    if (createAttestation && exportAttestation) {
      const createValid = await this.verifySingleAttestation(
        createAttestation,
        this.options.createBadgeEl,
        this.options.createTimeEl,
        this.options.createItemEl,
        '作成時'
      );
      const exportValid = await this.verifySingleAttestation(
        exportAttestation,
        this.options.exportBadgeEl,
        this.options.exportTimeEl,
        this.options.exportItemEl,
        'エクスポート時'
      );
      allValid = createValid && exportValid;
    }
    // 新形式: 作成時のみ
    else if (createAttestation) {
      allValid = await this.verifySingleAttestation(
        createAttestation,
        this.options.createBadgeEl,
        this.options.createTimeEl,
        this.options.createItemEl,
        '作成時'
      );
    }
    // 旧形式: トップレベルのhumanAttestation
    else if (legacyAttestation) {
      if (this.options.legacyItemEl) {
        this.options.legacyItemEl.style.display = 'flex';
      }

      this.callbacks.onVerifyStart?.('旧形式');
      const result = await this.attestationService.verify(legacyAttestation);
      this.callbacks.onVerifyComplete?.('旧形式', result.valid);

      if (result.valid) {
        if (this.options.legacyBadgeEl) {
          this.options.legacyBadgeEl.innerHTML = '✅ 検証済み（旧形式）';
          this.options.legacyBadgeEl.className = 'badge-inline success';
        }
        if (this.options.legacyMessageEl) {
          this.options.legacyMessageEl.textContent = 'エクスポート時に認証';
        }
      } else {
        if (this.options.legacyBadgeEl) {
          this.options.legacyBadgeEl.innerHTML = '❌ 無効';
          this.options.legacyBadgeEl.className = 'badge-inline error';
        }
        if (this.options.legacyMessageEl) {
          this.options.legacyMessageEl.textContent = result.message;
        }
      }
      allValid = result.valid;
    }
    // 証明書なし
    else {
      if (this.options.legacyItemEl) {
        this.options.legacyItemEl.style.display = 'flex';
      }
      if (this.options.legacyBadgeEl) {
        this.options.legacyBadgeEl.innerHTML = '⚠️ なし';
        this.options.legacyBadgeEl.className = 'badge-inline warning';
      }
      if (this.options.legacyMessageEl) {
        this.options.legacyMessageEl.textContent = '人間証明書が含まれていません';
      }
      allValid = true; // 証明書なしでも検証は成功扱い
    }

    // 旧形式互換の隠し要素も更新
    const attestation = createAttestation ?? legacyAttestation;
    if (attestation) {
      this.updateLegacyFields(attestation);
    }

    return allValid;
  }

  /**
   * 単一のattestation項目を検証・表示
   */
  private async verifySingleAttestation(
    attestation: HumanAttestation | HumanAttestationEventData,
    badgeEl: HTMLElement | null,
    timeEl: HTMLElement | null,
    itemEl: HTMLElement | null,
    label: string
  ): Promise<boolean> {
    if (!itemEl) return true;
    itemEl.style.display = 'flex';

    this.callbacks.onVerifyStart?.(label);
    const result = await this.attestationService.verify(attestation);
    this.callbacks.onVerifyComplete?.(label, result.valid);

    if (result.valid) {
      if (badgeEl) {
        badgeEl.innerHTML = '✅ 有効';
        badgeEl.className = 'badge-inline success';
      }
    } else {
      if (badgeEl) {
        badgeEl.innerHTML = '❌ 無効';
        badgeEl.className = 'badge-inline error';
      }
    }

    if (timeEl) {
      timeEl.textContent = this.attestationService.formatTimestamp(attestation.timestamp);
    }

    return result.valid;
  }

  /**
   * 旧形式互換フィールドを更新
   */
  private updateLegacyFields(attestation: HumanAttestation | HumanAttestationEventData): void {
    if (this.options.scoreEl) {
      const score = attestation.score;
      this.options.scoreEl.textContent = Number.isFinite(score) && score >= 0 && score <= 1
        ? `${score.toFixed(2)}`
        : '-';
    }
    if (this.options.timestampEl) {
      this.options.timestampEl.textContent = attestation.timestamp;
    }
    if (this.options.hostnameEl) {
      this.options.hostnameEl.textContent = attestation.hostname;
    }
  }

  /**
   * すべてのアイテムを非表示
   */
  private hideAllItems(): void {
    if (this.options.createItemEl) this.options.createItemEl.style.display = 'none';
    if (this.options.exportItemEl) this.options.exportItemEl.style.display = 'none';
    if (this.options.legacyItemEl) this.options.legacyItemEl.style.display = 'none';
  }

  clear(): void {
    this.hideAllItems();
    if (this.options.sectionEl) {
      this.options.sectionEl.style.display = 'none';
    }
  }

  setVisible(visible: boolean): void {
    if (this.options.sectionEl) {
      this.options.sectionEl.style.display = visible ? 'table-row' : 'none';
    }
  }
}
