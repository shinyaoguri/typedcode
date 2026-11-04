/**
 * sandbox runner の srcdoc のテスト (#290)。
 * CSP と、埋め込んだ文字列で inline script が閉じないことを確かめる。
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { buildRunnerSrcdoc, SANDBOX_IFRAME_TOKENS, SANDBOX_RUNNER_CSP, scriptLiteral } from '../runnerDocument.js';

describe('buildRunnerSrcdoc', () => {
  it('declares a CSP that blocks network access and allows only inline scripts, eval and blob workers', () => {
    const doc = buildRunnerSrcdoc('r1', 'void 0');
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_RUNNER_CSP}">`);
    expect(SANDBOX_RUNNER_CSP).toContain("default-src 'none'");
    expect(SANDBOX_RUNNER_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_RUNNER_CSP).toContain('worker-src blob:');
  });

  it('never grants allow-same-origin to the runner iframe', () => {
    expect(SANDBOX_IFRAME_TOKENS.split(/\s+/)).toEqual(['allow-scripts']);
  });

  it('keeps a single inline script even when the embedded source contains a closing script tag', () => {
    const doc = buildRunnerSrcdoc('r1', 'console.log("</script><script>alert(1)</script>")');
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
    expect(doc.match(/<script>/g)).toHaveLength(1);
  });
});

describe('scriptLiteral', () => {
  it('round-trips the value through a JavaScript string literal', () => {
    const value = `</script>  "'\\\n`;
    expect(vm.runInNewContext(scriptLiteral(value))).toBe(value);
    expect(scriptLiteral(value)).not.toContain('<');
  });
});
