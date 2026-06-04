#!/usr/bin/env node
/**
 * Setup doctor — clone 後の環境セットアップが正しく完了しているかをチェック。
 *
 * 設計方針:
 *   - 読み取り専用 (何も書き換えない、何も削除しない)
 *   - 不足があれば「何を、どこに、どうやって」直すかを具体的に表示
 *   - exit 0 = ok / 1 = blocking issue / 2 = ランタイムエラー
 *
 * 使い方:
 *   npm run doctor              # 通常チェック
 *   npm run doctor -- --strict  # warning も blocking 扱い
 *   npm run doctor -- --cf      # Cloudflare 側 (wrangler whoami / KV) もチェック
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const CHECK_CF = args.has('--cf');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const ICONS = {
  ok: `${C.green}✓${C.reset}`,
  warn: `${C.yellow}⚠${C.reset}`,
  fail: `${C.red}✗${C.reset}`,
  skip: `${C.dim}⊘${C.reset}`,
  info: `${C.blue}ℹ${C.reset}`,
};

let okCount = 0;
let warnCount = 0;
let failCount = 0;
let skipCount = 0;

function report(status, label, hint) {
  const icon = ICONS[status] ?? ' ';
  console.log(`  ${icon} ${label}`);
  if (hint) {
    hint.split('\n').forEach((line) => console.log(`      ${C.dim}${line}${C.reset}`));
  }
  if (status === 'ok') okCount++;
  else if (status === 'warn') warnCount++;
  else if (status === 'fail') failCount++;
  else if (status === 'skip') skipCount++;
}

function section(title) {
  console.log('');
  console.log(`${C.bold}${C.cyan}━━ ${title}${C.reset}`);
}

function readFileOrNull(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

function envOf(content) {
  const env = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function isPlaceholder(value) {
  if (!value) return true;
  return /^(your_|REPLACE_WITH_|<.*>|placeholder|TODO|xxx)/i.test(value);
}

// ============================================================================
// Section: ツール
// ============================================================================
function checkTooling() {
  section('1. ツール (Node / npm / wrangler)');

  const nodeMajor = Number(process.version.match(/v(\d+)/)?.[1] ?? 0);
  if (nodeMajor >= 24) {
    report('ok', `Node.js ${process.version}`);
  } else {
    report(
      'fail',
      `Node.js ${process.version}: バージョン 24 以上が必要`,
      `fnm install 24 && fnm use 24\n# または nvm install 24`
    );
  }

  try {
    const npmV = execSync('npm --version', { encoding: 'utf-8' }).trim();
    const npmMajor = Number(npmV.split('.')[0]);
    if (npmMajor >= 10) {
      report('ok', `npm ${npmV}`);
    } else {
      report('warn', `npm ${npmV}: 10 以上を推奨`, `npm install -g npm@latest`);
    }
  } catch {
    report('fail', 'npm が見つからない', `Node.js の再インストールを推奨`);
  }

  // wrangler は dev 用に必須ではないが、Workers を触るなら必要
  try {
    const wranglerV = execSync('npx --no-install wrangler --version 2>&1', {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    }).trim();
    report('ok', `wrangler: ${wranglerV.split('\n').pop()}`);
  } catch {
    report(
      'warn',
      'wrangler が npm install 後にも見つからない',
      `npm install を実行してください`
    );
  }
}

// ============================================================================
// Section: ワークスペース
// ============================================================================
function checkWorkspace() {
  section('2. ワークスペース (依存関係)');

  if (existsSync(resolve(REPO_ROOT, 'node_modules'))) {
    report('ok', 'node_modules が存在');
  } else {
    report('fail', 'node_modules がない', `npm install --include=optional`);
    return;
  }

  // 主要パッケージの link 確認
  for (const pkg of ['shared', 'editor', 'verify', 'verify-cli', 'workers']) {
    if (existsSync(resolve(REPO_ROOT, `node_modules/@typedcode/${pkg}`))) {
      report('ok', `@typedcode/${pkg} がリンクされている`);
    } else {
      report('fail', `@typedcode/${pkg} がリンクされていない`, `npm install`);
    }
  }
}

// ============================================================================
// Section: ローカル設定ファイル
// ============================================================================
function checkLocalConfig() {
  section('3. ローカル設定ファイル');

  // ---- editor/.env ----
  const editorEnv = readFileOrNull('packages/editor/.env');
  if (!editorEnv) {
    report(
      'fail',
      'packages/editor/.env がない',
      `cp packages/editor/.env.example packages/editor/.env\n編集して VITE_TURNSTILE_SITE_KEY と VITE_API_URL を設定`
    );
  } else {
    const env = envOf(editorEnv);
    if (isPlaceholder(env.VITE_TURNSTILE_SITE_KEY)) {
      report(
        'warn',
        'packages/editor/.env: VITE_TURNSTILE_SITE_KEY が placeholder',
        `Turnstile 認証を使わないなら空欄 / 使うなら https://dash.cloudflare.com/?to=/:account/turnstile から取得`
      );
    } else {
      report('ok', `packages/editor/.env: VITE_TURNSTILE_SITE_KEY 設定済`);
    }
    if (isPlaceholder(env.VITE_API_URL)) {
      report(
        'warn',
        'packages/editor/.env: VITE_API_URL が placeholder',
        `ローカル開発なら http://localhost:8787 / staging なら staging Worker URL`
      );
    } else {
      report('ok', `packages/editor/.env: VITE_API_URL = ${env.VITE_API_URL}`);
    }
  }

  // ---- workers/.dev.vars ----
  const devVars = readFileOrNull('packages/workers/.dev.vars');
  if (!devVars) {
    report(
      'fail',
      'packages/workers/.dev.vars がない',
      `cp packages/workers/.dev.vars.example packages/workers/.dev.vars\n各キーを設定`
    );
  } else {
    const vars = envOf(devVars);
    const checks = [
      ['TURNSTILE_SECRET_KEY', 'Turnstile widget の Secret Key'],
      ['ATTESTATION_SECRET_KEY', '任意のランダム 32 byte hex (openssl rand -hex 32)'],
      ['CHECKPOINT_SIGNING_KEY_ID', 'gen-checkpoint-key の出力'],
      ['CHECKPOINT_SIGNING_KEY_JWK', 'gen-checkpoint-key の出力 (JWK の 1 行 JSON)'],
    ];
    for (const [key, hint] of checks) {
      if (!vars[key] || isPlaceholder(vars[key])) {
        report(
          'fail',
          `packages/workers/.dev.vars: ${key} 未設定`,
          hint
        );
      } else {
        report('ok', `packages/workers/.dev.vars: ${key} 設定済`);
      }
    }
  }

  // ---- workers/wrangler.toml (ローカル dev KV) ----
  // env.* ブロックは別環境用 (production deploy 等) なので、トップレベルの
  // [[kv_namespaces]] のみを見てローカル dev 用 ID が設定済かを判定する。
  const wranglerToml = readFileOrNull('packages/workers/wrangler.toml');
  if (!wranglerToml) {
    report('fail', 'packages/workers/wrangler.toml がない', `git checkout が壊れているかも`);
  } else {
    // 最初の [env.* のあたりまでを「トップレベル」として切り出す
    const envIdx = wranglerToml.search(/\[env\.[a-z]/);
    const topLevel = envIdx > 0 ? wranglerToml.slice(0, envIdx) : wranglerToml;
    if (topLevel.includes('REPLACE_WITH_')) {
      report(
        'warn',
        'packages/workers/wrangler.toml: ローカル dev KV ID が placeholder',
        `wrangler kv namespace create CHECKPOINT_SESSIONS\nwrangler kv namespace create CHECKPOINT_SESSIONS --preview\n出力された id と preview_id をトップレベル [[kv_namespaces]] の REPLACE_WITH_* に貼り付け\ngit update-index --skip-worktree packages/workers/wrangler.toml`
      );
    } else {
      report('ok', 'packages/workers/wrangler.toml: ローカル dev KV ID 設定済');
    }

    // skip-worktree が当たっているか (placeholder/設定済どちらでも確認すべき)
    try {
      const out = execSync(
        'git ls-files -v packages/workers/wrangler.toml',
        { cwd: REPO_ROOT, encoding: 'utf-8' }
      );
      if (out.startsWith('S ')) {
        report('ok', 'packages/workers/wrangler.toml: skip-worktree 適用済 (commit から保護)');
      } else {
        report(
          'warn',
          'packages/workers/wrangler.toml: skip-worktree が未適用',
          `dev KV ID を設定したら次を実行:\ngit update-index --skip-worktree packages/workers/wrangler.toml`
        );
      }
    } catch {
      report('skip', 'packages/workers/wrangler.toml: skip-worktree 確認できず (git 配下外?)');
    }
  }
}

// ============================================================================
// Section: 署名鍵
// ============================================================================
function checkSigningKey() {
  section('4. 署名鍵 (signed checkpoints)');

  const localKeys = readFileOrNull('packages/shared/src/checkpointKeys/localKeys.ts');
  if (!localKeys) {
    report(
      'fail',
      'packages/shared/src/checkpointKeys/localKeys.ts がない',
      `cp packages/shared/src/checkpointKeys/localKeys.ts.example packages/shared/src/checkpointKeys/localKeys.ts`
    );
    return;
  }

  // skip-worktree 確認
  try {
    const out = execSync(
      'git ls-files -v packages/shared/src/checkpointKeys/localKeys.ts',
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    if (out.startsWith('S ')) {
      report('ok', 'localKeys.ts: skip-worktree 適用済 (commit から保護)');
    } else {
      report(
        'warn',
        'localKeys.ts: skip-worktree が未適用',
        `git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts`
      );
    }
  } catch {
    report('skip', 'localKeys.ts: skip-worktree 確認できず');
  }

  // 中身に dev 鍵 entry があるか
  const hasEntry = /keyId\s*:\s*['"]tcp-/.test(localKeys);
  const devVars = readFileOrNull('packages/workers/.dev.vars');
  const devKeyId = devVars ? envOf(devVars).CHECKPOINT_SIGNING_KEY_ID : '';

  if (!hasEntry && devKeyId && !isPlaceholder(devKeyId)) {
    // .dev.vars に keyId はあるが localKeys.ts に entry がない場合、registry に
    // 既にあるか確認 (本番鍵を流用しているかもしれない)
    const registry = readFileOrNull('packages/shared/src/checkpointKeys/registry.ts');
    if (registry && registry.includes(devKeyId)) {
      report(
        'warn',
        `localKeys.ts に dev 鍵 entry なし。.dev.vars の keyId (${devKeyId}) は registry.ts に存在`,
        `本番/staging 鍵をローカルにも流用している状態。安全ではないので別鍵を生成推奨\nnpm run gen-checkpoint-key -w @typedcode/workers`
      );
    } else {
      report(
        'fail',
        `.dev.vars に keyId (${devKeyId}) があるが localKeys.ts にも registry.ts にも未登録`,
        `localKeys.ts に対応する公開鍵 entry を append してください`
      );
    }
  } else if (hasEntry) {
    report('ok', 'localKeys.ts に dev 鍵 entry あり');
  } else {
    report(
      'warn',
      'localKeys.ts に dev 鍵 entry なし、.dev.vars にも keyId なし',
      `npm run gen-checkpoint-key -w @typedcode/workers\n出力された公開鍵を localKeys.ts に append、KEY_ID と KEY_JWK を .dev.vars に貼り付け`
    );
  }
}

// ============================================================================
// Section: Cloudflare (任意)
// ============================================================================
function checkCloudflare() {
  section('5. Cloudflare 側 (--cf 指定時のみ)');

  if (!CHECK_CF) {
    report('skip', '--cf を付けると Cloudflare 側の検証も実施します');
    return;
  }

  // wrangler whoami
  const whoami = spawnSync('npx', ['--no-install', 'wrangler', 'whoami'], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  if (whoami.status !== 0) {
    report(
      'fail',
      'wrangler whoami 失敗',
      `wrangler login\n# または CLOUDFLARE_API_TOKEN を環境変数で設定`
    );
    return;
  }
  const account = whoami.stdout.match(/Account ID:\s*(\w+)/i);
  if (account) {
    report('ok', `wrangler 認証済 (Account ID: ${account[1].slice(0, 8)}...)`);
  } else {
    report('ok', 'wrangler 認証済');
  }

  // KV 一覧と wrangler.toml の ID 突合
  const kvList = spawnSync('npx', ['--no-install', 'wrangler', 'kv', 'namespace', 'list'], {
    encoding: 'utf-8',
    cwd: resolve(REPO_ROOT, 'packages/workers'),
  });
  if (kvList.status === 0) {
    try {
      const namespaces = JSON.parse(kvList.stdout);
      const wranglerToml = readFileOrNull('packages/workers/wrangler.toml') ?? '';
      const idsInToml = [...wranglerToml.matchAll(/id\s*=\s*"([0-9a-f]{32})"/gi)].map(
        (m) => m[1]
      );
      const idsOnCf = new Set(namespaces.map((n) => n.id));
      for (const id of idsInToml) {
        if (idsOnCf.has(id)) {
          report('ok', `KV id ${id.slice(0, 10)}... は CF 上に存在`);
        } else {
          report(
            'fail',
            `KV id ${id.slice(0, 10)}... が CF 上に存在しない`,
            `wrangler kv namespace list で実際の ID を確認、wrangler.toml を更新`
          );
        }
      }
    } catch {
      report('skip', 'KV 一覧の JSON 解析失敗');
    }
  } else {
    report('skip', 'wrangler kv namespace list が失敗 (権限不足の可能性)');
  }
}

// ============================================================================
// 実行
// ============================================================================
console.log(
  `${C.bold}TypedCode setup doctor${C.reset} ${C.dim}(${REPO_ROOT})${C.reset}`
);
if (STRICT) console.log(`${C.dim}strict mode: warnings も blocking 扱い${C.reset}`);

checkTooling();
checkWorkspace();
checkLocalConfig();
checkSigningKey();
checkCloudflare();

// ----- 結果サマリ -----
console.log('');
console.log(`${C.bold}━━ 結果${C.reset}`);
console.log(
  `  ${ICONS.ok} ok ${okCount}  ${ICONS.warn} warn ${warnCount}  ${ICONS.fail} fail ${failCount}  ${ICONS.skip} skip ${skipCount}`
);

const blocking = failCount + (STRICT ? warnCount : 0);
if (blocking > 0) {
  console.log('');
  console.log(`${C.red}${C.bold}セットアップが完了していません。${C.reset}`);
  console.log(`上記の指示に従って ${blocking} 件の問題を解消してください。`);
  console.log(`完了後、再度 ${C.cyan}npm run doctor${C.reset} を実行。`);
  process.exit(1);
}

console.log('');
if (warnCount > 0) {
  console.log(
    `${C.yellow}${C.bold}セットアップは動作可能ですが ${warnCount} 件の注意点があります。${C.reset}`
  );
  console.log(`必要に応じて対応してください (動作に必須ではありません)。`);
} else {
  console.log(`${C.green}${C.bold}すべてのチェックを通過しました。${C.reset} 開発開始可能です:`);
  console.log(`  ${C.cyan}npm run dev${C.reset}`);
}
process.exit(0);
