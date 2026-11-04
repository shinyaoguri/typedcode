/**
 * scripts/server-identity.mjs (e2e が使う dev サーバの作業ツリーの照合。#552) の検証。
 *
 * e2e パッケージは vitest を持たないので node:test で書く。実行: `node --test packages/e2e/scripts/server-identity.test.mjs`
 * (CI は deploy.yml の check job)。ネットワークは fetch を差し替え、作業ツリーの一覧は文字列で渡す。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKTREE_ID_HEADER, worktreeIdOf } from '../../../scripts/worktree-id.mjs';
import { checkServerIdentities, observeServer, parseWorktreePaths, peersOf } from './server-identity.mjs';

const ROOT = '/repos/typedcode/.claude/worktrees/mine';
const PEER = '/repos/typedcode/.claude/worktrees/other-session';
const MINE = worktreeIdOf(ROOT);
const OTHER = worktreeIdOf(PEER);
const PEERS = peersOf([ROOT, PEER, '/repos/typedcode']);

/** editor をポート 5310 で 1 台だけ照合する。 */
function checkEditor(observation, peers = PEERS) {
  return checkServerIdentities({
    root: ROOT,
    expectedId: MINE,
    servers: [{ name: 'editor', port: 5310, envVar: 'E2E_EDITOR_PORT', observation }],
    peers,
  });
}

/** workers をポート 8810 で 1 台だけ照合する (test:build の照合と同じ形)。 */
function checkWorkers(observation, options = {}) {
  return checkServerIdentities({
    root: ROOT,
    expectedId: MINE,
    servers: [{ name: 'workers', port: 8810, envVar: 'E2E_WORKERS_PORT', observation }],
    peers: PEERS,
    ...options,
  });
}

