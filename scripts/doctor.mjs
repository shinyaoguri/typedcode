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
 *   npm run doctor                  # ローカル dev のみ (Node のみ必須)
 *   npm run doctor -- --strict      # warning も blocking 扱い
 *   npm run doctor -- --cf          # ローカル KV と CF の突合も
 *   npm run doctor -- --maintainer  # GitHub Actions / staging / production 側もチェック
 *                                   # (CI 経由のデプロイ運用するメンテナ向け)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const CHECK_CF = args.has('--cf') || args.has('--maintainer');
const MAINTAINER = args.has('--maintainer');

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
    report('fail', 'node_modules がない — まずは依存関係をインストール', `npm install --include=optional`);
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
    report('warn', 'wrangler が見つからない (npm install で同梱されるはず)', `npm install を再実行してください`);
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
      report('warn', 'packages/editor/.env: VITE_API_URL が placeholder', `ローカル開発なら: http://localhost:8787`);
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
      ['CHECKPOINT_SIGNING_KEY_ID', `npm run gen-checkpoint-key -w @typedcode/workers の出力 (tcp-YYYYMM-xxxxxx)`],
      ['CHECKPOINT_SIGNING_KEY_JWK', `npm run gen-checkpoint-key -w @typedcode/workers の出力 (1 行 JSON)`],
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
// メンテナ専用セクション (--maintainer フラグ時のみ)
// ============================================================================

// CLOUDFLARE_API_TOKEN は repo level ではなく Environment secret (staging/production 別) に置く
// (docs/setup.md M2: preview/staging に本番デプロイ権限の token を露出させないため)。
const REQUIRED_REPO_SECRETS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PROJECT_NAME'];
const REQUIRED_ENV_SECRETS = ['CLOUDFLARE_API_TOKEN', 'VITE_API_URL', 'VITE_TURNSTILE_SITE_KEY'];
const REQUIRED_WORKER_SECRETS = [
  'TURNSTILE_SECRET_KEY',
  'ATTESTATION_SECRET_KEY',
  'CHECKPOINT_SIGNING_KEY_ID',
  'CHECKPOINT_SIGNING_KEY_JWK',
];

let ghAvailable = false;
let ghRepoSlug = ''; // owner/repo

