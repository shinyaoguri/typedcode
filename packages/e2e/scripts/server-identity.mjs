/**
 * e2e が使う dev サーバが「この作業ツリーのもの」かを照合する (#552)。
 *
 * Playwright の webServer は `port:` の TCP 応答しか見ないので、reuseExistingServer (ローカルのみ) は
 * 同じポートを握っている別の worktree の editor / workers / verify にも黙ってつながる。そのまま走ると、
 * 向こうの worktree の鍵で署名された証明をこちらの localKeys.ts で検証して `Unknown keyId` で落ちる
 * など、原因から離れた所で失敗する。
 *
 * 各 dev サーバは作業ツリーの識別子 (scripts/worktree-id.mjs) を名乗る:
 *   - editor / verify: `GET /` の応答ヘッダ `X-TypedCode-Worktree` (各 vite.config.ts の server.headers)
 *   - workers: `GET /health` の JSON の `worktree` (`wrangler dev --var DEV_WORKTREE_ID:<id>`)
 * global-setup.ts がそれを読み (observeServer)、ここの checkServerIdentities で照合して、合わなければ
 * テストを 1 本も走らせずに落とす。setup-env.mjs と同じく、判定は副作用の無い関数に置き、
 * ネットワークと git の呼び出しは引数で差し替えられるようにする。
 */
import { WORKTREE_ID_HEADER, worktreeIdOf } from '../../../scripts/worktree-id.mjs';

/** 1 回の問い合わせの上限。webServer の準備が済んだ後に呼ぶので、応答しないのは異常。 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * @typedef {'header' | 'health'} ProbeKind
 *   `header` は `GET /` の応答ヘッダ (editor / verify)、`health` は `GET /health` の JSON (workers)。
 * @typedef {{ kind: 'id', id: string } | { kind: 'no-id' } | { kind: 'no-response', reason: string }} Observation
 * @typedef {{ name: string, port: number, envVar: string, observation: Observation }} ServerObservation
 */

/**
 * サーバに問い合わせて、名乗った識別子を返す。
 * @param {{ port: number, probe: ProbeKind }} server
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<Observation>}
 */
export async function observeServer({ port, probe }, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = `http://localhost:${port}${probe === 'health' ? '/health' : '/'}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { kind: 'no-response', reason: err instanceof Error ? err.message : String(err) };
  }
  let id = null;
  if (probe === 'header') {
    id = res.headers.get(WORKTREE_ID_HEADER);
    await res.body?.cancel();
  } else {
    try {
      const body = await res.json();
      id = typeof body?.worktree === 'string' ? body.worktree : null;
    } catch {
      // JSON でない応答 = workers の /health ではない
    }
  }
  return id ? { kind: 'id', id } : { kind: 'no-id' };
}

/**
 * `git worktree list --porcelain` の出力から各作業ツリーのパスを取り出す。
 * @param {string} porcelain
 * @returns {string[]}
 */
export function parseWorktreePaths(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * 作業ツリーのパスを、識別子 → パスの表にする (相手の識別子からパスを引くため)。
 * @param {string[]} paths
 * @param {(path: string) => string} [idOf]
 * @returns {Map<string, string>}
 */
export function peersOf(paths, idOf = worktreeIdOf) {
  return new Map(paths.map((path) => [idOf(path), path]));
}

/**
 * 1 台分の問題を文にする。この作業ツリーのサーバなら null。
 * @param {ServerObservation} server
 * @param {string} expectedId
 * @param {Map<string, string>} peers
 * @returns {string | null}
 */
function describeProblem({ name, port, observation }, expectedId, peers) {
  const where = `ポート ${port} (${name})`;
  switch (observation.kind) {
    case 'id': {
      if (observation.id === expectedId) return null;
      const peer = peers.get(observation.id);
      const who = peer
        ? `相手: ${peer}`
        : `相手の識別子: ${observation.id}。git worktree list からはパスを引けませんでした`;
      return `${where} は別の作業ツリーのサーバが使用中です (${who})`;
    }
    case 'no-id':
      return (
        `${where} は作業ツリーを名乗らないサーバが使用中です。別の作業ツリー (この照合が入る前の版) か、` +
        'TypedCode 以外のプロセスです。この作業ツリーで照合が入る前に起こしたサーバなら、止めて起こし直してください'
      );
    case 'no-response':
      return `${where} は応答しません (${observation.reason})。別のプロセスが使用中の可能性があります`;
    default:
      return `${where} の状態を判定できません`;
  }
}

/**
 * 全サーバがこの作業ツリーのものかを照合する。
 * @param {{ root: string, expectedId: string, servers: ServerObservation[], peers: Map<string, string> }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkServerIdentities({ root, expectedId, servers, peers }) {
  const problems = [];
  const envVars = [];
  for (const server of servers) {
    const problem = describeProblem(server, expectedId, peers);
    if (problem === null) continue;
    problems.push(`  - ${problem}`);
    envVars.push(server.envVar);
  }
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message: [
      `[e2e] dev サーバがこの作業ツリーのものではないので、テストを走らせずに止めます (#552)。`,
      `  この作業ツリー: ${root} (識別子: ${expectedId})`,
      ...problems,
      `  直し方: そのサーバを止めるか、${envVars.join(' / ')} で空きポートを指定してください` +
        ` (例: ${envVars.map((v) => `${v}=<空きポート>`).join(' ')} npm run test -w @typedcode/e2e)`,
    ].join('\n'),
  };
}
