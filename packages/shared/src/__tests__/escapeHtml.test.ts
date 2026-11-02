import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../utils/escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes the five HTML special characters so user input cannot inject markup', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#039;y&#039;&lt;/script&gt;'
    );
  });

  it('leaves text without special characters unchanged', () => {
    expect(escapeHtml('plain text 日本語')).toBe('plain text 日本語');
  });
});
