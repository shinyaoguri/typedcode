/**
 * Config module - 設定とタイプ定義
 *
 * 検証タイプや設定値を一元管理します。
 * 新しい検証タイプを追加する際はここを拡張します。
 */

export {
  VERIFICATION_TYPES,
  getVerificationType,
  getDefaultVerificationType,
  isValidVerificationType,
} from './VerificationTypes.js';

export type {
  VerificationTypeId,
  VerificationTypeDefinition,
} from './VerificationTypes.js';
