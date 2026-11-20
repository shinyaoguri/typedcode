import type { ClassPolicy } from '@typedcode/shared';
import { describe, expect, it } from 'vitest';
import { ALL_EDITOR_MODES, CLASS_POLICY_PRESETS, acceptsClassPolicy, capabilitiesWithPolicy } from '../mode.js';
import { MODE_CAPABILITIES_FIXTURE } from './fixtures/modeCapabilities.js';

// #645: .tcclass の方針 (policy) と入口 (/class /assignment) の能力の関係。
// 期待値は着手時点の能力の写し (fixtures/modeCapabilities.ts) から取る。
describe('class policy presets', () => {
  it('makes the classroom preset carry the /class entry values', () => {
    const { screenshots, fullscreenTracking, preExportBestEffort } = MODE_CAPABILITIES_FIXTURE.class;
    expect(CLASS_POLICY_PRESETS.classroom).toEqual({ screenshots, fullscreenTracking, preExportBestEffort });
  });

  it('makes the take-home preset carry the /assignment entry values', () => {
    const { screenshots, fullscreenTracking, preExportBestEffort } = MODE_CAPABILITIES_FIXTURE.assignment;
    expect(CLASS_POLICY_PRESETS['take-home']).toEqual({ screenshots, fullscreenTracking, preExportBestEffort });
  });
});

describe('capabilitiesWithPolicy', () => {
  it.each(ALL_EDITOR_MODES)('keeps the %s entry capabilities when the package has no policy', (mode) => {
    expect(capabilitiesWithPolicy(mode, null)).toEqual(MODE_CAPABILITIES_FIXTURE[mode]);
  });

  it('opens a take-home package under /class with exactly the /assignment capabilities', () => {
    expect(capabilitiesWithPolicy('class', CLASS_POLICY_PRESETS['take-home'])).toEqual(
      MODE_CAPABILITIES_FIXTURE.assignment
    );
  });

  it('opens a classroom package under /assignment with exactly the /class capabilities', () => {
    expect(capabilitiesWithPolicy('assignment', CLASS_POLICY_PRESETS.classroom)).toEqual(
      MODE_CAPABILITIES_FIXTURE.class
    );
  });

  it('asks for screen sharing at start exactly when the policy takes screenshots', () => {
    const custom: ClassPolicy = { screenshots: true, fullscreenTracking: false, preExportBestEffort: false };
    expect(capabilitiesWithPolicy('assignment', custom).promptScreenShareAtStart).toBe(true);
    expect(capabilitiesWithPolicy('class', { ...custom, screenshots: false }).promptScreenShareAtStart).toBe(false);
  });

  it.each(['casual', 'exam'] as const)('ignores a policy in %s, which does not load .tcclass', (mode) => {
    expect(capabilitiesWithPolicy(mode, CLASS_POLICY_PRESETS['take-home'])).toEqual(MODE_CAPABILITIES_FIXTURE[mode]);
  });
});

describe('acceptsClassPolicy', () => {
  it('accepts a policy only in the unsealed problem modes (class, assignment)', () => {
    expect(ALL_EDITOR_MODES.filter(acceptsClassPolicy)).toEqual(['class', 'assignment']);
  });
});
