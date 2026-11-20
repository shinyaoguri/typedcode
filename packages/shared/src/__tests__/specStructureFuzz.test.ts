/**
 * 1.2.0 を名乗る入力で、仕様別の入口が例外を投げずに必ず結果を返すことを総当たりで確かめる (#809)。
 *
 * 入口は `unknown` を受けるので、legacy の検証器 (`verifyProofFile` / `verifyExamBinding`) が型違いの値で
 * TypeError などを投げる経路は、構造の検査 (`isLegacyTypingProofStructure`) で `malformed` に落とす必要がある。
 * 凍結 proof 3 件の、イベントの中身以外のフィールドを 1 つずつ型違いの値 (null・数値・文字列・配列・空 object・
 * キーの削除) に差し替えて回す。例外の経路は PoSW の再計算の外にあるので fast で回す。
 */

import { describe, expect, it } from 'vitest';
import { verifyProofBySpec } from '../index.js';
import { frozenContext, loadFrozenExamPackage, loadFrozenProof } from './fixtures/frozenProofFixtures.js';

type Fixture = 'casual-anchored' | 'exam-v1' | 'exam-v2';
type Path = ReadonlyArray<string | number>;

const DELETE = Symbol('delete');
const REPLACEMENTS: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: 'null', value: null },
  { label: 'a number', value: 7 },
  { label: 'a string', value: 'x' },
  { label: 'an array', value: [] },
  { label: 'an empty object', value: {} },
  { label: 'deletion', value: DELETE },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const key of path) current = (current as Record<string | number, unknown> | undefined)?.[key];
  return current;
}

/** 差し替える対象: 下の各コンテナの直下のキー (イベントの中身は対象外。`proof.events` そのものは対象) */
function targetPaths(proof: unknown): Path[] {
  const containers: Path[] = [
    [],
    ['typingProofData'],
    ['typingProofData', 'metadata'],
    ['proof'],
    ['sessionStartToken'],
    ['sessionStartToken', 'payload'],
    ['exam'],
    ['fingerprint'],
    ['metadata'],
  ];
  const checkpoints = at(proof, ['checkpoints']);
  if (Array.isArray(checkpoints)) {
    checkpoints.forEach((_, i) => {
      containers.push(['checkpoints', i], ['checkpoints', i, 'signature'], ['checkpoints', i, 'signature', 'payload']);
    });
  }
  const paths: Path[] = [];
  for (const container of containers) {
    const value = at(proof, container);
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) paths.push([...container, key]);
  }
  return paths;
}

function replaced(fixture: Fixture, path: Path, value: unknown): unknown {
  const proof = loadFrozenProof(fixture) as unknown;
  const parent = at(proof, path.slice(0, -1)) as Record<string | number, unknown>;
  const key = path.at(-1) as string | number;
  if (value === DELETE) delete parent[key];
  else parent[key] = value;
  return proof;
}

const CASES: Array<{ fixture: Fixture; withPackage: boolean }> = [
  { fixture: 'casual-anchored', withPackage: false },
  { fixture: 'exam-v1', withPackage: false },
  { fixture: 'exam-v1', withPackage: true },
  { fixture: 'exam-v2', withPackage: false },
  { fixture: 'exam-v2', withPackage: true },
];

describe('verifyProofBySpec on a 1.2.0 proof with one field of the wrong type', () => {
  it.each(CASES)(
    'returns a result for every replacement in $fixture (package: $withPackage)',
    async ({ fixture, withPackage }) => {
      const thrown: string[] = [];
      let count = 0;
      for (const path of targetPaths(loadFrozenProof(fixture))) {
        for (const { label, value } of REPLACEMENTS) {
          count++;
          const context = frozenContext({
            mode: 'fast',
            ...(withPackage ? { examPackage: loadFrozenExamPackage(fixture as 'exam-v1' | 'exam-v2') } : {}),
          });
          try {
            await verifyProofBySpec(replaced(fixture, path, value), context);
          } catch (error) {
            thrown.push(`${path.join('.')} = ${label}: ${(error as Error).message}`);
          }
        }
      }
      expect({ count: count > 100, thrown }).toEqual({ count: true, thrown: [] });
    },
    120_000
  );
});
