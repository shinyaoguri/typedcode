/**
 * TabManager.findSigningToken が選ぶ署名用 token (#227)。
 *
 * sign は token の最大有効期間 (30 日) を過ぎると TOKEN_EXPIRED で拒否する。token は
 * タブごとに焼かれ、署名サービスは「sessionId が一致する token」を全タブで共有するので、
 * 最初に見つかったタブの (古い) token を使い続けると、後から開いたタブが新しい token を
 * 持っていても署名が落ちる。sessionId が一致する中で issuedAt が最新の token を選ぶ。
 * Monaco / Turnstile / IndexedDB は node 環境に無いので境界だけスタブする。
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionStartToken } from '@typedcode/shared';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: () => {},
  },
}));

vi.mock('../../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => false,
  performTurnstileVerification: vi.fn(),
}));

vi.mock('../TabVerificationUI.js', () => ({
  performVerificationWithUI: vi.fn(),
}));

const SESSION = 'session-1';

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => 'session-1',
    isInitialized: () => false,
  }),
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { TabManager } = await import('../TabManager.js');

/** private の token 解決と tabs / signingOnlyToken に触るための窓口 */
interface TabManagerInternals {
  tabs: Map<string, unknown>;
  signingOnlyToken: SessionStartToken | null;
  findSigningToken: () => SessionStartToken | null;
}

function token(issuedAt: string, sessionId = SESSION): SessionStartToken {
  return {
    payload: { sessionId, issuedAt },
    signature: `sig-${issuedAt}-${sessionId}`,
  } as unknown as SessionStartToken;
}

function tabWith(sessionStartToken: SessionStartToken | undefined): unknown {
  return { typingProof: { sessionStartToken } };
}

function setup(): TabManagerInternals {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  return tabManager as unknown as TabManagerInternals;
}

describe('TabManager.findSigningToken (#227)', () => {
  it('returns the token with the latest issuedAt among tabs of the current session, not the first tab found', () => {
    const tm = setup();
    const old = token('2026-01-01T00:00:00.000Z');
    const fresh = token('2026-06-01T00:00:00.000Z');
    tm.tabs.set('tab-1', tabWith(old)); // 最初に見つかるタブは古い token
    tm.tabs.set('tab-2', tabWith(fresh));
    tm.tabs.set('tab-3', tabWith(token('2026-03-01T00:00:00.000Z')));

    expect(tm.findSigningToken()).toBe(fresh);
  });

  it('ignores tokens that belong to another session even when they are newer', () => {
    const tm = setup();
    const mine = token('2026-01-01T00:00:00.000Z');
    tm.tabs.set('tab-1', tabWith(mine));
    tm.tabs.set('tab-2', tabWith(token('2026-09-01T00:00:00.000Z', 'other-session')));

    expect(tm.findSigningToken()).toBe(mine);
  });

  it('includes the exam signing-only token in the comparison and picks it when it is the newest', () => {
    const tm = setup();
    tm.tabs.set('tab-1', tabWith(token('2026-01-01T00:00:00.000Z')));
    const signingOnly = token('2026-08-01T00:00:00.000Z');
    tm.signingOnlyToken = signingOnly;

    expect(tm.findSigningToken()).toBe(signingOnly);
  });

  it('returns null when no tab holds a token for the current session', () => {
    const tm = setup();
    tm.tabs.set('tab-1', tabWith(undefined));
    tm.tabs.set('tab-2', tabWith(token('2026-09-01T00:00:00.000Z', 'other-session')));

    expect(tm.findSigningToken()).toBeNull();
  });
});
