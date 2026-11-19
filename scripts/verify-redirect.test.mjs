/**
 * scripts/verify-redirect.mjs (editor の dev サーバの `/verify` のリダイレクト先。#829) の検証。
 * 実行: `node --test scripts/verify-redirect.test.mjs` (CI は deploy.yml の check job が scripts/*.test.mjs を回す)。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyRedirectLocation } from './verify-redirect.mjs';

describe('verifyRedirectLocation', () => {
  it('sends /verify/ to the root of the verify dev server', () => {
    assert.equal(verifyRedirectLocation('/verify/', 'localhost:5173', 5174), 'http://localhost:5174/');
  });

  it('sends /verify without a trailing slash to the root of the verify dev server', () => {
    assert.equal(verifyRedirectLocation('/verify', 'localhost:5173', 5174), 'http://localhost:5174/');
  });

  it('keeps the rest of the path after /verify', () => {
    assert.equal(
      verifyRedirectLocation('/verify/src/main.ts', 'localhost:5173', 5174),
      'http://localhost:5174/src/main.ts'
    );
  });

  it('keeps the query string', () => {
    assert.equal(
      verifyRedirectLocation('/verify/?mode=fast&x=1', 'localhost:5173', 5174),
      'http://localhost:5174/?mode=fast&x=1'
    );
    assert.equal(
      verifyRedirectLocation('/verify?mode=fast', 'localhost:5173', 5174),
      'http://localhost:5174/?mode=fast'
    );
  });

  it('follows the host name the request was made to', () => {
    assert.equal(verifyRedirectLocation('/verify/', '127.0.0.1:5183', 5184), 'http://127.0.0.1:5184/');
    assert.equal(verifyRedirectLocation('/verify/', 'devbox.local:5173', 5174), 'http://devbox.local:5174/');
    assert.equal(verifyRedirectLocation('/verify/', '[::1]:5173', 5174), 'http://[::1]:5174/');
    assert.equal(verifyRedirectLocation('/verify/', 'devbox.local', 5174), 'http://devbox.local:5174/');
  });

  it('falls back to localhost when the Host header is missing or malformed', () => {
    assert.equal(verifyRedirectLocation('/verify/', undefined, 5174), 'http://localhost:5174/');
    assert.equal(verifyRedirectLocation('/verify/', '', 5174), 'http://localhost:5174/');
    assert.equal(verifyRedirectLocation('/verify/', 'evil.example/path:1', 5174), 'http://localhost:5174/');
  });

  it('leaves paths that only start with /verify, and other paths, alone', () => {
    for (const url of ['/verifyfoo', '/verify-old/', '/', '/author', '/src/verify/x.ts', undefined]) {
      assert.equal(verifyRedirectLocation(url, 'localhost:5173', 5174), null, String(url));
    }
  });
});
