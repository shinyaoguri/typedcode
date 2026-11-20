/**
 * このビルドの verify が staging の checkpoint 鍵を時刻証拠に数えるか (#321)。
 *
 * 値はビルド時に Vite の define (`__TYPEDCODE_TRUST_STAGING_KEYS__`) で焼かれる。決め方は
 * `scripts/checkpoint-key-trust.mjs` (環境変数 `TYPEDCODE_TRUST_STAGING_KEYS`)。deploy.yml は staging と
 * PR プレビューのビルドにだけ `true` を渡す。define の無い実行 (vitest) では false。
 *
 * 信頼する環境の範囲そのものは shared の `trustedCheckpointKeyEnvironments` が決める (verify-cli の
 * `--allow-staging-keys` と同じ関数。ここで範囲を書き起こさない)。
 */

import { trustedCheckpointKeyEnvironments, type CheckpointKeyEnvironment } from '@typedcode/shared';

declare const __TYPEDCODE_TRUST_STAGING_KEYS__: boolean | undefined;

/** このビルドが staging の鍵を信頼するか。define が無い (= 焼かれていない) ときは信頼しない */
export const BUILD_TRUSTS_STAGING_KEYS: boolean =
  typeof __TYPEDCODE_TRUST_STAGING_KEYS__ !== 'undefined' && __TYPEDCODE_TRUST_STAGING_KEYS__ === true;

/** 検証に渡す、時刻証拠に数える鍵の環境 */
export function trustedKeyEnvironmentsForBuild(
  trustStagingKeys: boolean = BUILD_TRUSTS_STAGING_KEYS
): readonly CheckpointKeyEnvironment[] {
  return trustedCheckpointKeyEnvironments({ allowStaging: trustStagingKeys });
}
