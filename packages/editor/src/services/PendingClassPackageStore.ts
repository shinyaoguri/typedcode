/**
 * PendingClassPackageStore - 作業スペースへ移るときに、読み込んだ `.tcclass` を移り先へ渡すストア (#646)
 *
 * `.tcclass` を読み込むと、その配布物の作業スペース (`/w/class/<classId>/<方針>`) へページごと移る。読み込んだ
 * 配布物は、移る前に**移り先の名前空間**の sessionStorage (`pendingClassPackageKey`) に書き、移り先の起動が
 * `take()` で読んで消してから問題のタブを開く。sessionStorage はブラウザのタブごとで、同じタブの遷移では残り、
 * 別のタブには渡らない (別のタブで同じ作業スペースを開いても、問題のタブが二重にできない)。
 *
 * 読み出しは shared の `parseClassPackage` を通す (壊れた値は捨てて、何も開かない)。
 */

import { parseClassPackage, type ClassPackage } from '@typedcode/shared';
import { pendingClassPackageKey } from '../core/storageKeys.js';

export const PendingClassPackageStore = {
  /** 移り先の名前空間 `namespace` に配布物を置く。書けなければ false (呼び出し側は移らない) */
  put(namespace: string, pkg: ClassPackage): boolean {
    try {
      sessionStorage.setItem(pendingClassPackageKey(namespace), JSON.stringify(pkg));
      return true;
    } catch {
      return false;
    }
  },

  /** 今の名前空間に置かれた配布物を取り出して消す。無い・読めないときは null (読めない値も消す) */
  take(): ClassPackage | null {
    try {
      const key = pendingClassPackageKey();
      const raw = sessionStorage.getItem(key);
      if (raw === null) return null;
      sessionStorage.removeItem(key);
      return parseClassPackage(JSON.parse(raw));
    } catch {
      return null;
    }
  },
};
