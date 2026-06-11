/**
 * ClassProblemStore - class モード (ADR-0014) の問題本文 表示用ストア
 *
 * 平文 `.tcclass` から展開した各問の本文 (statement) を **filename キー**で localStorage に
 * sticky 保存する。**用途は「リロード/タブ切替時の問題再表示」のみ**。
 *
 * exam の ExamPackageStore は problemId キー (束縛コンテキスト examContext が問題を持つ) だが、
 * class タブは **examContext を持たない** (root 束縛なし、tier ①) ため problemId を proof から
 * 引けない。代わりに **タブの filename** (セッション/リロードで安定・一意) で問題本文を照合する。
 *
 * 問題は公開前提なので localStorage 保存で機密性の損失はない。解除は `?reset` に一本化。
 */

import { classProblemsKey } from '../core/storageKeys.js';

export interface StoredClassProblem {
  problemId: string;
  /** 問題文 (Markdown) */
  statement: string;
}

/** filename → 問題本文。タブ切替/復元時に active タブの filename で照合する。 */
type ProblemMap = Record<string, StoredClassProblem>;

function readAll(): ProblemMap {
  try {
    const raw = localStorage.getItem(classProblemsKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ProblemMap;
  } catch {
    /* 壊れていれば空として扱う */
  }
  return {};
}

function writeAll(map: ProblemMap): void {
  try {
    localStorage.setItem(classProblemsKey(), JSON.stringify(map));
  } catch {
    /* 保存不可環境では諦める (表示用キャッシュなので致命ではない) */
  }
}

export const ClassProblemStore = {
  /** filename キーで問題本文を保存する */
  save(filename: string, problem: StoredClassProblem): void {
    const map = readAll();
    map[filename] = problem;
    writeAll(map);
  },

  /** filename に対応する保存済み問題を取得する (無ければ null) */
  get(filename: string): StoredClassProblem | null {
    return readAll()[filename] ?? null;
  },

  /** 任意の保存済み問題を 1 つ返す (照合失敗時のフォールバック) */
  getAny(): StoredClassProblem | null {
    const values = Object.values(readAll());
    return values[0] ?? null;
  },

  /** すべて消す (テスト/明示クリア用。通常の解除は ?reset に委ねる) */
  clear(): void {
    try {
      localStorage.removeItem(classProblemsKey());
    } catch {
      /* noop */
    }
  },
};
