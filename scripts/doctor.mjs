#!/usr/bin/env node
/**
 * Setup doctor — clone 後の環境セットアップが正しく完了しているかをチェック。
 *
 * 設計方針:
 *   - 読み取り専用 (何も書き換えない、何も削除しない)
 *   - **新規ユーザー前提**: wrangler / gh / openssl が無くても doctor 本体は動く
 *   - 不足があれば「何を、どこで、どうやって」直すかを具体的に表示
 *   - 段階的: ツール無 → npm install → wrangler → Cloudflare 登録 → 設定ファイル → 鍵
 *   - exit 0 = ok / 1 = blocking issue / 2 = ランタイムエラー
 *
 * 使い方:
 *   npm run doctor              # 通常チェック (Node のみ必須)
 *   npm run doctor -- --strict  # warning も blocking 扱い
 *   npm run doctor -- --cf      # Cloudflare 側 (KV 突合) もチェック
 */

import { existsSync, readFileSync } from 'node:fs';
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

/** コマンドが存在するか (PATH 上で見つかるか) */
function commandExists(cmd) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf-8',
  });
  return result.status === 0;
}

/** 安全に execSync。失敗時は null を返す */
function tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

// 状態 (後のセクションで前のセクションの結果を参照)
const state = {
  hasNodeModules: false,
  hasWrangler: false,
  isCloudflareAuthed: false,
};

// ============================================================================
// Section 1: 基礎ツール (Node / npm / git のみ必須)
// ============================================================================
function checkBasicTooling() {
  section('1. 基礎ツール (Node / npm / git)');

  // Node.js
  const nodeMajor = Number(process.version.match(/v(\d+)/)?.[1] ?? 0);
  if (nodeMajor >= 24) {
    report('ok', `Node.js ${process.version}`);
  } else {
    report(
      'fail',
      `Node.js ${process.version}: バージョン 24 以上が必要`,
      `インストール方法:\n  macOS:    brew install node (または fnm/nvm)\n  Linux:    nvm install 24\n  Windows:  https://nodejs.org/ から LTS インストーラ`
    );
  }

  // npm
  const npmV = tryExec('npm --version');
  if (npmV) {
    const npmMajor = Number(npmV.split('.')[0]);
    if (npmMajor >= 10) {
      report('ok', `npm ${npmV}`);
    } else {
      report('warn', `npm ${npmV}: 10 以上を推奨`, `npm install -g npm@latest`);
    }
  } else {
    report('fail', 'npm が見つからない', `Node.js を再インストール (通常 Node に同梱)`);
  }

  // git
  const gitV = tryExec('git --version');
  if (gitV) {
    report('ok', gitV);
  } else {
    report(
      'fail',
      'git が見つからない',
      `インストール:\n  macOS:    xcode-select --install (または brew install git)\n  Linux:    apt install git / dnf install git\n  Windows:  https://git-scm.com/download/win`
    );
  }
}

// ============================================================================
// Section 2: ワークスペース (npm install 済か)
// ============================================================================
function checkWorkspace() {
  section('2. ワークスペース (npm install)');

  if (existsSync(resolve(REPO_ROOT, 'node_modules'))) {
    report('ok', 'node_modules が存在');
    state.hasNodeModules = true;
  } else {
    report(
      'fail',
      'node_modules がない — まずは依存関係をインストール',
      `npm install --include=optional`
    );
    return;
  }

  for (const pkg of ['shared', 'editor', 'verify', 'verify-cli', 'workers']) {
    if (existsSync(resolve(REPO_ROOT, `node_modules/@typedcode/${pkg}`))) {
      report('ok', `@typedcode/${pkg} がリンクされている`);
    } else {
      report('fail', `@typedcode/${pkg} がリンクされていない`, `npm install`);
    }
  }

  // wrangler (devDep として install 済のはず)
  const wranglerV = tryExec('npx --no-install wrangler --version', { cwd: REPO_ROOT });
  if (wranglerV) {
    report('ok', `wrangler: ${wranglerV.split('\n').pop()}`);
    state.hasWrangler = true;
  } else {
    report(
      'warn',
      'wrangler が見つからない (npm install で同梱されるはず)',
      `npm install を再実行してください`
    );
  }
}

