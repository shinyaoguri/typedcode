import { describe, expect, it } from 'vitest';
import {
  ALL_EDITOR_MODES,
  capabilitiesFor,
  MODE_CAPABILITIES,
  resolveModeFromPath,
  type EditorMode,
} from '../mode.js';

describe('resolveModeFromPath', () => {
  it('maps /exam to exam mode', () => {
    expect(resolveModeFromPath('/exam')).toBe('exam');
  });

  it('maps /class to class mode', () => {
    expect(resolveModeFromPath('/class')).toBe('class');
  });

  it('maps /assignment to assignment mode', () => {
    expect(resolveModeFromPath('/assignment')).toBe('assignment');
  });

  it('falls back to casual at the root path', () => {
    expect(resolveModeFromPath('/')).toBe('casual');
  });

  it('falls back to casual for an empty path', () => {
    expect(resolveModeFromPath('')).toBe('casual');
  });

  it('falls back to casual for an unknown first segment', () => {
    expect(resolveModeFromPath('/playground')).toBe('casual');
  });

  it('uses only the first path segment so nested paths keep the mode', () => {
    expect(resolveModeFromPath('/exam/problem-1')).toBe('exam');
  });

  it('is case-insensitive on the segment', () => {
    expect(resolveModeFromPath('/EXAM')).toBe('exam');
  });

  it('tolerates leading slashes', () => {
    expect(resolveModeFromPath('//exam')).toBe('exam');
  });

  it('does not treat a substring match as the mode (examples is not exam)', () => {
    expect(resolveModeFromPath('/examples')).toBe('casual');
  });
});

describe('capabilitiesFor', () => {
  it('grants exam the sealed-problem capability', () => {
    expect(capabilitiesFor('exam').sealedProblem).toBe(true);
  });

  it('denies casual the sealed-problem capability', () => {
    expect(capabilitiesFor('casual').sealedProblem).toBe(false);
  });

  it('disables screenshots for assignment (take-home privacy)', () => {
    expect(capabilitiesFor('assignment').screenshots).toBe(false);
  });

  it('keeps assignment identical to casual apart from screenshots', () => {
    const casual = capabilitiesFor('casual');
    const assignment = capabilitiesFor('assignment');
    expect(assignment).toEqual({ ...casual, screenshots: false });
  });

  it('gives class the problem panel without the sealed-problem crypto (ADR-0014)', () => {
    const cls = capabilitiesFor('class');
    expect(cls.problemPanel).toBe(true);
    expect(cls.sealedProblem).toBe(false);
  });

  it('tracks fullscreen passively for class (no request banner)', () => {
    const cls = capabilitiesFor('class');
    expect(cls.fullscreenTracking).toBe(true);
    expect(cls.fullscreenBanner).toBe(false);
  });

  it('shows the fullscreen request banner only for exam', () => {
    const withBanner = ALL_EDITOR_MODES.filter((m) => capabilitiesFor(m).fullscreenBanner);
    expect(withBanner).toEqual(['exam']);
  });

  it('keeps tabs unlocked for class (looser than exam)', () => {
    expect(capabilitiesFor('class').tabLock).toBe(false);
  });

  it('enables best-effort pre-export for the proctored in-room modes (class, exam)', () => {
    const withBestEffort = ALL_EDITOR_MODES.filter((m) => capabilitiesFor(m).preExportBestEffort);
    expect(withBestEffort).toEqual(['class', 'exam']);
  });
});

describe('mode model invariants', () => {
  it('lists exactly the four known modes', () => {
    expect(ALL_EDITOR_MODES).toEqual(['casual', 'class', 'assignment', 'exam']);
  });

  it('defines capabilities for every mode', () => {
    for (const mode of ALL_EDITOR_MODES) {
      expect(MODE_CAPABILITIES[mode as EditorMode]).toBeDefined();
    }
  });
});
