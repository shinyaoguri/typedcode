import { describe, expect, it } from 'vitest';
import { extensionToLanguage } from '../starterLanguage.js';

describe('extensionToLanguage', () => {
  it('maps C++ extensions to cpp regardless of case', () => {
    expect(extensionToLanguage('main.CPP')).toBe('cpp');
  });

  it('maps .py to python', () => {
    expect(extensionToLanguage('solve.py')).toBe('python');
  });

  it('falls back to plaintext for an unknown extension, including Object prototype names', () => {
    expect([extensionToLanguage('a.rb'), extensionToLanguage('a.constructor')]).toEqual(['plaintext', 'plaintext']);
  });
});
