/**
 * テストより前に、Playwright が起こした / 再利用した dev サーバがこの作業ツリーのものかを照合する (#552)。
 *
 * Playwright は webServer の準備 (起動か、ポートが応答すれば再利用) を globalSetup より先に済ませるので、
 * ここで throw すればテストは 1 本も走らない。判定は scripts/server-identity.mjs の純関数が持ち、
 * ここは問い合わせと `git worktree list` の呼び出しだけをする。CI (reuseExistingServer: false) でも走らせ、
 * 名乗りの配線 (vite.config の headers・workers の --var) が壊れたら CI で気付けるようにする。
 */
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, worktreeId } from '../../scripts/worktree-id.mjs';
import { E2E_PORTS } from './ports.js';
import { checkServerIdentities, observeServer, parseWorktreePaths, peersOf } from './scripts/server-identity.mjs';

const SERVERS = [
  { name: 'editor', envVar: 'E2E_EDITOR_PORT', port: E2E_PORTS.editor, probe: 'header' },
  { name: 'verify', envVar: 'E2E_VERIFY_PORT', port: E2E_PORTS.verify, probe: 'header' },
  { name: 'workers', envVar: 'E2E_WORKERS_PORT', port: E2E_PORTS.workers, probe: 'health' },
] as const;

/** 相手の識別子からパスを引くための表。git が使えなければ空 (メッセージは識別子だけになる)。 */
function listPeers(): Map<string, string> {
  try {
    const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return peersOf(parseWorktreePaths(porcelain));
  } catch {
    return new Map();
  }
}

export default async function globalSetup(): Promise<void> {
  const servers = await Promise.all(
    SERVERS.map(async (server) => ({ ...server, observation: await observeServer(server) }))
  );
  const result = checkServerIdentities({ root: REPO_ROOT, expectedId: worktreeId(), servers, peers: listPeers() });
  if (!result.ok) throw new Error(result.message);
}
