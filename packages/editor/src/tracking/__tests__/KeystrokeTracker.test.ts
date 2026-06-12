/**
 * KeystrokeTracker の isTrusted 捕捉 (ADR-0018) テスト。
 *
 * - 合成打鍵 (isTrusted=false) は keystrokeData.isTrusted=false を載せる。
 * - 信頼打鍵 (isTrusted=true) は **省略** する (通常タイピングの event data を従来とバイト一致に保つ)。
 */

import { describe, it, expect } from 'vitest';
import { KeystrokeTracker, type KeystrokeEvent } from '../KeystrokeTracker.js';

/** handleKeyDown/handleKeyUp が読むフィールドだけを持つ KeyboardEvent 風オブジェクト。 */
function fakeKey(over: Partial<{ key: string; code: string; isTrusted: boolean }> = {}): KeyboardEvent {
  return {
    key: 'a',
    code: 'KeyA',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isTrusted: true,
    ...over,
  } as unknown as KeyboardEvent;
}

function capture(handler: (tracker: KeystrokeTracker) => void): KeystrokeEvent[] {
  const tracker = new KeystrokeTracker();
  const events: KeystrokeEvent[] = [];
  tracker.setCallback((e) => events.push(e));
  handler(tracker);
  return events;
}

describe('KeystrokeTracker isTrusted capture (ADR-0018)', () => {
  it('marks a synthetic (isTrusted=false) keyDown with data.isTrusted=false', () => {
    const events = capture((tr) => tr.handleKeyDown(fakeKey({ isTrusted: false })));
    expect(events).toHaveLength(1);
    expect(events[0]!.data.isTrusted).toBe(false);
  });

  it('marks a synthetic (isTrusted=false) keyUp with data.isTrusted=false', () => {
    const events = capture((tr) => {
      tr.handleKeyDown(fakeKey({ isTrusted: false }));
      tr.handleKeyUp(fakeKey({ isTrusted: false }));
    });
    const keyUp = events.find((e) => e.type === 'keyUp');
    expect(keyUp?.data.isTrusted).toBe(false);
  });

  it('omits isTrusted for a trusted keyDown (hash-identical to legacy)', () => {
    const events = capture((tr) => tr.handleKeyDown(fakeKey({ isTrusted: true })));
    expect(events).toHaveLength(1);
    expect('isTrusted' in events[0]!.data).toBe(false);
  });
});