// ============================================================================
// Section 7: GitHub repo settings + Actions secrets (--maintainer)
// ============================================================================
function checkGitHubSetup() {
  section('7. GitHub repo settings (--maintainer)');
  if (!MAINTAINER) {
    report('skip', '--maintainer を付けると GitHub Actions 用設定もチェック');
    return;
  }

  if (!commandExists('gh')) {
    report(
      'fail',
      'gh (GitHub CLI) が見つからない',
      `インストール: https://cli.github.com/\n  macOS:   brew install gh\n  Linux:   ディストロのパッケージマネージャ\n  Windows: winget install GitHub.cli\n認証: gh auth login`
    );
    return;
  }
  ghAvailable = true;

  const authStatus = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8' });
  if (authStatus.status !== 0) {
    report('fail', 'gh が未認証', `gh auth login`);
    return;
  }
  report('ok', 'gh CLI: 認証済');

  // 対象 repo の特定 (origin から)
  const origin = tryExec('git config --get remote.origin.url', { cwd: REPO_ROOT });
  const m = origin?.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/);
  if (!m) {
    report('fail', `git remote origin から repo を特定できない (${origin})`, '');
    return;
  }
  ghRepoSlug = `${m[1]}/${m[2]}`;
  report('ok', `対象 repo: ${ghRepoSlug}`);

  // delete_branch_on_merge (タグ式 GitHub Flow では ON が推奨。長命ブランチは main のみで
  // ruleset が削除から保護しているため、feature ブランチはマージ時に自動削除してよい)
  const repoSettings = tryExec(`gh api repos/${ghRepoSlug} --jq '.delete_branch_on_merge'`);
  if (repoSettings === 'true') {
    report('ok', 'delete_branch_on_merge: true (feature ブランチがマージ時に自動削除される)');
  } else if (repoSettings === 'false') {
    report(
      'fail',
      'delete_branch_on_merge: false (マージ済み feature ブランチが残り続ける)',
      `gh api -X PATCH repos/${ghRepoSlug} -F delete_branch_on_merge=true`
    );
  } else {
    report('skip', `delete_branch_on_merge 取得失敗`);
  }

  // Repo-level secrets
  const repoSecretsJson = tryExec(`gh secret list --json name --jq '[.[] | .name]'`, { cwd: REPO_ROOT });
  let repoSecrets = [];
  try {
    repoSecrets = JSON.parse(repoSecretsJson || '[]');
  } catch {}
  for (const key of REQUIRED_REPO_SECRETS) {
    if (repoSecrets.includes(key)) {
      report('ok', `repo secret: ${key}`);
    } else {
      report('fail', `repo secret 未設定: ${key}`, `gh secret set ${key}\n値の中身は docs/setup.md M1-M2 参照`);
    }
  }

  // repo level の CLOUDFLARE_API_TOKEN は方針違反 (Environment secret が同名 repo secret を
  // 上書きするため動作はするが、preview/staging からも本番権限 token に到達しうる)
  if (repoSecrets.includes('CLOUDFLARE_API_TOKEN')) {
    report(
      'warn',
      'repo secret CLOUDFLARE_API_TOKEN が存在 (Environment secret への分離を推奨)',
      `docs/setup.md M2 参照。staging/production 各 Environment に権限を絞った token を置き、repo level は削除:\n  gh secret delete CLOUDFLARE_API_TOKEN`
    );
  }

  // Environments
  const envListJson = tryExec(`gh api repos/${ghRepoSlug}/environments --jq '[.environments[].name]'`);
  let envList = [];
  try {
    envList = JSON.parse(envListJson || '[]');
  } catch {}

  for (const envName of ['staging', 'production']) {
    if (!envList.includes(envName)) {
      report(
        'fail',
        `Environment "${envName}" が存在しない`,
        `GitHub Web UI: Settings → Environments → New environment "${envName}"`
      );
      continue;
    }
    report('ok', `Environment "${envName}" 存在`);

    // production の Required reviewers
    if (envName === 'production') {
      const protectionJson = tryExec(`gh api repos/${ghRepoSlug}/environments/production --jq '.protection_rules'`);
      try {
        const rules = JSON.parse(protectionJson || '[]');
        const reqRev = rules.find((r) => r.type === 'required_reviewers');
        if (reqRev && reqRev.reviewers?.length > 0) {
          const names = reqRev.reviewers.map((r) => r.reviewer?.login || r.reviewer?.name || 'unknown').join(', ');
          report('ok', `production: Required reviewers (${names})`);
        } else {
          report(
            'fail',
            'production env に Required reviewers が未設定',
            `GitHub Web UI: Settings → Environments → production → Deployment protection rules\nRequired reviewers を ON + 自分を 1 名以上追加`
          );
        }
      } catch {
        report('skip', 'production の protection rules 取得失敗');
      }
    }

    // Env secrets
    const envSecretsJson = tryExec(`gh secret list --env ${envName} --json name --jq '[.[] | .name]'`, {
      cwd: REPO_ROOT,
    });
    let envSecrets = [];
    try {
      envSecrets = JSON.parse(envSecretsJson || '[]');
    } catch {}
    for (const key of REQUIRED_ENV_SECRETS) {
      if (envSecrets.includes(key)) {
        report('ok', `env "${envName}" secret: ${key}`);
      } else {
        report('fail', `env "${envName}" secret 未設定: ${key}`, `gh secret set ${key} --env ${envName}`);
      }
    }
  }
}

// ============================================================================
// Section 8/9: Staging / Production Worker (--maintainer)
// ============================================================================
function checkDeployedWorker(envName, configFile) {
  const workerName = envName === 'staging' ? 'typedcode-api-staging' : 'typedcode-api';
  section(`${envName === 'staging' ? '8' : '9'}. ${envName} Worker (--maintainer)`);

  if (!MAINTAINER) {
    report('skip', `--maintainer を付けると ${envName} Worker もチェック`);
    return;
  }
  if (!state.hasWrangler || !state.isCloudflareAuthed) {
    report('skip', 'wrangler 未認証のため判定スキップ');
    return;
  }

  // 設定ファイル存在
  const config = readFileOrNull(`packages/workers/${configFile}`);
  if (!config) {
    report('fail', `packages/workers/${configFile} が存在しない`, `git checkout が壊れているか、ブランチを確認`);
    return;
  }

  // KV ID が placeholder でないか
  if (config.includes('REPLACE_WITH_')) {
    report(
      'fail',
      `${configFile} の KV ID が placeholder`,
      `npx wrangler kv namespace create CHECKPOINT_SESSIONS_${envName.toUpperCase()}\n出力された id を ${configFile} の id = "REPLACE_WITH_..." に貼り付け commit`
    );
  } else {
    const kvIds = [...config.matchAll(/id\s*=\s*"([0-9a-f]{32})"/gi)].map((m) => m[1]);
    if (kvIds.length === 0) {
      report('warn', `${configFile}: 32-hex KV ID が見つからない`);
    } else {
      report('ok', `${configFile}: KV ID 設定済 (${kvIds[0].slice(0, 10)}...)`);
    }
  }

  // Worker がデプロイされているか
  // wrangler deployments list は古い順に並ぶので、最後の Created を最新と扱う
  const deployment = spawnSync('npx', ['--no-install', 'wrangler', 'deployments', 'list', '--name', workerName], {
    encoding: 'utf-8',
    cwd: resolve(REPO_ROOT, 'packages/workers'),
  });
  if (deployment.status === 0 && /Created:/.test(deployment.stdout)) {
    const allCreated = [...deployment.stdout.matchAll(/^Created:\s+(\S+)/gm)];
    const latest = allCreated[allCreated.length - 1]?.[1] ?? '?';
    report('ok', `${workerName} デプロイ済 (最終: ${latest})`);
  } else {
    report(
      'warn',
      `${workerName} がまだデプロイされていない`,
      `${envName === 'staging' ? 'main ブランチに push すると CI が自動デプロイ' : 'v* タグを push (gh release create) すると CI が承認待ちデプロイ'}`
    );
  }

  // Worker secrets 4 件
  const secrets = spawnSync('npx', ['--no-install', 'wrangler', 'secret', 'list', '--config', configFile], {
    encoding: 'utf-8',
    cwd: resolve(REPO_ROOT, 'packages/workers'),
  });
  if (secrets.status === 0) {
    let names = [];
    try {
      names = JSON.parse(secrets.stdout).map((s) => s.name);
    } catch {}
    for (const key of REQUIRED_WORKER_SECRETS) {
      if (names.includes(key)) {
        report('ok', `${workerName} secret: ${key}`);
      } else {
        report(
          'fail',
          `${workerName} secret 未設定: ${key}`,
          `cd packages/workers\nnpx wrangler secret put ${key} --config ${configFile}`
        );
      }
    }
  } else {
    report('skip', `${workerName} の secret 一覧取得失敗 (未デプロイ時は wrangler でも fail)`);
  }
}