// ============================================================================
// Section 3: Cloudflare アカウント (wrangler 認証)
// ============================================================================
function checkCloudflareAccount() {
  section('3. Cloudflare アカウント');

  if (!state.hasWrangler) {
    report('skip', 'wrangler 未インストールのため判定スキップ');
    return;
  }

  // wrangler whoami は CLOUDFLARE_API_TOKEN もしくは ~/.config/.wrangler の認証を見る
  const result = spawnSync('npx', ['--no-install', 'wrangler', 'whoami'], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });

  if (result.status === 0 && /You are logged in|Account ID/.test(result.stdout)) {
    const account = result.stdout.match(/Account ID:\s*(\w+)/i);
    if (account) {
      report('ok', `Cloudflare 認証済 (Account: ${account[1].slice(0, 8)}...)`);
    } else {
      report('ok', 'Cloudflare 認証済');
    }
    state.isCloudflareAuthed = true;
  } else {
    report(
      'warn',
      'Cloudflare に未認証',
      `本プロジェクトは Cloudflare Workers + Pages を使うため、無料アカウントが必要です。\n\n手順:\n  1. https://dash.cloudflare.com/sign-up で無料登録 (Email + パスワードのみ、決済情報不要)\n  2. ターミナルで: npx wrangler login\n     → ブラウザが開いて Cloudflare で認可\n  3. 完了したら再度 npm run doctor\n\n備考:\n  - Cloudflare 抜きで editor のタイピング部分のみ試したい場合、\n    ローカル開発 (npm run dev) で Workers を起動しなくても editor は\n    動作しますが、時刻アンカリング (signed checkpoints) は機能しません`
    );
  }
}

