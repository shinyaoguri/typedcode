/**
 * ExamPackageStore - 試験モード (ADR-0006) の問題パッケージ表示用ストア
 *
 * 復号済みの問題本文 (plaintext) と manifest を problemId キーで localStorage に sticky 保存する。
 * **用途は「リロード時の問題再表示」のみ**。チェーン束縛そのもの (examContext) は proof 状態側に
 * 持つ (root の nonce/root と不可分のため再構築不可・本ストアからは復元しない)。
 *
 * T0 後は問題は公開値なので localStorage 保存で機密性の損失はない。解除は `?reset`
 * (localStorage.clear) に一本化されている (ADR-0010)。
 */

import type { ExamPackageManifest } from '@typedcode/shared';
import { examPackagesKey } from '../core/storageKeys.js';

// 封印問題キャッシュの localStorage キーは storageKeys.examPackagesKey() (モード別。ADR-0011 PR3)。

export interface StoredExamPackage {
  manifest: ExamPackageManifest;
  /** 復号後の問題本文 (平文) */
  plaintext: string;
}

type PackageMap = Record<string, StoredExamPackage>;

function readAll(): PackageMap {
  try {
    const raw = localStorage.getItem(examPackagesKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as PackageMap;
  } catch {
    /* 壊れていれば空として扱う */
  }
  return {};
}

function writeAll(map: PackageMap): void {
  try {
    localStorage.setItem(examPackagesKey(), JSON.stringify(map));
  } catch {
    /* 保存不可環境では諦める (表示用キャッシュなので致命ではない) */
  }
}

export const ExamPackageStore = {
  /** problemId キーで manifest + 平文を保存する */
  save(problemId: string, pkg: StoredExamPackage): void {
    const map = readAll();
    map[problemId] = pkg;
    writeAll(map);
  },

  /** problemId に対応する保存済みパッケージを取得する (無ければ null) */
  get(problemId: string): StoredExamPackage | null {
    return readAll()[problemId] ?? null;
  },

  /** 任意の保存済みパッケージを 1 つ返す (v1 単一問題の復元用フォールバック) */
  getAny(): StoredExamPackage | null {
    const values = Object.values(readAll());
    return values[0] ?? null;
  },

  /** すべて消す (テスト/明示クリア用。通常の解除は ?reset の localStorage.clear に委ねる) */
  clear(): void {
    try {
      localStorage.removeItem(examPackagesKey());
    } catch {
      /* noop */
    }
  },
};
