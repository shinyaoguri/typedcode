import { test, expect, type Page } from '@playwright/test';
import { BOOT_TIMEOUT_MS } from './helpers/app.js';

/**
 * `/author` の教材フォルダの読み書きと再開 (#795 / ADR-0051 Decision 9)。
 *
 * ネイティブのフォルダのピッカーは Playwright で操作できないので、OPFS (`navigator.storage.getDirectory()`)
 * のディレクトリハンドルを dev 限定フック `window.__tcTestAuthorWorkspace` で教材フォルダとして渡す
 * (packages/editor/src/authoring/workspace/devWorkspaceHook.ts)。本物の File System Access API の書き込みと
 * IndexedDB へのハンドルの保存を通し、ページを読み直した後に前回のフォルダで再開して同じ内容を読めることを確かめる。
 *
 * OPFS のハンドルは権限が常に granted なので、権限が prompt のときの経路 (ボタンのクリックで requestPermission)
 * はユニットテスト (folderAccess.test.ts) が担う。dev フックを使うので dev サーバ向けの設定でだけ走る
 * (playwright.build.config.ts は production-build.spec だけを選ぶ)。
 */

/** OPFS の中に置くテスト用の教材フォルダ名 (テストごとに作り直す) */
const FOLDER = 'e2e-material-795';
const PATH = '過去問/探索.problem.yaml';
const CONTENT = 'format: tc-problem/1\nid: 探索\nstatement: 探索.md\n';

interface HookWindow {
  __tcTestAuthorWorkspace?: {
    open(handle: FileSystemDirectoryHandle): Promise<string>;
    resume(): Promise<{ status: string; name?: string; reason?: string }>;
    list(): Promise<string[]>;
    read(path: string): Promise<string>;
    write(path: string, text: string, overwrite?: boolean): Promise<{ status: string; reason?: string }>;
  };
}

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as HookWindow).__tcTestAuthorWorkspace !== undefined, null, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

test('/author: OPFS のフォルダに保存し、読み直した後に前回のフォルダで再開して同じ内容を読める', async ({ page }) => {
  await page.goto('/author');
  await waitForHook(page);

  const saved = await page.evaluate(
    async ({ folder, path, content }) => {
      const hook = (window as unknown as HookWindow).__tcTestAuthorWorkspace;
      if (!hook) throw new Error('hook missing');
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const dir = await root.getDirectoryHandle(folder, { create: true });
      const name = await hook.open(dir);
      const result = await hook.write(path, content);
      return { name, status: result.status };
    },
    { folder: FOLDER, path: PATH, content: CONTENT }
  );
  expect(saved).toEqual({ name: FOLDER, status: 'saved' });

  await page.reload();
  await waitForHook(page);

  const resumed = await page.evaluate(async (path) => {
    const hook = (window as unknown as HookWindow).__tcTestAuthorWorkspace;
    if (!hook) throw new Error('hook missing');
    const result = await hook.resume();
    if (result.status !== 'opened') return { result, files: [], text: null };
    return { result, files: await hook.list(), text: await hook.read(path) };
  }, PATH);
  expect(resumed).toEqual({ result: { status: 'opened', name: FOLDER }, files: [PATH], text: CONTENT });
});
