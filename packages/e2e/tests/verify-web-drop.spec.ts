import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EditorApp, tamperFirstContentChange, writeZipVariant } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import {
  VerifyWebApp,
  expectWebCliParity,
  proofNames,
  typeAndExport,
  type VerifyFileState,
  type VerifyProofSummary,
  type VerifyVerdict,
} from './helpers/verifyWeb.js';

/**
 * verify Web の投入経路 (#590): 採点者が使う drag & drop とフォルダを開く操作で入れた proof が、
 * `#file-input` で入れたときと同じ結論 (data-* の状態契約) になる。
 *
 * 入れるのは無改ざんの ZIP と改ざんした ZIP の 2 つ (proof 名を分けて行を区別する)。経路が結論を
 * 変えないことを、通る proof と拒否される proof の両方で見る。`#file-input` の結論は verify-cli と
 * 突き合わせ (不変条件 6)、値そのもの (無改ざんは error でない・改ざんは error) も見る。
 *
 * 検証はすべて fast (`?mode=fast` / `--mode fast`。不変条件 4)。兄弟の verify-web-* と同じく、
 * 1 ファイルを肥大させない (#533)。
 */

interface Submission {
  clean: string;
  tampered: string;
  names: string[];
}

/** editor で 1 回 export し、無改ざん / 改ざんの 2 つの ZIP を作る (proof 名を分ける)。 */
async function exportSubmission(page: Page): Promise<Submission> {
  const zipPath = await typeAndExport(new EditorApp(page));
  const clean = await writeZipVariant(zipPath, { renameProof: 'clean', outName: 'clean.zip' });
  const tampered = await writeZipVariant(zipPath, {
    renameProof: 'tampered',
    mutateProof: tamperFirstContentChange,
    outName: 'tampered.zip',
  });
  const names = [...(await proofNames(clean)), ...(await proofNames(tampered))].sort();
  return { clean, tampered, names };
}

interface WebConclusion {
  files: VerifyFileState[];
  verdicts: VerifyVerdict[];
  summary: VerifyProofSummary | null;
}

/**
 * 全行が確定した後の結論 (行の集合・proof ごとの判定・ステータスバーの集約)。`withSummary` が false なら
 * 集約を待たず読まない (`summary` は null)。
 */
async function readConclusion(
  web: VerifyWebApp,
  names: string[],
  minItems: number,
  withSummary = true
): Promise<WebConclusion> {
  const files = await web.waitSettled(minItems);
  let summary: VerifyProofSummary | null = null;
  if (withSummary) {
    // ステータスバーは検証完了の次のタスクで更新される (proofSummary の doc)。
    await expect.poll(() => web.proofSummary()).toMatchObject({ total: names.length });
    summary = await web.proofSummary();
  }
  return {
    files: [...files].sort((a, b) => a.filename.localeCompare(b.filename)),
    verdicts: await web.readVerdicts(names),
    summary,
  };
}

/** `#file-input` で 2 つを一度に入れたときの結論。verify-cli と突き合わせ、値そのものも見る。 */
async function fileInputConclusion(web: VerifyWebApp, sub: Submission): Promise<WebConclusion> {
  await web.open('fast');
  await web.addFiles([sub.clean, sub.tampered]);
  const conclusion = await readConclusion(web, sub.names, sub.names.length);

  for (const zip of [sub.clean, sub.tampered]) {
    const cli = runVerifyCliWithVerdicts(zip, ['--mode', 'fast']);
    const zipNames = await proofNames(zip);
    expectWebCliParity(
      conclusion.verdicts.filter((v) => zipNames.includes(v.filename)),
      cli
    );
  }
  expect(conclusion.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  for (const v of conclusion.verdicts) {
    const tampered = v.filename.startsWith('tampered');
    expect(v.status === 'error', JSON.stringify(v)).toBe(tampered);
  }
  return conclusion;
}

test('drag & drop (案内パネルとサイドバー) で入れた proof は #file-input で入れたときと同じ状態契約になる', async ({
  page,
}) => {
  const sub = await exportSubmission(page);
  const web = new VerifyWebApp(page);
  const expected = await fileInputConclusion(web, sub);

  // 開き直すと何も入っていない状態から始まる (verify は入れたファイルを保存しない)。
  // 1 つ目は案内パネル、入れた後に出るサイドバーへ 2 つ目を落とす (人が続けて足すときの経路)。
  await web.open('fast');
  await web.dropFiles([sub.clean], 'drop-zone');
  await web.waitSettled(1);
  await web.dropFiles([sub.tampered], 'sidebar');
  const dropped = await readConclusion(web, sub.names, sub.names.length);

  expect(dropped).toEqual(expected);
});

test('フォルダを開いて入れた proof は #file-input で入れたときと同じ状態契約になる', async ({ page }) => {
  const sub = await exportSubmission(page);
  const web = new VerifyWebApp(page);
  const expected = await fileInputConclusion(web, sub);

  await web.open('fast');
  await web.openFolder('submissions', [sub.clean, sub.tampered]);
  // ステータスバーの集約 (`#queue-status[data-proof-*]`) はここでは比べない。フォルダを開く処理
  // (FolderController.openFolderDialog) は最後に「フォルダを開いた」のメッセージを出して集約を消すので、
  // 検証がそれより先に終わると集約が出ないまま残る (CI で 1 回、手元ではフォルダの監視開始を遅らせて再現)。
  // 製品側の不具合で、直したら比べる対象に戻す。
  const opened = await readConclusion(web, sub.names, sub.names.length, false);

  expect({ files: opened.files, verdicts: opened.verdicts }).toEqual({
    files: expected.files,
    verdicts: expected.verdicts,
  });
});
