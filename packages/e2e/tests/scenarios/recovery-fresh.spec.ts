import { test, expect, type BrowserContext } from '@playwright/test';
import {
  EditorApp,
  type ProofCheckpoint,
  listProofEntries,
  readAllProofEvents,
  readProofEvents,
  readZipEntryText,
} from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { closedTabRows, openClosedTabs, reopenClosedTab } from '../helpers/closedTabs.js';
import { waitDialogClosed, waitDialogOpen } from '../helpers/scenario.js';

/**
 * #434-4 / #317: ブラウザタブを閉じた後の再訪で、復旧ダイアログ (`data-dialog="session-recovery"`) から
 * 「新規開始」を選ぶ。2 段目 (`data-step="fresh"`) で「前のファイルを残す」(既定) か「完全に削除する」を選ぶ。
 * どちらでも前のタブは開いたタブとして引き継がれず、新しいセッションの proof は verify-cli (fast) で pass する。
 * 「残す」なら前のタブはメインメニューの「閉じたタブ」から開き直せ、打鍵を続けた export も pass する。
 * 「再開」側は close-tab-recovery.spec.ts が持つ。
 */

/** 前のセッションで打鍵し、export してから (署名付き checkpoint を作る) ブラウザタブを閉じる */
async function leavePreviousSession(
  page: EditorApp['page']
): Promise<{ id: string; content: string; totalEvents: number }> {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  // 新しいセッションの既定タブ (Untitled-1) と export の名前を分ける (同名だと proof のエントリ名が `_proof_1.json` になる)
  await app.renameTab((await app.tabs())[0]!.id, 'old');
  await app.typeCode('int old = 1;\n');
  await app.waitForSynced();
  // export は最後の checkpoint を作って署名を待つ。前のセッションの sessionId の署名 cp を proof に残す
  await app.exportAllTabs();
  await app.waitForSynced();
  const tab = (await app.snapshot()).tabs[0]!;
  await page.close();
  return { id: tab.id, content: tab.content, totalEvents: tab.totalEvents };
}

/** 再訪して復旧ダイアログの「新規」→ 2 段目の `choice` を選ぶ */
async function revisitAndStartFresh(
  context: BrowserContext,
  choice: 'fresh-keep' | 'fresh-delete'
): Promise<EditorApp> {
  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  await waitDialogOpen(app2, 'session-recovery');
  expect(await app2.appState()).toBe('initializing');
  const dialog = page2.locator('[data-dialog="session-recovery"]');
  await expect(dialog).toHaveAttribute('data-step', 'choose');
  await dialog.locator('[data-action="fresh"]').click();
  // 新規の後は、残すか消すかの選択に移る (まだ閉じない)
  await expect(dialog).toHaveAttribute('data-step', 'fresh');
  await expect(dialog.locator('[data-action="fresh-keep"]')).toBeFocused();
  await expect(dialog.locator('[data-action="fresh-delete"]')).toBeVisible();
  await dialog.locator(`[data-action="${choice}"]`).click();
  await waitDialogClosed(app2, 'session-recovery');
  await app2.waitReady();
  await app2.expectConsistent();
  return app2;
}

/** 新しいセッションのタブに前のタブが入っていない (id も中身も) */
async function expectFreshTabs(app: EditorApp, oldId: string): Promise<void> {
  const snap = await app.snapshot();
  expect(snap.tabs.length).toBeGreaterThan(0);
  for (const tab of snap.tabs) {
    expect(tab.id, 'no tab of the previous session is open').not.toBe(oldId);
    expect(tab.content).toBe('');
  }
}

test('復旧ダイアログで新規 → 完全に削除するを選ぶと、前のタブは開かず閉じたタブにも残らず、新しいセッションの verify が pass する', async ({
  page,
  context,
}) => {
  const old = await leavePreviousSession(page);
  const app2 = await revisitAndStartFresh(context, 'fresh-delete');
  await expectFreshTabs(app2, old.id);

  await openClosedTabs(app2);
  expect(await closedTabRows(app2)).toEqual([]);
  await expect(app2.page.locator('[data-dialog="closed-tabs"]')).toHaveAttribute('data-count', '0');
  await app2.page.locator('[data-dialog="closed-tabs"] .modal-footer [data-action="close"]').click();
  await waitDialogClosed(app2, 'closed-tabs');

  await app2.typeCode('int fresh = 2;\n');
  await app2.waitForSynced();
  const zipPath = await app2.exportAllTabs();
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(false);
  expect(JSON.stringify(events)).not.toContain('old = 1');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app2.expectConsistent();
});

test('復旧ダイアログで新規 → 前のファイルを残すを選ぶと、前のタブは閉じたタブとして残り、開き直して打鍵した export が verify で pass する', async ({
  page,
  context,
}) => {
  const old = await leavePreviousSession(page);
  const app2 = await revisitAndStartFresh(context, 'fresh-keep');
  await expectFreshTabs(app2, old.id);

  await openClosedTabs(app2);
  const rows = await closedTabRows(app2);
  expect(rows.map(({ id, eventCount }) => ({ id, eventCount }))).toEqual([{ id: old.id, eventCount: old.totalEvents }]);
  await reopenClosedTab(app2, old.id);
  const reopened = (await app2.snapshot()).tabs.find((t) => t.id === old.id)!;
  expect({ content: reopened.content, totalEvents: reopened.totalEvents }).toEqual({
    content: old.content,
    totalEvents: old.totalEvents,
  });
  await app2.expectConsistent();

  await app2.typeCode('int more = 3;');
  await app2.waitForSynced();
  const zipPath = await app2.exportAllTabs();
  const proofs = await readAllProofEvents(zipPath);
  expect(proofs.size).toBe(2);

  // 開き直したタブ (events が最も多い proof) の署名 cp は、前のセッションの export で付いたものと開き直した後の
  // export で付いたものが同じ sessionId で続く (混ざると verifier が拒否する)
  const signed = new Map<string, { events: number; sessionIds: string[] }>();
  for (const entry of await listProofEntries(zipPath)) {
    const proof = JSON.parse(await readZipEntryText(zipPath, entry)) as { checkpoints?: ProofCheckpoint[] };
    const sessionIds = (proof.checkpoints ?? []).flatMap((cp) => {
      const id = (cp.signature as { payload?: { sessionId?: string } } | undefined)?.payload?.sessionId;
      return id ? [id] : [];
    });
    expect(new Set(sessionIds).size, `${entry}: signed checkpoints share one sessionId`).toBeLessThanOrEqual(1);
    signed.set(entry, { events: proofs.get(entry)?.length ?? 0, sessionIds });
  }
  const reopenedProof = [...signed.values()].sort((x, y) => y.events - x.events)[0]!;
  expect(reopenedProof.events).toBeGreaterThan(old.totalEvents);
  expect(reopenedProof.sessionIds.length, 'signed before closing and after reopening').toBeGreaterThanOrEqual(2);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app2.expectConsistent();
});