describe('checkServerIdentities', () => {
  it('passes when every server reports this worktree id', () => {
    const result = checkServerIdentities({
      root: ROOT,
      expectedId: MINE,
      servers: [
        { name: 'editor', port: 5310, envVar: 'E2E_EDITOR_PORT', observation: { kind: 'id', id: MINE } },
        { name: 'verify', port: 5311, envVar: 'E2E_VERIFY_PORT', observation: { kind: 'id', id: MINE } },
        { name: 'workers', port: 8810, envVar: 'E2E_WORKERS_PORT', observation: { kind: 'id', id: MINE } },
      ],
      peers: PEERS,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('fails on another worktree id with the port, "別の作業ツリー" and the env var to change', () => {
    const result = checkEditor({ kind: 'id', id: OTHER });
    assert.equal(result.ok, false);
    assert.match(result.message, /ポート 5310 \(editor\) は別の作業ツリーのサーバが使用中/);
    assert.match(result.message, /E2E_EDITOR_PORT/);
  });

  it('names the other worktree path when its id is in the worktree list', () => {
    const result = checkEditor({ kind: 'id', id: OTHER });
    assert.match(result.message, new RegExp(`相手: ${PEER}`));
  });

  it('falls back to the bare id when the other worktree is not in the list', () => {
    const result = checkEditor({ kind: 'id', id: 'ffffffffffff' }, new Map());
    assert.equal(result.ok, false);
    assert.match(result.message, /相手の識別子: ffffffffffff/);
  });

  it('fails on a server that does not report any worktree id', () => {
    const result = checkEditor({ kind: 'no-id' });
    assert.equal(result.ok, false);
    assert.match(result.message, /ポート 5310 \(editor\) は作業ツリーを名乗らないサーバが使用中/);
  });

  it('fails on a server that does not respond', () => {
    const result = checkEditor({ kind: 'no-response', reason: 'fetch failed' });
    assert.equal(result.ok, false);
    assert.match(result.message, /ポート 5310 \(editor\) は応答しません \(fetch failed\)/);
  });

  it('lists only the env vars of the mismatching servers', () => {
    const result = checkServerIdentities({
      root: ROOT,
      expectedId: MINE,
      servers: [
        { name: 'editor', port: 5310, envVar: 'E2E_EDITOR_PORT', observation: { kind: 'id', id: MINE } },
        { name: 'workers', port: 8810, envVar: 'E2E_WORKERS_PORT', observation: { kind: 'no-id' } },
      ],
      peers: PEERS,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /E2E_EDITOR_PORT/);
    assert.match(result.message, /E2E_WORKERS_PORT/);
  });

  it('fails on a lone workers of another worktree and points only at E2E_WORKERS_PORT (test:build checks workers alone)', () => {
    const result = checkWorkers({ kind: 'id', id: OTHER });
    assert.equal(result.ok, false);
    assert.match(result.message, /ポート 8810 \(workers\) は別の作業ツリーのサーバが使用中/);
    assert.match(result.message, /E2E_WORKERS_PORT=<空きポート>/);
    assert.doesNotMatch(result.message, /E2E_EDITOR_PORT|E2E_VERIFY_PORT/);
  });

  it('suggests the given rerun command and falls back to the dev e2e command without one', () => {
    const custom = checkWorkers({ kind: 'id', id: OTHER }, { rerun: 'npm run test:build -w @typedcode/e2e' });
    assert.match(custom.message, /E2E_WORKERS_PORT=<空きポート> npm run test:build -w @typedcode\/e2e\)/);
    const fallback = checkWorkers({ kind: 'id', id: OTHER });
    assert.match(fallback.message, /E2E_WORKERS_PORT=<空きポート> npm run test -w @typedcode\/e2e\)/);
  });
});

describe('observeServer', () => {
  /** 与えた応答を返す fetch。呼ばれた URL を記録する。 */
  function fakeFetch(response) {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      if (response instanceof Error) throw response;
      return response;
    };
    return { impl, calls };
  }

  it('reads the id from the response header of GET / for editor / verify', async () => {
    const { impl, calls } = fakeFetch(new Response('<html>', { headers: { [WORKTREE_ID_HEADER]: MINE } }));
    assert.deepEqual(await observeServer({ port: 5310, probe: 'header' }, { fetchImpl: impl }), {
      kind: 'id',
      id: MINE,
    });
    assert.deepEqual(calls, ['http://localhost:5310/']);
  });

  it('reads the id from the worktree field of GET /health for workers', async () => {
    const { impl, calls } = fakeFetch(Response.json({ status: 'ok', environment: 'development', worktree: MINE }));
    assert.deepEqual(await observeServer({ port: 8810, probe: 'health' }, { fetchImpl: impl }), {
      kind: 'id',
      id: MINE,
    });
    assert.deepEqual(calls, ['http://localhost:8810/health']);
  });

  it('reports no-id for a /health without worktree and for a non-JSON body', async () => {
    const plain = fakeFetch(Response.json({ status: 'ok', environment: 'development' }));
    assert.deepEqual(await observeServer({ port: 8810, probe: 'health' }, { fetchImpl: plain.impl }), {
      kind: 'no-id',
    });
    const html = fakeFetch(new Response('<html>'));
    assert.deepEqual(await observeServer({ port: 8810, probe: 'health' }, { fetchImpl: html.impl }), { kind: 'no-id' });
  });

  it('reports no-response with the reason when the request fails', async () => {
    const { impl } = fakeFetch(new Error('connect ECONNREFUSED'));
    assert.deepEqual(await observeServer({ port: 5310, probe: 'header' }, { fetchImpl: impl }), {
      kind: 'no-response',
      reason: 'connect ECONNREFUSED',
    });
  });
});

describe('parseWorktreePaths', () => {
  it('extracts every worktree path from git worktree list --porcelain', () => {
    const porcelain = [
      'worktree /repos/typedcode',
      'HEAD 0123',
      'branch refs/heads/main',
      '',
      `worktree ${PEER}`,
      'HEAD 4567',
      'detached',
      '',
    ].join('\n');
    assert.deepEqual(parseWorktreePaths(porcelain), ['/repos/typedcode', PEER]);
  });
});