// ============================================================================
// Section 10: Cloudflare Pages project (--maintainer)
// ============================================================================
function checkPagesProject() {
  section('10. Cloudflare Pages project (--maintainer)');
  if (!MAINTAINER) {
    report('skip', '--maintainer を付けると Pages プロジェクトもチェック');
    return;
  }
  if (!state.hasWrangler || !state.isCloudflareAuthed) {
    report('skip', 'wrangler 未認証のため判定スキップ');
    return;
  }

  // CLOUDFLARE_PROJECT_NAME は repo secret (中身は読めない) なので、Pages
  // プロジェクトが少なくとも 1 つ存在することだけ確認する。
  const list = spawnSync('npx', ['--no-install', 'wrangler', 'pages', 'project', 'list'], {
    encoding: 'utf-8',
    cwd: resolve(REPO_ROOT, 'packages/workers'),
  });
  if (list.status === 0) {
    const projectNames = [...list.stdout.matchAll(/^│\s+(\S[\w-]+)\s+│/gm)].map((m) => m[1]);
    if (projectNames.length === 0) {
      report(
        'fail',
        'Cloudflare Pages プロジェクトがアカウントに 1 つもない',
        `dashboard で作成: https://dash.cloudflare.com → Workers & Pages → Create application → Pages\nまたは: npx wrangler pages project create <name>\n作成後、その名前を CLOUDFLARE_PROJECT_NAME secret に設定`
      );
    } else {
      report(
        'ok',
        `Pages プロジェクトが ${projectNames.length} 件存在: ${projectNames.join(', ')}`,
        `repo secret CLOUDFLARE_PROJECT_NAME が上記いずれかと一致していることを目視確認してください`
      );
    }
  } else {
    report('skip', 'wrangler pages project list が失敗');
  }
}

// ============================================================================
// 実行
// ============================================================================
console.log(`${C.bold}TypedCode setup doctor${C.reset} ${C.dim}(${REPO_ROOT})${C.reset}`);
if (STRICT) console.log(`${C.dim}strict mode: warnings も blocking 扱い${C.reset}`);
if (MAINTAINER) console.log(`${C.dim}maintainer mode: GitHub + staging + production もチェック${C.reset}`);

checkBasicTooling();
checkWorkspace();
checkCloudflareAccount();
checkLocalConfig();
checkSigningKey();
checkCloudflareResources();
checkGitHubSetup();
checkDeployedWorker('staging', 'wrangler.staging.toml');
checkDeployedWorker('production', 'wrangler.production.toml');
checkPagesProject();

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
  console.log(`${C.yellow}${C.bold}セットアップは動作可能ですが ${warnCount} 件の注意点があります。${C.reset}`);
  console.log(`必要に応じて対応してください (動作に必須ではありません)。`);
} else {
  console.log(`${C.green}${C.bold}すべてのチェックを通過しました。${C.reset} 開発開始可能です:`);
  console.log(`  ${C.cyan}npm run dev${C.reset}`);
}
process.exit(0);
