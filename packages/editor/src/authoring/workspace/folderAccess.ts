/**
 * 教材フォルダを開く・前回のフォルダで再開する (#795 / ADR-0051 Decision 9)。
 *
 * - 開く: `showDirectoryPicker({ mode: 'readwrite' })`。ユーザーのキャンセル (`AbortError`) は失敗でなく
 *   `cancelled` で返す。開いたハンドルは `FolderHandleStore` に覚える
 * - 再開: 覚えているハンドルの `queryPermission({ mode: 'readwrite' })` を見る
 *   - `granted` → そのまま開く (先が消えていれば `unavailable`/`missing`)
 *   - `prompt` → **読み書きしない**。`needs-permission` と `grant()` を返し、呼び出し側が「前回のフォルダを開く」
 *     ボタンのクリック (ユーザー操作) の中で `grant()` を呼ぶ。`requestPermission` はユーザー操作の中でしか
 *     出せない (Chrome はそれ以外で呼ぶと拒否する) ので、ここで先に呼ばない
 *   - `denied` → `unavailable`/`denied`
 *   `unavailable` のとき、覚えているハンドルを忘れさせるかは呼び出し側が決める (`store.clear()`)
 *
 * ピッカーや `window` は直接参照せず注入できる形にする (テストで差し替えるため)。権限の API を持たない
 * ハンドル (Chromium 以外の OPFS など) は権限の概念が無いので `granted` とみなす。
 */

import type { FolderHandleStore } from './folderHandleStore.js';
import { MaterialFolder } from './materialFolder.js';

const READWRITE: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };

export type DirectoryPicker = (options: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

/** フォルダを開いた結果。`remembered` は再訪用にハンドルを覚えられたか (覚えられなくても開けてはいる) */
export type OpenFolderResult =
  | { readonly status: 'opened'; readonly folder: MaterialFolder; readonly remembered: boolean }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly cause: unknown };

/** 開けなかった理由。`denied` = 権限が拒否されている、`missing` = フォルダが消えた、`error` = それ以外の失敗 */
export type FolderUnavailableReason = 'denied' | 'missing' | 'error';

export type GrantResult =
  | { readonly status: 'opened'; readonly folder: MaterialFolder }
  | {
      readonly status: 'unavailable';
      readonly name: string;
      readonly reason: FolderUnavailableReason;
      readonly cause?: unknown;
    };

export type ResumeResult =
  | { readonly status: 'none' }
  | { readonly status: 'opened'; readonly folder: MaterialFolder }
  | {
      readonly status: 'needs-permission';
      /** 前回のフォルダ名 (ボタンの表示用) */
      readonly name: string;
      /** ユーザー操作 (クリック) の中で呼ぶ。ここで初めて `requestPermission` する */
      readonly grant: () => Promise<GrantResult>;
    }
  | {
      readonly status: 'unavailable';
      readonly name: string;
      readonly reason: FolderUnavailableReason;
      readonly cause?: unknown;
    };

export interface PickFolderDeps {
  /** 既定は `window.showDirectoryPicker` (無ければ `unsupported`) */
  readonly showDirectoryPicker?: DirectoryPicker;
  readonly store: FolderHandleStore;
}

function errorName(error: unknown): unknown {
  return (error as { name?: unknown } | null)?.name;
}

function defaultPicker(): DirectoryPicker | undefined {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return undefined;
  return (options) => (window.showDirectoryPicker as DirectoryPicker)(options);
}

/** ハンドルをフォルダとして開き、再訪用に覚える (ピッカーを経ない入口。dev フックが OPFS のハンドルを渡す) */
export async function openMaterialFolderHandle(
  handle: FileSystemDirectoryHandle,
  store: FolderHandleStore
): Promise<OpenFolderResult> {
  let remembered = true;
  try {
    await store.save(handle);
  } catch {
    remembered = false;
  }
  return { status: 'opened', folder: new MaterialFolder(handle), remembered };
}

/** ピッカーで教材フォルダを選ばせて開く (ユーザー操作の中で呼ぶ) */
export async function pickMaterialFolder(deps: PickFolderDeps): Promise<OpenFolderResult> {
  const picker = deps.showDirectoryPicker ?? defaultPicker();
  if (!picker) return { status: 'unsupported' };
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ mode: 'readwrite' });
  } catch (cause) {
    if (errorName(cause) === 'AbortError') return { status: 'cancelled' };
    return { status: 'failed', cause };
  }
  return openMaterialFolderHandle(handle, deps.store);
}

/** 権限がある前提で、フォルダが今も在るかを 1 件読んで確かめて開く */
async function openIfPresent(handle: FileSystemDirectoryHandle): Promise<GrantResult> {
  try {
    await handle.values().next();
  } catch (cause) {
    const name = errorName(cause);
    if (name === 'NotFoundError') return { status: 'unavailable', name: handle.name, reason: 'missing', cause };
    if (name === 'NotAllowedError') return { status: 'unavailable', name: handle.name, reason: 'denied', cause };
    return { status: 'unavailable', name: handle.name, reason: 'error', cause };
  }
  return { status: 'opened', folder: new MaterialFolder(handle) };
}

/** 前回のフォルダで再開する。`prompt` のときは読み書きせず、`grant()` を返す */
export async function resumeMaterialFolder(store: FolderHandleStore): Promise<ResumeResult> {
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await store.load();
  } catch {
    // 覚えている場所が読めなければ、覚えていないのと同じに扱う (開き直せばよい)
    return { status: 'none' };
  }
  if (!handle) return { status: 'none' };
  const saved = handle;

  let permission: PermissionState;
  try {
    permission = saved.queryPermission ? await saved.queryPermission(READWRITE) : 'granted';
  } catch (cause) {
    return { status: 'unavailable', name: saved.name, reason: 'error', cause };
  }

  if (permission === 'granted') return openIfPresent(saved);
  if (permission === 'denied') return { status: 'unavailable', name: saved.name, reason: 'denied' };

  return {
    status: 'needs-permission',
    name: saved.name,
    grant: async () => {
      let granted: PermissionState;
      try {
        granted = saved.requestPermission ? await saved.requestPermission(READWRITE) : 'granted';
      } catch (cause) {
        return { status: 'unavailable', name: saved.name, reason: 'error', cause };
      }
      if (granted !== 'granted') return { status: 'unavailable', name: saved.name, reason: 'denied' };
      return openIfPresent(saved);
    },
  };
}
