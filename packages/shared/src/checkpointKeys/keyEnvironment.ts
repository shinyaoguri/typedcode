/**
 * checkpoint 鍵の環境をどこまで信頼するか (#321)。
 *
 * registry には production と staging の鍵が並ぶ (`registry.ts`)。検証器は registry の全鍵で署名を検証し、
 * そのあとで鍵の環境を信頼するかを決める。信頼しない環境の鍵の証拠 (sessionStartToken・署名 cp) は
 * 「無い」ものとして扱い、時刻アンカーに数えない。整合性と総合の `valid` は落とさない (改ざんではない)。
 *
 * 信頼する環境の決め方はここ 1 か所に置き、verify-cli (`--allow-staging-keys`) と verify (staging ビルド) が
 * 同じ関数を呼ぶ (結論を食い違わせない)。
 */

import type { CheckpointKeyEnvironment } from './registry.js';

/**
 * 既定で信頼する環境。development は gitignore 済みの localKeys.ts の鍵で、本番の配信物と CI の
 * 検証器には載らない (#338)。手元の dev / e2e の鍵を通すために信頼する。
 */
export const DEFAULT_TRUSTED_CHECKPOINT_KEY_ENVIRONMENTS: readonly CheckpointKeyEnvironment[] = Object.freeze([
  'production',
  'development',
]);

/** すべての環境。呼び出し側が渡した鍵の一覧そのものを信頼の範囲にするとき (仕様別の入口) に使う */
export const ALL_CHECKPOINT_KEY_ENVIRONMENTS: readonly CheckpointKeyEnvironment[] = Object.freeze([
  'production',
  'staging',
  'development',
]);

/**
 * 検証器が信頼する環境を返す。`allowStaging` のときだけ staging を足す
 * (verify-cli の `--allow-staging-keys` と、staging 用にビルドした verify)。
 */
export function trustedCheckpointKeyEnvironments(options: {
  allowStaging: boolean;
}): readonly CheckpointKeyEnvironment[] {
  return options.allowStaging ? ALL_CHECKPOINT_KEY_ENVIRONMENTS : DEFAULT_TRUSTED_CHECKPOINT_KEY_ENVIRONMENTS;
}

/**
 * 署名は registry の鍵で検証できたが、その鍵の環境を信頼しなかった証拠の鍵 (#321)。
 * keyId は registry の値 (proof 由来の未登録の値ではない)。
 */
export interface UntrustedEnvironmentKey {
  keyId: string;
  /** registry のエントリの環境。エントリに環境が無かった (型を通らない JSON の registry) ときは付かない */
  environment?: CheckpointKeyEnvironment;
}

/**
 * 鍵の環境を信頼するか。環境の無いエントリ・知らない値は信頼しない (fail-closed。registry.ts は型と
 * `registryFormat.test.ts` が環境を強制するが、JSON から読んだ registry を注入されたときに素通しさせない)。
 */
export function isCheckpointKeyEnvironmentTrusted(
  environment: unknown,
  trusted: readonly CheckpointKeyEnvironment[]
): boolean {
  return typeof environment === 'string' && (trusted as readonly string[]).includes(environment);
}
