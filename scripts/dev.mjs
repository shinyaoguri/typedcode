#!/usr/bin/env node
/**
 * dev launcher — ポートセット単位で空きを探して dev サーバ群を起動する (Issue #196)。
 *
 * 背景:
 *   root の `npm run dev` は editor(5173) / verify(5174) / workers(8787) を
 *   concurrently で同時起動する。別 worktree や別プロジェクトの dev サーバが
 *   これらを占有していると vite は黙って +1 ずつポートをずらし、editor の
 *   `/verify` プロキシ (5174 固定) や `VITE_API_URL` (8787 固定) の配線が壊れたり
 *   古いプロセスへつながる。
 *
 * 設計方針:
 *   - **ポートセット単位で切替**: 3 ポートを個別にずらすと配線が追えなくなるため、
 *     3 つすべて空いているセットだけを採用する。1 つでも埋まっていればセットごと
 *     +STEP して再試行する (5173/5174/8787 → 5183/5184/8797 → …)。
 *   - **配線を追従させる**: 割り当てたポートを環境変数 (EDITOR_PORT / VERIFY_PORT /
 *     WORKERS_PORT) で各 dev サーバへ渡す。vite.config が server.port・proxy target・
 *     VITE_API_URL をそのポートへ向け、workers は --port で wrangler dev を固定する。
 *   - **空きチェックは IPv4/IPv6 両方**: vite は `::1`、workerd は両スタックで listen
 *     するため、`127.0.0.1` と `::1` の双方が空いて初めて「空き」と判定する。
 *   - 読み取り専用の探索 (何も書き換えない)。個別起動 (`npm run dev:editor` 等) は
 *     EDITOR_PORT なしで従来どおり動き、vite のポートフォールバックに任せる。
 */

import net from 'node:net';
import concurrently from 'concurrently';

// 既定ポートセット。1 つでも埋まっていたらセットごと STEP ずつずらして再試行する。
const BASE_PORTS = { editor: 5173, verify: 5174, workers: 8787 };
const STEP = 10;
const MAX_SETS = 10;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/**
 * 指定ホストで port を listen 可能か (= 空いているか) を判定する。
 * listen できれば空き。EADDRINUSE / EACCES は使用中。それ以外のエラー
 * (EADDRNOTAVAIL 等 = そのホストで bind できない環境。IPv6 無効など) は
 * 「そのスタックには誰もいない」とみなして空き扱いにする。
 */
function isFreeOnHost(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(!(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // exclusive: true で SO_REUSEADDR による相乗り listen を防ぎ、既存プロセスとの
    // 衝突を確実に EADDRINUSE として検出する。
    server.listen({ port, host, exclusive: true });
  });
}

/** IPv4 (127.0.0.1) と IPv6 (::1) の両方で空いているときだけ true */
async function isPortFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (!(await isFreeOnHost(port, host))) return false;
  }
  return true;
}

/** セット内の全ポートが空いているか */
async function isSetFree(ports) {
  for (const port of Object.values(ports)) {
    if (!(await isPortFree(port))) return false;
  }
  return true;
}

/** 空いているポートセットを探す。見つからなければ null */
async function findFreeSet() {
  for (let i = 0; i < MAX_SETS; i++) {
    const offset = i * STEP;
    const ports = {
      editor: BASE_PORTS.editor + offset,
      verify: BASE_PORTS.verify + offset,
      workers: BASE_PORTS.workers + offset,
    };
    if (await isSetFree(ports)) return { ports, offset };
  }
  return null;
}

const found = await findFreeSet();
if (!found) {
  const lastEditor = BASE_PORTS.editor + (MAX_SETS - 1) * STEP;
  console.error(
    `${C.bold}空きポートセットが見つかりませんでした${C.reset} (${MAX_SETS} セット試行)。\n` +
      `占有中のプロセスを調べるには:\n` +
      `  ${C.cyan}lsof -nP -iTCP:${BASE_PORTS.editor}-${lastEditor} -sTCP:LISTEN${C.reset}\n` +
      `不要な dev サーバを停止してから再実行してください。`
  );
  process.exit(1);
}

const { ports, offset } = found;

// ---- バナー ----
console.log('');
if (offset > 0) {
  console.log(
    `${C.yellow}⚠ 既定ポート (${BASE_PORTS.editor}/${BASE_PORTS.verify}/${BASE_PORTS.workers}) の一部が使用中のため ` +
      `+${offset} で起動します${C.reset}`
  );
}
console.log(`${C.bold}dev servers${C.reset} ${C.dim}(ポートセット +${offset})${C.reset}`);
console.log(`  ${C.cyan}editor ${C.reset} http://localhost:${ports.editor}/`);
console.log(`  ${C.cyan}verify ${C.reset} http://localhost:${ports.verify}/`);
console.log(`  ${C.cyan}workers${C.reset} http://localhost:${ports.workers}/`);
console.log('');

// ---- 起動 ----
// 割り当てポートを環境変数で各 dev サーバへ渡す。editor/verify の vite.config は
// EDITOR_PORT/VERIFY_PORT で server.port と proxy/VITE_API_URL を追従させ、workers は
// --port フラグで wrangler dev のポートを固定する (env の WORKERS_PORT は editor 側の
// VITE_API_URL 追従にも使う)。
const env = {
  ...process.env,
  EDITOR_PORT: String(ports.editor),
  VERIFY_PORT: String(ports.verify),
  WORKERS_PORT: String(ports.workers),
};

const { result } = concurrently(
  [
    { command: 'npm run dev -w @typedcode/editor', name: 'editor', env, prefixColor: 'cyan' },
    { command: 'npm run dev -w @typedcode/verify', name: 'verify', env, prefixColor: 'magenta' },
    {
      command: `npm run dev -w @typedcode/workers -- --port ${ports.workers}`,
      name: 'workers',
      env,
      prefixColor: 'yellow',
    },
  ],
  { prefix: 'name', killOthersOn: ['failure'] }
);

result.then(
  () => process.exit(0),
  () => process.exit(1)
);
