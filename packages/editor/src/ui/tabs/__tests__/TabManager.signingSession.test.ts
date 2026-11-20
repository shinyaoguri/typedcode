/**
 * 署名するセッションの選び方 (#317)。
 *
 * 閉じたタブは前のセッションのものも今のセッションへ開き直せる。verifier は 1 つの proof の署名 cp に
 * sessionId が混ざると拒否し (`sessionId mismatch across checkpoints`)、root の token と署名 cp の sessionId の
 * 食い違いも拒否する (ADR-0017)。そのため署名は、proof が既に結びついたセッション (署名済み cp か root の token)
 * で続け、そのセッションの token で送る。結びつきの無い proof は今のセッションで署名する (従来どおり)。
 *
 * 署名サービスの生成をスタブし、TabManager が渡す sessionId と token の解決だけを見る。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckpointData, SessionStartToken } from '@typedcode/shared';

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

const CURRENT = 'session-current';
const PREVIOUS = 'session-previous';

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => 'session-current',
    isInitialized: () => false,
  }),
}));

interface CapturedOptions {
  sessionId: string;
  getSessionStartToken: () => SessionStartToken | null;
}
const created: CapturedOptions[] = [];

vi.mock('../../../services/SignedCheckpointService.js', () => ({
  createSignedCheckpointServiceIfEnabled: (options: CapturedOptions) => {
    created.push(options);
    return { restore: vi.fn(async () => {}), handleNewCheckpoint: vi.fn(), dispose: vi.fn() };
  },
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { TabManager } = await import('../TabManager.js');

interface Internals {
  tabs: Map<string, unknown>;
  attachSignedCheckpointService: (
    tabId: string,
    typingProof: unknown,
    existingCheckpoints?: readonly CheckpointData[]
  ) => unknown;
}

function token(sessionId: string, issuedAt = '2026-11-01T00:00:00.000Z'): SessionStartToken {
  return {
    payload: { sessionId, issuedAt },
    signature: `sig-${sessionId}-${issuedAt}`,
  } as unknown as SessionStartToken;
}

function proof(sessionStartToken: SessionStartToken | null) {
  return {
    sessionStartToken,
    examContext: null,
    getInitialEventChainHash: () => 'h0',
    setOnCheckpointCreated: vi.fn(),
  };
}

function signedCheckpoint(sessionId: string): CheckpointData {
  return { eventIndex: 10, signature: { payload: { sessionId } } } as unknown as CheckpointData;
}

function newManager() {
  const tabManager = new TabManager({ setModel: vi.fn() } as unknown as ConstructorParameters<typeof TabManager>[0]);
  return tabManager as unknown as Internals;
}

describe('TabManager signing session for a tab (#317)', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('keeps signing a reopened tab in the session of its already signed checkpoints, with that session token', () => {
    const tm = newManager();
    const previousToken = token(PREVIOUS);
    const reopened = proof(previousToken);
    tm.tabs.set('reopened', { typingProof: reopened });
    tm.tabs.set('open', { typingProof: proof(token(CURRENT, '2026-11-20T00:00:00.000Z')) });

    tm.attachSignedCheckpointService('reopened', reopened, [signedCheckpoint(PREVIOUS)]);

    expect(created[0]?.sessionId).toBe(PREVIOUS);
    expect(created[0]?.getSessionStartToken()).toBe(previousToken);
  });

  it('signs in the session of the root token when the tab has no signed checkpoint yet', () => {
    const tm = newManager();
    const previousToken = token(PREVIOUS);
    const reopened = proof(previousToken);
    tm.tabs.set('reopened', { typingProof: reopened });

    tm.attachSignedCheckpointService('reopened', reopened, []);

    expect(created[0]?.sessionId).toBe(PREVIOUS);
    expect(created[0]?.getSessionStartToken()).toBe(previousToken);
  });

  it('signs a tab without a session binding in the current session with the current session token', () => {
    const tm = newManager();
    const currentToken = token(CURRENT);
    tm.tabs.set('open', { typingProof: proof(currentToken) });
    const unbound = proof(null);

    tm.attachSignedCheckpointService('unbound', unbound);

    expect(created[0]?.sessionId).toBe(CURRENT);
    expect(created[0]?.getSessionStartToken()).toBe(currentToken);
  });
});
