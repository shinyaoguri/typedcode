/**
 * EnvironmentTracker (ADR-0007 Tier0 / ADR-0019) の recordInitial テスト。
 *
 * #132: 起動時ワンショットの environmentProbe が EventRecorder 未生成のタイミングで
 * 発火して無音ドロップし、全 proof から欠落していた。main.ts 側の順序修正 (Phase 4.9)
 * と併せて、tracker 自体が callback へ確実に 1 発出すことをここで固定する
 * (チェーンに載る end-to-end は e2e happy-path が assert する)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvironmentTracker, type EnvironmentTrackerEvent } from '../EnvironmentTracker.js';
import type { EditorAssistDeclaration } from '@typedcode/shared';

function assist(): EditorAssistDeclaration {
  return {
    schema: 'editor-assist/1',
    quickSuggestions: null,
    suggestOnTriggerCharacters: null,
    wordBasedSuggestions: null,
    snippetSuggestions: null,
    inlineSuggest: null,
    tabCompletion: null,
    acceptSuggestionOnEnter: null,
    parameterHints: null,
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoSurround: 'languageDefined',
    formatOnType: null,
    formatOnPaste: null,
  };
}

describe('EnvironmentTracker.recordInitial', () => {
  beforeEach(() => {
    // node 環境に window は無いので capture が読む範囲だけ偽装する
    vi.stubGlobal('window', { __playwright: {}, cdc_asdjflasutopfhvcZLmcfl_: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits exactly one environmentProbe event to the callback', () => {
    const tracker = new EnvironmentTracker();
    const events: EnvironmentTrackerEvent[] = [];
    tracker.setCallback((e) => events.push(e));

    tracker.recordInitial();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('environmentProbe');
  });

  it('captures automation globals (playwright hint and cdc_* prefix)', () => {
    const tracker = new EnvironmentTracker();
    const events: EnvironmentTrackerEvent[] = [];
    tracker.setCallback((e) => events.push(e));

    tracker.recordInitial();

    const globals = events[0]!.data.automationGlobals;
    expect(globals).toContain('__playwright');
    expect(globals.some((g) => g.startsWith('cdc_'))).toBe(true);
  });

  it('includes the editor-assist declaration from the provider (ADR-0019)', () => {
    const tracker = new EnvironmentTracker();
    const decl = assist();
    tracker.setAssistDeclarationProvider(() => decl);
    const events: EnvironmentTrackerEvent[] = [];
    tracker.setCallback((e) => events.push(e));

    tracker.recordInitial();

    expect(events[0]!.data.editorAssist).toBe(decl);
  });

  it('records editorAssist: null when the provider throws (graceful absence)', () => {
    const tracker = new EnvironmentTracker();
    tracker.setAssistDeclarationProvider(() => {
      throw new Error('resolution failed');
    });
    const events: EnvironmentTrackerEvent[] = [];
    tracker.setCallback((e) => events.push(e));

    tracker.recordInitial();

    expect(events[0]!.data.editorAssist).toBeNull();
  });
});
