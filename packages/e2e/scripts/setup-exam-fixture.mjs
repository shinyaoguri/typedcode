#!/usr/bin/env node
/**
 * 試験 (exam) モードの round-trip E2E 用 fixture を用意する (#229)。
 *
 * 作るもの (すべて packages/e2e/fixtures/exam/ 配下。gitignore 済みで、リポジトリの追跡ファイルには一切書かない):
 *   - p1.tcexam / other.tcexam … 出題者鍵で署名・封印した問題パッケージ (v2 バンドル 1 問)。other は examId だけが違い、
 *                                 p1 の提出に対しては「別の問題パッケージ」(束縛の負のオラクル)
 *   - authority-keys.mjs       … 上記の署名に使った出題者「公開」鍵 (`LOCAL_EXAM_AUTHORITY_KEYS`)。秘密鍵はディスクに残さない
 *   - fixture.json             … spec が読む入口 (監督コード・パッケージのパス・keyId)
 *
 * **`packages/shared/src/examAuthorityKeys/localKeys.ts` は書き換えない。** それは verifier の信頼の根で、
 * 開発者が自分の dev 鍵を置く場所 (gitignore 済み。#338) なので、E2E 用の使い捨て鍵を書くと開発者の鍵を壊し、
 * e2e の後も手元の通常の dev サーバ・verifier が偽の出題者鍵を信頼し続ける。代わりに E2E の実行時だけ、
 * editor の dev サーバ (vite.editor.config.mjs) と verify-cli (tests/helpers/examKeysLoader.mjs) が
 * `localKeys` の import を `authority-keys.mjs` に差し替える。
 *
 * 封印は `packages/workers/scripts/make-exam-package.mjs` を実際に spawn して行う。このスクリプトは
 * shared の canonical serialization の手書きコピーなので、ここで使うことで shared とのドリフトも E2E が検出する。
 *
 * 繰り返し実行して安全: fixture が揃っていれば何もしない。dev サーバが前回の鍵を読み込み済みでも、
 * 鍵とパッケージが入れ替わって食い違うことが無いようにするため、再生成は fixtures/ を消したときだけ。
 */
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

/** 監督コード (Crockford Base32 の 8 字)。 */
export const EXAM_FIXTURE_CODE = 'E2ETEST1';

/** 問題パッケージ生成の入口 (packages/workers)。 */
const MAKE_PACKAGE_SCRIPT = 'packages/workers/scripts/make-exam-package.mjs';

/** 封印する平文: /author が出す v2 バンドル (tcexam-exam/1) の 1 問。 */
const BUNDLE = {
  schema: 'tcexam-exam/1',
  problems: [
    {
      problemId: 'p1',
      statement: '# E2E 用の問題\n\n`main` を書いて 0 を返してください。\n',
      starter: { filename: 'main.c', language: 'c', content: '' },
    },
  ],
};

/** fixture が揃っているか (中身が壊れていないかまでは見ない。壊れたら fixtures/ を消して setup し直す)。 */
export function isFixtureComplete(dir) {
  return ['fixture.json', 'authority-keys.mjs', 'p1.tcexam', 'other.tcexam'].every((f) => existsSync(join(dir, f)));
}

/**
 * make-exam-package.mjs で `.tcexam` を 1 つ作る。秘密鍵は env で渡すだけで、ディスクにもログにも出さない。
 * @returns {string | null} 失敗時はエラーメッセージ
 */
function makePackage({ root, problemFile, out, examId, keyId, privateJwk }) {
  const res = spawnSync(
    process.execPath,
    [
      resolve(root, MAKE_PACKAGE_SCRIPT),
      ...['--problem', problemFile],
      ...['--exam-id', examId],
      ...['--problem-id', 'p1'],
      ...['--languages', 'c'],
      ...['--token', EXAM_FIXTURE_CODE],
      ...['--out', out],
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXAM_SIGNING_KEY_JWK: JSON.stringify(privateJwk), EXAM_SIGNING_KEY_ID: keyId },
      timeout: 120_000,
    }
  );
  if (res.error) return res.error.message;
  if (res.status !== 0) return `exit ${res.status}\n${res.stderr}`;
  return null;
}

/**
 * exam fixture を root 配下の packages/e2e/fixtures/exam/ に用意する。戻り値は終了コード。
 * @param {{ root?: string, log?: (msg: string) => void, error?: (msg: string) => void }} [options]
 */
export async function setupExamFixture({ root = ROOT, log = console.log, error = console.error } = {}) {
  const dir = resolve(root, 'packages/e2e/fixtures/exam');
  if (isFixtureComplete(dir)) {
    log('[e2e setup] exam fixture は用意済みなので何もしません (作り直すなら packages/e2e/fixtures を消す)');
    return 0;
  }
  mkdirSync(dir, { recursive: true });

  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey);
  // keyId は公開鍵 x 座標から決定的に作る (規約 `exam-<時期>-<英数字>` に合わせる)。
  const keyId = `exam-e2e-${(publicJwk.x ?? '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase()}`;

  const work = mkdtempSync(join(tmpdir(), 'tc-e2e-exam-'));
  try {
    const problemFile = join(work, 'bundle.json');
    writeFileSync(problemFile, JSON.stringify(BUNDLE));
    const targets = [
      { out: join(dir, 'p1.tcexam'), examId: 'e2e-exam' },
      { out: join(dir, 'other.tcexam'), examId: 'e2e-exam-other' },
    ];
    for (const target of targets) {
      const failure = makePackage({ root, problemFile, keyId, privateJwk, ...target });
      if (failure) {
        error(`[e2e setup] make-exam-package.mjs が失敗しました (${target.examId}): ${failure}`);
        // 中途半端な fixture を残さない (残すと次回「用意済み」と誤認する)。
        rmSync(dir, { recursive: true, force: true });
        return 1;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // 公開鍵のエントリ。validFrom は package の releaseTime (= 生成時刻) より前、書式は厳密な ISO (#276)。
  const publicEntry = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
    description: 'E2E test exam authority key (auto-generated, never used in production)',
  };
  writeFileSync(
    join(dir, 'authority-keys.mjs'),
    [
      '// E2E 用に自動生成 (setup-exam-fixture.mjs)。追跡ファイルではない。',
      '// examAuthorityKeys/localKeys.ts の代わりに E2E の実行時だけ差し込まれる。',
      `export const LOCAL_EXAM_AUTHORITY_KEYS = [${JSON.stringify(publicEntry)}];`,
      '',
    ].join('\n')
  );
  writeFileSync(
    join(dir, 'fixture.json'),
    JSON.stringify(
      { code: EXAM_FIXTURE_CODE, package: 'p1.tcexam', otherPackage: 'other.tcexam', keyId, problemId: 'p1' },
      null,
      2
    ) + '\n'
  );
  log(`[e2e setup] exam fixture を生成 (keyId=${keyId}, ${dir})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await setupExamFixture();
}
