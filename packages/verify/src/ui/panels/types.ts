/**
 * Panel types - パネル共通の型定義
 */

import type { ProofFile, VerificationResultData } from '../../types.js';

/** パネルのレンダリングコンテキスト */
export interface PanelRenderContext {
  /** 証明データ */
  proofData: ProofFile;
  /** 検証結果 */
  verificationResult: VerificationResultData;
  /** チェーン検証が有効か */
  chainValid: boolean;
  /** 純粋なタイピングか */
  isPureTyping: boolean;
}

/** パネルインターフェース */
export interface IPanel {
  /** パネルをレンダリング */
  render(context: PanelRenderContext): void;
  /** パネルをクリア */
  clear(): void;
  /** パネルの表示/非表示を設定 */
  setVisible(visible: boolean): void;
}
