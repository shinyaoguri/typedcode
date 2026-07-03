#!/usr/bin/env node
/**
 * 封印問題パッケージ (`.tcexam`) を生成する出題者ツール (ADR-0006)。
 *
 * 平文問題を Argon2id KDF + AES-256-GCM で封印し、出題者の ECDSA-P256 秘密鍵で署名する。
 * **canonical serialization / canonical core は packages/shared/src/exam/examPackage.ts と
 * 必ず一致させること** (一致しないと editor で復号も grader で検証もできない)。下記の
 * deterministicStringify / signing core の field set は shared からの写し。
 *
 * 必要な環境変数:
 *   EXAM_SIGNING_KEY_JWK  出題者の私的 JWK (generate-exam-authority-key.mjs の出力)
 *   EXAM_SIGNING_KEY_ID   その keyId
 *
 * 使い方:
 *   EXAM_SIGNING_KEY_JWK='{...}' EXAM_SIGNING_KEY_ID=exam-202606-ab12cd \
 *     node packages/workers/scripts/make-exam-package.mjs \
 *       --problem problem.md --exam-id 2026-spring-cs101-final --problem-id p1 \
 *       --languages c,python --out p1.tcexam
 *
 * 主なオプション (省略時は既定値):
 *   --problem <file>     問題本文の平文ファイル (必須)
 *   --exam-id <id>       (既定: "exam")
 *   --problem-id <id>    (既定: "p1")
 *   --variant <v>        per-student variant (既定: null)
 *   --languages <a,b>    許可言語 CSV (既定: "c")
 *   --release <ISO>      T0 (既定: 実行時刻)
 *   --deadline <ISO>     T1 (既定: 実行時刻 + 3h)
 *   --token <CODE>       監督コード (省略時は 8 字 Crockford Base32 を自動生成)
 *   --out <file>         出力 .tcexam (既定: "<problemId>.tcexam")
 *   --embed-pubkey       publicKeyJwk を同梱する (long-term verifiability)
 */

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { argon2id } from '@noble/hashes/argon2.js';

// --- shared/src/exam/examPackage.ts と一致させる定数 (ADR-0006) ---
const EXAM_PACKAGE_FORMAT_VERSION = 1;
const DEFAULT_KDF_PARAMS = { memKiB: 65536, iterations: 3, parallelism: 1 };
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // I L O U を除外 (32 文字)

// --- shared/src/utils/hashUtils.ts の写し (canonical serialization) ---
function deterministicStringify(obj) {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((sorted, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
    }
    return value;
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'embed-pubkey') {
      args[key] = true;
    } else {
      args[key] = argv[++i];
    }
  }
  return args;
}

function generateToken() {
  const bytes = new Uint8Array(8);
  webcrypto.getRandomValues(bytes);
  // 256 % 32 === 0 なのでバイアスなし
  return Array.from(bytes, (b) => CROCKFORD[b % 32]).join('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const jwkRaw = process.env.EXAM_SIGNING_KEY_JWK;
  const keyId = process.env.EXAM_SIGNING_KEY_ID;
  if (!jwkRaw || !keyId) {
    throw new Error('EXAM_SIGNING_KEY_JWK and EXAM_SIGNING_KEY_ID env vars are required');
  }
  if (!args.problem) {
    throw new Error('--problem <file> is required');
  }

  const plaintext = readFileSync(args.problem, 'utf8');
  const examId = args['exam-id'] ?? 'exam';
  const problemId = args['problem-id'] ?? 'p1';
  const variant = args.variant ?? null;
  const languages = (args.languages ?? 'c')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const now = new Date();
  const releaseTime = args.release ?? now.toISOString();
  const deadline = args.deadline ?? new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  const token = args.token ? args.token.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '') : generateToken();
  const outFile = args.out ?? `${problemId}.tcexam`;

  // 1. KDF (Argon2id) — salt はランダム 16 byte
  const salt = new Uint8Array(16);
  webcrypto.getRandomValues(salt);
  const kdf = {
    algorithm: 'argon2id',
    salt: bytesToHex(salt),
    params: { ...DEFAULT_KDF_PARAMS },
  };
  const keyBytes = argon2id(new TextEncoder().encode(token), salt, {
    t: kdf.params.iterations,
    m: kdf.params.memKiB,
    p: kdf.params.parallelism,
    dkLen: 32,
  });

  // 2. AES-256-GCM 暗号化 (IV ランダム 12 byte)
  const aesKey = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12);
  webcrypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext))
  );
  const cipher = {
    algorithm: 'AES-256-GCM',
    iv: bytesToHex(iv),
    ciphertext: bytesToBase64(ciphertext),
  };

  // 3. canonical core (shared の examPackageSigningCore と同じ field set)
  const core = {
    formatVersion: EXAM_PACKAGE_FORMAT_VERSION,
    examId,
    problemId,
    variant,
    kdf,
    cipher,
    releaseTime,
    deadline,
    allowed: { languages },
    keyId,
    algorithm: 'ECDSA-P256',
  };

  // 4. ECDSA-P256 署名 (canonical core)
  const privateKey = await webcrypto.subtle.importKey(
    'jwk',
    JSON.parse(jwkRaw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signingInput = new TextEncoder().encode(deterministicStringify(core));
  const sigBuffer = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signingInput);
  const signature = bytesToHex(new Uint8Array(sigBuffer));

  // packageHash (確認用) = SHA-256(deterministicStringify(core))
  const packageHashBuf = await webcrypto.subtle.digest('SHA-256', signingInput);
  const packageHash = bytesToHex(new Uint8Array(packageHashBuf));

  const manifest = { ...core, signature };
  if (args['embed-pubkey']) {
    const jwk = JSON.parse(jwkRaw);
    manifest.publicKeyJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  }

  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('=== Exam package written ===');
  console.log('file:        ' + outFile);
  console.log('examId:      ' + examId);
  console.log('problemId:   ' + problemId);
  console.log('keyId:       ' + keyId);
  console.log('packageHash: ' + packageHash);
  console.log('release:     ' + releaseTime);
  console.log('deadline:    ' + deadline);
  console.log('');
  console.log('=== 監督コード (T0 に口頭/板書で解禁) ===');
  console.log('  ' + token.replace(/(.{4})(.{4})/, '$1-$2') + '  (入力時の区切り/大小は無視されます)');
  console.log('');
  console.log('※ コードは平文 manifest に含まれない。紛失すると復号不能なので安全に保管すること。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
