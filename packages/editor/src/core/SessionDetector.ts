/**
 * SessionDetector (ADR-0015) — ランディングから各モードの「進行中セッション」を検出する。
 *
 * ランディングは**どのモードにも入っていない**(エディタ未初期化)ので、`SessionStorageService`
 * (単一 NS 前提で open/migrate する) は使わず、**各モードのセッション IndexedDB をモード別の
 * DB 名で直接・読み取り専用に**開いて tabs を数える。
 *
 * 重要な不変条件: **空の DB を作らない**。`indexedDB.open(name)` を**バージョン指定なし**で開くと
 * 既存 DB は現行バージョンで開き(アップグレードしない)、存在しない DB は `onupgradeneeded` が
 * 発火する → そこで **upgrade トランザクションを abort** して空スキーマの commit を防ぎ「セッション
 * 無し」とみなす。`indexedDB.databases()` は Chromium 専用なので使わない(この方式は全ブラウザで安全)。
 */

import { IndexedDBHelper } from '../services/IndexedDBHelper.js';
import { ALL_EDITOR_MODES, type EditorMode } from './mode.js';

export interface ModeSessionInfo {
  hasSession: boolean;
  /** 最新セッションに属するタブ数。 */
  tabCount: number;
  /** 最新セッションのタブ群の最終更新時刻 (ms epoch)。不明なら null。 */
  lastModifiedAt: number | null;
}

interface SessionRow {
  sessionId: string;
}
interface TabRow {
  sessionId: string;
  lastModifiedAt?: number;
}

/** storageKeys.sessionDbName() のミラー (ランディングは NS 未設定なのでモードから直接導出)。 */
function dbNameFor(mode: EditorMode): string {
  return `typedcode-session${mode === 'casual' ? '' : `-${mode}`}`;
}

/**
 * 既存のセッション DB を**作成せずに**開く。存在しなければ null。
 * バージョン指定なし = 既存 DB をアップグレードしない。`onupgradeneeded` 発火 = 新規 = abort。
 */
function openExisting(dbName: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      // DB が存在しなかった。空スキーマを残さないよう upgrade を中止する。
      try {
        req.transaction?.abort();
      } catch {
        /* noop */
      }
      resolve(null);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 本物のセッション DB はストアを持つ。abort 直後の空 DB は持たない。
      if (!db.objectStoreNames.contains('tabs') || !db.objectStoreNames.contains('sessions')) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
  });
}

async function readModeSession(mode: EditorMode): Promise<ModeSessionInfo | null> {
  const db = await openExisting(dbNameFor(mode));
  if (!db) return null;
  try {
    const latest = await IndexedDBHelper.getLatestByIndex<SessionRow>(db, 'sessions', 'createdAt');
    if (!latest) return null;
    // 最新セッションに属するタブだけを数える (孤児タブの混入で件数/時刻がズレないように)。
    const tabs = await IndexedDBHelper.getAllByIndex<TabRow>(db, 'tabs', 'sessionId', latest.sessionId);
    if (tabs.length === 0) return null;
    const lastModifiedAt = tabs.reduce<number | null>((max, tab) => {
      const v = typeof tab.lastModifiedAt === 'number' ? tab.lastModifiedAt : null;
      return v !== null && (max === null || v > max) ? v : max;
    }, null);
    return { hasSession: true, tabCount: tabs.length, lastModifiedAt };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * ランディング用: 各モードの進行中セッションを検出する。読み取り専用・副作用なし
 * (DB を新規作成しない)。各モードは失敗時 null にフォールバックする。
 */
export async function detectModeSessions(
  modes: readonly EditorMode[] = ALL_EDITOR_MODES
): Promise<Record<EditorMode, ModeSessionInfo | null>> {
  const out: Record<EditorMode, ModeSessionInfo | null> = {
    casual: null,
    class: null,
    assignment: null,
    exam: null,
  };
  await Promise.all(
    modes.map(async (mode) => {
      out[mode] = await readModeSession(mode);
    })
  );
  return out;
}
