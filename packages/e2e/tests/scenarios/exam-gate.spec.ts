import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { waitDialogOpen } from '../helpers/scenario.js';

/**
 * #223: 試験ゲート (`exam-gate`) が問題パッケージ (.tcexam) の取込を拒否するとき、理由を出し分ける。
 * 新しい形式のパッケージを「不正」と読ませると、受験者はファイルを選び直し続けてしまう。
 * 判定は `#exam-gate-error[data-reason]` と開始ボタンの状態だけを読む (翻訳テキストは見ない)。
 * 正規に署名・復号できるパッケージの解錠そのものは別の仕事 (#229)。ここは取込の入口だけ。
 */

function tcexam(content: unknown): { name: string; mimeType: string; buffer: Buffer } {
  return { name: 'problem.tcexam', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)) };
}

test('試験ゲートは取込を拒否した理由を、新しい形式・古い形式・不正な形式で出し分ける (#223)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'exam-gate');

  const error = page.locator('#exam-gate-error');
  const fileInput = page.locator('#exam-gate-file');
  // 監督コードを入れても、取込を拒否されたパッケージでは開始できない (manifest が無い)。
  await page.locator('#exam-gate-code').fill('ABCD1234');

  await fileInput.setInputFiles(tcexam({ formatVersion: 2 }));
  await expect(error).toHaveAttribute('data-reason', 'newer-format');
  await expect(page.locator('#exam-gate-start')).toBeDisabled();

  await fileInput.setInputFiles(tcexam({ formatVersion: 0 }));
  await expect(error).toHaveAttribute('data-reason', 'unsupported-format');
  await expect(page.locator('#exam-gate-start')).toBeDisabled();

  // formatVersion が読めても必須フィールドが無ければ「不正」(新旧の話ではない)。
  await fileInput.setInputFiles(tcexam({ formatVersion: 1 }));
  await expect(error).toHaveAttribute('data-reason', 'invalid-file');
  await expect(page.locator('#exam-gate-start')).toBeDisabled();
});
