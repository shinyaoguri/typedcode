import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PYODIDE_CDN_URL, PYPI_ORIGINS } from '../../executors/python/pythonRunnerProtocol.js';
import {
  apiOriginOf,
  CROSS_ORIGIN_ISOLATION_HEADERS,
  contentSecurityPolicyDirectives,
  deliveryHeaders,
  parseCsp,
  parseHeadersFile,
  renderHeadersFile,
  serializeCsp,
} from '../deliveryHeaders.js';

/**
 * editor の配信ヘッダ (#411)。生成した `_headers` と `vite preview` が同じ値を返すこと、CSP の下で実際に動くことは
 * e2e の `production-build.spec.ts` が見る。ここは CSP の中身 (directive と許可先) を固定する。
 */

const API_URL = 'https://api.example.test/base/path';

function csp(apiUrl: string | undefined): Map<string, string[]> {
  return parseCsp(deliveryHeaders(apiUrl)['Content-Security-Policy']);
}

/** 実際の HTML が読む外部の配信元 (`<link href>` / `<script src>` の http(s)) */
function externalOriginsOf(relativeHtmlPath: string): string[] {
  const html = readFileSync(fileURLToPath(new URL(relativeHtmlPath, import.meta.url)), 'utf8');
  const origins = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="(https?:\/\/[^"]+)"/g)].map(
    (m) => new URL(String(m[1])).origin
  );
  return [...new Set(origins)];
}

describe('deliveryHeaders', () => {
  it('locks the baseline directives the issue requires (default-src, object-src, base-uri, frame-ancestors)', () => {
    const p = csp(API_URL);
    expect(p.get('default-src')).toEqual(["'self'"]);
    expect(p.get('object-src')).toEqual(["'none'"]);
    expect(p.get('base-uri')).toEqual(["'self'"]);
    expect(p.get('frame-ancestors')).toEqual(["'self'"]);
  });

  it("allows WebAssembly compilation with 'wasm-unsafe-eval' for Wasmer and Pyodide", () => {
    expect(csp(API_URL).get('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it("keeps 'unsafe-inline' and 'unsafe-eval' in script-src because srcdoc runners and the Wasmer worker inherit this policy (#897 removes them)", () => {
    const scriptSrc = csp(API_URL).get('script-src');
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it('allows only listed hosts and never a wildcard or a bare scheme for network sources', () => {
    const tooBroad = /^(\*|https?:|wss?:|https?:\/\/\*.*)$/;
    for (const [directive, sources] of csp(API_URL)) {
      for (const source of sources) {
        expect(tooBroad.test(source), `${directive} ${source}`).toBe(false);
      }
    }
  });

  it('pins the full set of external hosts to the ones the app itself uses', () => {
    const hosts = new Set<string>();
    for (const sources of csp(API_URL).values()) {
      for (const source of sources) {
        if (/^https?:\/\//.test(source)) hosts.add(source);
      }
    }
    expect([...hosts].sort()).toEqual(
      [
        'https://api.example.test',
        'https://assets.typedcode.dev',
        'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/',
        'https://cdnjs.cloudflare.com',
        'https://challenges.cloudflare.com',
        'https://cloudflareinsights.com',
        'https://files.pythonhosted.org',
        'https://pypi.org',
        'https://static.cloudflareinsights.com',
      ].sort()
    );
  });

  it('puts the origin of VITE_API_URL (without its path) in connect-src', () => {
    expect(csp('https://api.example.test/base/path').get('connect-src')).toContain('https://api.example.test');
    expect(csp('http://localhost:8787').get('connect-src')).toContain('http://localhost:8787');
  });

  it('leaves the API out of connect-src when VITE_API_URL is empty', () => {
    for (const empty of [undefined, '', '  ']) {
      expect(
        csp(empty)
          .get('connect-src')
          ?.some((s) => s.includes('api.example.test'))
      ).toBe(false);
      expect(apiOriginOf(empty)).toBeNull();
    }
  });

  it('stops the build on a VITE_API_URL that is not an http(s) URL', () => {
    expect(() => deliveryHeaders('not a url')).toThrow(/VITE_API_URL/);
    expect(() => deliveryHeaders('ftp://api.example.test')).toThrow(/VITE_API_URL/);
  });

  it('does not block what the inherited srcdoc runners load (Pyodide, PyPI, blob workers)', () => {
    const p = csp(API_URL);
    expect(p.get('script-src')).toEqual(expect.arrayContaining([PYODIDE_CDN_URL, 'blob:']));
    expect(p.get('connect-src')).toEqual(expect.arrayContaining([PYODIDE_CDN_URL, ...PYPI_ORIGINS]));
    expect(p.get('worker-src')).toContain('blob:');
  });

  it('allows every external stylesheet and script the editor, author and verify pages link to', () => {
    const p = csp(API_URL);
    const allowed = new Set([...(p.get('style-src') ?? []), ...(p.get('script-src') ?? [])]);
    const linked = [
      ...externalOriginsOf('../../../index.html'),
      ...externalOriginsOf('../../../author.html'),
      ...externalOriginsOf('../../../../verify/index.html'),
    ];
    expect(linked.length).toBeGreaterThan(0);
    for (const origin of linked) expect(allowed.has(origin), origin).toBe(true);
  });

  it('keeps cross-origin isolation (COOP same-origin, COEP credentialless) next to the CSP', () => {
    const headers = deliveryHeaders(API_URL);
    expect(headers).toMatchObject(CROSS_ORIGIN_ISOLATION_HEADERS);
    expect(CROSS_ORIGIN_ISOLATION_HEADERS).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
  });
});

describe('_headers file', () => {
  it('renders every header under /* and reads back to the same values', () => {
    const headers = deliveryHeaders(API_URL);
    const text = renderHeadersFile(headers);
    expect(text.startsWith('/*\n')).toBe(true);
    expect(parseHeadersFile(text)).toEqual(new Map([['/*', headers]]));
  });

  it('rejects a duplicated header under one path, which Pages would send twice', () => {
    expect(() => parseHeadersFile('/*\n  A: 1\n  A: 2\n')).toThrow(/duplicate/);
  });

  it('serializes directives in order with sources separated by spaces', () => {
    expect(
      serializeCsp([
        ['default-src', ["'self'"]],
        ['img-src', ["'self'", 'data:']],
      ])
    ).toBe("default-src 'self'; img-src 'self' data:");
    expect(contentSecurityPolicyDirectives(API_URL)[0]).toEqual(['default-src', ["'self'"]]);
  });
});