// ============================================================================
// Section 4: ローカル設定ファイル
// ============================================================================
function checkLocalConfig() {
  section('4. ローカル設定ファイル');

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
        `Turnstile (人間認証) を使わないなら空欄でも動作する。使うなら\n  https://dash.cloudflare.com/?to=/:account/turnstile → Add Site\n  Domain: localhost (ローカル開発のみなら)\n  作成後の "Site Key" を貼り付け`
      );
    } else {
      report('ok', 'packages/editor/.env: VITE_TURNSTILE_SITE_KEY 設定済');
    }
    if (isPlaceholder(env.VITE_API_URL)) {
      report(
        'warn',
        'packages/editor/.env: VITE_API_URL が placeholder',
        `ローカル開発なら: http://localhost:8787`
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
      `cp packages/workers/.dev.vars.example packages/workers/.dev.vars\n以下の 4 つを設定 (詳細は doctor の続くチェックで個別に案内)`
    );
  } else {
    const vars = envOf(devVars);
    const checks = [
      [
        'TURNSTILE_SECRET_KEY',
        `Turnstile widget の "Secret Key" (Site Key の対)\n人間認証を使わないなら空欄可 (Worker 側でフォールバック)`,
      ],
      [
        'ATTESTATION_SECRET_KEY',
        `任意のランダム文字列 32 byte 以上。生成例:\n  node -e "console.log(crypto.randomBytes(32).toString('hex'))"\n  (openssl があれば: openssl rand -hex 32)`,
      ],
      [
        'CHECKPOINT_SIGNING_KEY_ID',
        `npm run gen-checkpoint-key -w @typedcode/workers の出力 (tcp-YYYYMM-xxxxxx)`,
      ],
      [
        'CHECKPOINT_SIGNING_KEY_JWK',
        `npm run gen-checkpoint-key -w @typedcode/workers の出力 (1 行 JSON)`,
      ],
    ];
    for (const [key, hint] of checks) {
      if (!vars[key] || isPlaceholder(vars[key])) {
        report('fail', `packages/workers/.dev.vars: ${key} 未設定`, hint);
      } else {
        report('ok', `packages/workers/.dev.vars: ${key} 設定済`);
      }
    }
  }

  // ---- workers/wrangler.toml (ローカル dev KV) ----
  const wranglerToml = readFileOrNull('packages/workers/wrangler.toml');
  if (!wranglerToml) {
    report('fail', 'packages/workers/wrangler.toml がない', `git checkout が壊れているかも`);
  } else {
    const envIdx = wranglerToml.search(/\[env\.[a-z]/);
    const topLevel = envIdx > 0 ? wranglerToml.slice(0, envIdx) : wranglerToml;
    if (topLevel.includes('REPLACE_WITH_')) {
      const cfNote = state.isCloudflareAuthed
        ? `wrangler kv namespace create CHECKPOINT_SESSIONS\nwrangler kv namespace create CHECKPOINT_SESSIONS --preview\n出力された id / preview_id をトップレベル [[kv_namespaces]] に貼り付け`
        : `先に Cloudflare アカウントを作成 + wrangler login が必要 (Section 3 参照)`;
      report(
        'warn',
        'packages/workers/wrangler.toml: ローカル dev KV ID が placeholder',
        `${cfNote}\n設定後:\n  git update-index --skip-worktree packages/workers/wrangler.toml`
      );
    } else {
      report('ok', 'packages/workers/wrangler.toml: ローカル dev KV ID 設定済');
    }

    try {
      const out = execSync('git ls-files -v packages/workers/wrangler.toml', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      if (out.startsWith('S ')) {
        report('ok', 'packages/workers/wrangler.toml: skip-worktree 適用済');
      } else {
        report(
          'warn',
          'packages/workers/wrangler.toml: skip-worktree 未適用',
          `dev KV ID 設定後に:\n  git update-index --skip-worktree packages/workers/wrangler.toml`
        );
      }
    } catch {
      report('skip', 'packages/workers/wrangler.toml: skip-worktree 確認できず');
    }
  }
}

// ============================================================================
// Section 5: 署名鍵
// ============================================================================
function checkSigningKey() {
  section('5. 署名鍵 (signed checkpoints)');

  const localKeys = readFileOrNull('packages/shared/src/checkpointKeys/localKeys.ts');
  if (!localKeys) {
    report(
      'fail',
      'packages/shared/src/checkpointKeys/localKeys.ts がない',
      `cp packages/shared/src/checkpointKeys/localKeys.ts.example packages/shared/src/checkpointKeys/localKeys.ts\ngit update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts`
    );
    return;
  }

  try {
    const out = execSync('git ls-files -v packages/shared/src/checkpointKeys/localKeys.ts', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    if (out.startsWith('S ')) {
      report('ok', 'localKeys.ts: skip-worktree 適用済');
    } else {
      report(
        'warn',
        'localKeys.ts: skip-worktree 未適用',
        `git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts`
      );
    }
  } catch {
    report('skip', 'localKeys.ts: skip-worktree 確認できず');
  }

  const hasEntry = /keyId\s*:\s*['"]tcp-/.test(localKeys);
  const devVars = readFileOrNull('packages/workers/.dev.vars');
  const devKeyId = devVars ? envOf(devVars).CHECKPOINT_SIGNING_KEY_ID : '';

  if (!hasEntry && devKeyId && !isPlaceholder(devKeyId)) {
    const registry = readFileOrNull('packages/shared/src/checkpointKeys/registry.ts');
    if (registry && registry.includes(devKeyId)) {
      report(
        'warn',
        `localKeys.ts に dev 鍵 entry なし。.dev.vars の keyId (${devKeyId}) は registry.ts に存在`,
        `本番/staging 鍵をローカルに流用している状態。\n別 dev 鍵を生成推奨:\n  npm run gen-checkpoint-key -w @typedcode/workers`
      );
    } else {
      report(
        'fail',
        `.dev.vars の keyId (${devKeyId}) が registry.ts にも localKeys.ts にもない`,
        `gen-checkpoint-key を再実行して localKeys.ts に append、ID/JWK を .dev.vars に貼り直す`
      );
    }
  } else if (hasEntry) {
    report('ok', 'localKeys.ts に dev 鍵 entry あり');
  } else {
    report(
      'warn',
      'localKeys.ts に dev 鍵 entry なし、.dev.vars にも keyId なし',
      `署名鍵を生成:\n  npm run gen-checkpoint-key -w @typedcode/workers\n出力の手順に従って localKeys.ts と .dev.vars を埋める`
    );
  }
}

// ============================================================================
// Section 6: Cloudflare リソース突合 (--cf 指定時のみ)
// ============================================================================
function checkCloudflareResources() {
  section('6. Cloudflare リソース突合 (--cf 指定時のみ)');

  if (!CHECK_CF) {
    report('skip', '--cf を付けると KV ID と CF アカウントの突合を実施');
    return;
  }
  if (!state.hasWrangler) {
    report('skip', 'wrangler 未インストールのため判定スキップ');
    return;
  }
  if (!state.isCloudflareAuthed) {
    report('skip', 'Cloudflare 未認証のため判定スキップ');
    return;
  }

  const kvList = spawnSync('npx', ['--no-install', 'wrangler', 'kv', 'namespace', 'list'], {
    encoding: 'utf-8',
    cwd: resolve(REPO_ROOT, 'packages/workers'),
  });
  if (kvList.status === 0) {
    try {
      const namespaces = JSON.parse(kvList.stdout);
      const wranglerToml = readFileOrNull('packages/workers/wrangler.toml') ?? '';
      const idsInToml = [...wranglerToml.matchAll(/id\s*=\s*"([0-9a-f]{32})"/gi)].map((m) => m[1]);
      const idsOnCf = new Set(namespaces.map((n) => n.id));
      if (idsInToml.length === 0) {
        report('warn', 'wrangler.toml に有効な KV ID なし', `Section 4 を再確認`);
      }
      for (const id of idsInToml) {
        if (idsOnCf.has(id)) {
          report('ok', `KV id ${id.slice(0, 10)}... は CF 上に存在`);
        } else {
          report(
            'fail',
            `KV id ${id.slice(0, 10)}... が CF 上に存在しない`,
            `wrangler kv namespace list で実 ID を確認し wrangler.toml を更新`
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
console.log(`${C.bold}TypedCode setup doctor${C.reset} ${C.dim}(${REPO_ROOT})${C.reset}`);
if (STRICT) console.log(`${C.dim}strict mode: warnings も blocking 扱い${C.reset}`);

checkBasicTooling();
checkWorkspace();
checkCloudflareAccount();
checkLocalConfig();
checkSigningKey();
checkCloudflareResources();

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
  console.log(`詳しい手順: ${C.cyan}docs/setup.md${C.reset}`);
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
