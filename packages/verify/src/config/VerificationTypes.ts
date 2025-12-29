/**
 * VerificationTypes - 検証タイプ定義
 *
 * 対応する検証タイプを設定ファーストで管理します。
 * 新しい検証タイプを追加する際はここに定義を追加します。
 *
 * editor プロジェクトの SupportedLanguages.ts パターンに準拠。
 */

// ============================================================================
// 型定義
// ============================================================================

/** 検証タイプID */
export type VerificationTypeId = 'standard' | 'sampled' | 'full';

/** 検証タイプ定義 */
export interface VerificationTypeDefinition {
  /** 一意のID */
  id: VerificationTypeId;
  /** 表示名 */
  displayName: string;
  /** 説明 */
  description: string;
  /** チェックポイントをサポートするか */
  supportsCheckpoints: boolean;
  /** デフォルトのサンプリング数（サンプリング検証の場合） */
  defaultSampleSize?: number;
  /** 推奨されるイベント数の閾値 */
  recommendedEventThreshold?: number;
}

// ============================================================================
// 検証タイプ定義
// ============================================================================

/**
 * サポートされる検証タイプ
 *
 * 新しい検証タイプを追加する場合：
 * 1. VerificationTypeId に新しいIDを追加
 * 2. このリストに定義を追加
 * 3. VerificationEngine に対応ロジックを実装
 */
export const VERIFICATION_TYPES: readonly VerificationTypeDefinition[] = [
  {
    id: 'standard',
    displayName: '標準検証',
    description: 'チェックポイントの有無に応じて自動的に最適な検証方法を選択',
    supportsCheckpoints: true,
    recommendedEventThreshold: 1000,
  },
  {
    id: 'sampled',
    displayName: 'サンプリング検証',
    description: 'チェックポイントを使用した高速なサンプリング検証',
    supportsCheckpoints: true,
    defaultSampleSize: 3,
    recommendedEventThreshold: 5000,
  },
  {
    id: 'full',
    displayName: '全件検証',
    description: '全てのイベントを順番に検証（時間がかかる場合があります）',
    supportsCheckpoints: false,
    recommendedEventThreshold: 0,
  },
] as const;

// ============================================================================
// ユーティリティ関数
// ============================================================================

/**
 * 検証タイプを取得
 */
export function getVerificationType(id: VerificationTypeId): VerificationTypeDefinition | undefined {
  return VERIFICATION_TYPES.find(t => t.id === id);
}

/**
 * デフォルトの検証タイプを取得
 */
export function getDefaultVerificationType(): VerificationTypeDefinition {
  return VERIFICATION_TYPES[0]!;
}

/**
 * 有効な検証タイプIDかどうかをチェック
 */
export function isValidVerificationType(id: string): id is VerificationTypeId {
  return VERIFICATION_TYPES.some(t => t.id === id);
}

/**
 * イベント数に基づいて推奨される検証タイプを取得
 */
export function getRecommendedVerificationType(
  eventCount: number,
  hasCheckpoints: boolean
): VerificationTypeDefinition {
  // チェックポイントがない場合は全件検証のみ
  if (!hasCheckpoints) {
    return VERIFICATION_TYPES.find(t => t.id === 'full')!;
  }

  // イベント数が多い場合はサンプリング検証を推奨
  if (eventCount > 5000) {
    return VERIFICATION_TYPES.find(t => t.id === 'sampled')!;
  }

  // デフォルトは標準検証
  return getDefaultVerificationType();
}
