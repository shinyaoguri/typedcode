/**
 * ClassPolicyStore - 授業/課題で読み込んだ `.tcclass` の方針 (#645) を覚えておくストア
 *
 * 方針は問題を読み込んだ時点で能力に重ねるが、リロード後の起動 (画面共有の選択・フルスクリーン記録・
 * export 前認証の扱い) も同じ能力で始めるために、モード別の localStorage (`classPolicyKey`) に保存する。
 * 問題本文の `ClassProblemStore` と同じく、解除は設定メニューのリセット (現在のモードの分だけ消える。#323) か、
 * 方針の無い問題を読み込んだとき (`save(null)`)。
 *
 * 読み出しは shared の `parseClassPolicy` を通す (壊れた値・部分的な値は「方針なし」= 入口の能力に戻す)。
 */

import { parseClassPolicy, type ClassPolicy } from '@typedcode/shared';
import { classPolicyKey } from '../core/storageKeys.js';

export const ClassPolicyStore = {
  /** 保存してある方針。無い・読めないときは null (入口の能力のまま) */
  get(): ClassPolicy | null {
    try {
      const raw = localStorage.getItem(classPolicyKey());
      return raw ? parseClassPolicy(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },

  /** 読み込んだ問題の方針を保存する。方針の無い問題 (null) なら消して入口の能力に戻す */
  save(policy: ClassPolicy | null): void {
    try {
      if (policy) localStorage.setItem(classPolicyKey(), JSON.stringify(policy));
      else localStorage.removeItem(classPolicyKey());
    } catch {
      /* 保存できない環境では、リロード後に入口の能力へ戻るだけ */
    }
  },
};
