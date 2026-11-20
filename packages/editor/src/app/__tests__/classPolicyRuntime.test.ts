// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODE_CAPABILITIES_FIXTURE } from '../../core/__tests__/fixtures/modeCapabilities.js';
import { CLASS_POLICY_PRESETS, capabilitiesFor, type EditorMode } from '../../core/mode.js';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { ClassPolicyStore } from '../../services/ClassPolicyStore.js';
import { applyClassPolicy, type ClassPolicyContext } from '../classPolicyRuntime.js';

/** 起動直後 (入口の能力) の AppContext の偽物。tracker・exporter・recorder は呼ばれ方だけを見る */
function bootedContext(mode: EditorMode) {
  const tracker = { setStreamStoppedCallback: vi.fn(), dispose: vi.fn() };
  const caps = capabilitiesFor(mode);
  const ctx = {
    mode,
    capabilities: caps,
    trackers: { screenshot: caps.screenshots ? tracker : null },
    proofExporter: { setPreExportBestEffort: vi.fn(), setScreenshotTracker: vi.fn() },
    fullscreenTracker: { setRecordCallback: vi.fn(), initialize: vi.fn(), dispose: vi.fn() },
    eventRecorder: { forgetSessionSnapshot: vi.fn(), recordToAllTabs: vi.fn() },
  };
  const deps = { startScreenShare: vi.fn(async () => undefined), hideScreenShareUi: vi.fn() };
  return { ctx, tracker, deps, asContext: ctx as unknown as ClassPolicyContext };
}

describe('applyClassPolicy', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    setStorageNamespace('casual');
  });

  it('turns a /class session into the /assignment capabilities for a take-home package', async () => {
    setStorageNamespace('class');
    const { asContext, deps } = bootedContext('class');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS['take-home'], deps);
    expect(asContext.capabilities).toEqual(MODE_CAPABILITIES_FIXTURE.assignment);
  });

  it('stops and detaches the screenshot tracker for a take-home package under /class', async () => {
    setStorageNamespace('class');
    const { ctx, tracker, deps, asContext } = bootedContext('class');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS['take-home'], deps);
    expect([
      tracker.dispose.mock.calls.length,
      ctx.trackers.screenshot,
      ctx.proofExporter.setScreenshotTracker.mock.calls,
      ctx.eventRecorder.forgetSessionSnapshot.mock.calls,
      deps.hideScreenShareUi.mock.calls.length,
    ]).toEqual([1, null, [[null]], [['screenShareOptOut']], 1]);
  });

  it('stops fullscreen tracking and best-effort export for a take-home package under /class', async () => {
    setStorageNamespace('class');
    const { ctx, deps, asContext } = bootedContext('class');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS['take-home'], deps);
    expect([
      ctx.fullscreenTracker.dispose.mock.calls.length,
      ctx.proofExporter.setPreExportBestEffort.mock.calls,
    ]).toEqual([1, [[false]]]);
  });

  it('asks for screen sharing and starts fullscreen tracking for a classroom package under /assignment', async () => {
    setStorageNamespace('assignment');
    const { ctx, deps, asContext } = bootedContext('assignment');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS.classroom, deps);
    expect([
      asContext.capabilities,
      deps.startScreenShare.mock.calls.length,
      ctx.fullscreenTracker.initialize.mock.calls,
      ctx.proofExporter.setPreExportBestEffort.mock.calls,
    ]).toEqual([MODE_CAPABILITIES_FIXTURE.class, 1, [[false]], [[true]]]);
  });

  it('leaves the running trackers alone when the package has no policy', async () => {
    setStorageNamespace('class');
    const { ctx, tracker, deps, asContext } = bootedContext('class');
    await applyClassPolicy(asContext, null, deps);
    expect([
      asContext.capabilities,
      tracker.dispose.mock.calls.length,
      deps.startScreenShare.mock.calls.length,
      ctx.fullscreenTracker.dispose.mock.calls.length,
      ctx.fullscreenTracker.initialize.mock.calls.length,
    ]).toEqual([MODE_CAPABILITIES_FIXTURE.class, 0, 0, 0, 0]);
  });

  it('remembers the policy for the next boot and forgets it for a package without a policy', async () => {
    setStorageNamespace('class');
    const { deps, asContext } = bootedContext('class');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS['take-home'], deps);
    const remembered = ClassPolicyStore.get();
    await applyClassPolicy(asContext, null, deps);
    expect([remembered, ClassPolicyStore.get()]).toEqual([CLASS_POLICY_PRESETS['take-home'], null]);
  });

  it('writes the applied capabilities to the html state contract', async () => {
    setStorageNamespace('class');
    const { deps, asContext } = bootedContext('class');
    await applyClassPolicy(asContext, CLASS_POLICY_PRESETS['take-home'], deps);
    expect(document.documentElement.dataset.capScreenshots).toBe('false');
  });
});
