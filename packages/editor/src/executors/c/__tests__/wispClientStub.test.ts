import { describe, expect, it } from 'vitest';
import { client } from '../wispClientStub.js';

describe('wispClientStub', () => {
  it('refuses to open a WISP connection instead of silently doing nothing', () => {
    expect(() => new client.ClientConnection()).toThrow(/WISP networking is disabled/);
  });
});
