/**
 * 凍結 proof (`frozen-proofs/`) を読むヘルパ (#809 の spec*.test.ts から使う)。読み方は `frozenProofs.test.ts` に倣う。
 * fixture は**読むだけ**で、ここから書き換えて保存しない。呼ぶたびに新しく parse するので、
 * テストが返り値を書き換えても他のテストに漏れない。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckpointPublicKey, ExamAuthorityKey, ProofFile, SpecVerificationContext } from '../../index.js';

// happy-dom の URL は file: を扱えないので、パスは node:path で組み立てる
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'frozen-proofs');

export function loadFrozenFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as T;
}

/** proof を読む (呼ぶたびに新しい object。テストが書き換えてよい) */
export function loadFrozenProof(name: 'casual-anchored' | 'exam-v1' | 'exam-v2'): ProofFile {
  return loadFrozenFixture<ProofFile>(`${name}.proof.json`);
}

export function loadFrozenExamPackage(name: 'exam-v1' | 'exam-v2'): unknown {
  return loadFrozenFixture<unknown>(`${name}.tcexam.json`);
}

export function frozenCheckpointKey(): CheckpointPublicKey {
  // 鍵の JSON は作り直さない (README)。環境 (#321) は JSON の後から入った項目なので、読み込むときに足す
  return {
    ...loadFrozenFixture<Omit<CheckpointPublicKey, 'environment'>>('checkpoint-key.json'),
    environment: 'production',
  };
}

export function frozenExamAuthorityKey(): ExamAuthorityKey {
  return loadFrozenFixture<ExamAuthorityKey>('exam-authority-key.json');
}

/** 固定の評価時刻 (凍結 proof の生成日より後の任意の時刻。legacy 1.2.0 の判定には使われない) */
export const EVALUATION_TIME = '2026-11-20T00:00:00.000Z';

/** fixture の鍵だけを信頼する context。`overrides` で mode・鍵・パッケージなどを差し替える */
export function frozenContext(overrides: Partial<SpecVerificationContext> = {}): SpecVerificationContext {
  return {
    mode: 'full',
    trust: { checkpointKeys: [frozenCheckpointKey()], examAuthorityKeys: [frozenExamAuthorityKey()] },
    evaluationTime: EVALUATION_TIME,
    ...overrides,
  };
}

/** full モードは PoSW (10,000 回 × イベント数) を再計算する。カバレッジ計測下でも収まる余裕をとる */
export const FULL_VERIFY_TIMEOUT_MS = 120_000;
