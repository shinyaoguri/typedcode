/**
 * checkpoint 鍵の環境の信頼の範囲 (#321)。verify-cli (`--allow-staging-keys`) と verify (staging ビルド) が
 * 同じ関数で決めるので、ここで範囲そのものを固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUSTED_CHECKPOINT_KEY_ENVIRONMENTS,
  isCheckpointKeyEnvironmentTrusted,
  trustedCheckpointKeyEnvironments,
} from '../index.js';

describe('trustedCheckpointKeyEnvironments (#321)', () => {
  it('trusts production and development but not staging by default', () => {
    const trusted = trustedCheckpointKeyEnvironments({ allowStaging: false });

    expect([...trusted].sort()).toEqual(['development', 'production']);
  });

  it('adds staging only when staging is explicitly allowed', () => {
    const trusted = trustedCheckpointKeyEnvironments({ allowStaging: true });

    expect([...trusted].sort()).toEqual(['development', 'production', 'staging']);
  });

  it('uses the default trust when staging is not allowed', () => {
    expect(trustedCheckpointKeyEnvironments({ allowStaging: false })).toBe(DEFAULT_TRUSTED_CHECKPOINT_KEY_ENVIRONMENTS);
  });
});

describe('isCheckpointKeyEnvironmentTrusted (#321)', () => {
  it('does not trust a key whose registry entry has no environment', () => {
    expect(isCheckpointKeyEnvironmentTrusted(undefined, ['production', 'staging', 'development'])).toBe(false);
  });

  it('does not trust an environment name outside the trusted list', () => {
    expect(isCheckpointKeyEnvironmentTrusted('Production', ['production'])).toBe(false);
  });

  it('trusts an environment in the trusted list', () => {
    expect(isCheckpointKeyEnvironmentTrusted('staging', ['staging'])).toBe(true);
  });
});
